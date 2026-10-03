import type { Socket } from 'node:net';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { WebSocket } from 'ws';
import { tokenEquals } from './policy.js';

export const MAX_FRAME = 1_048_576;
export class LineDecoder {
  private pending = Buffer.alloc(0);
  get bufferedBytes(): number { return this.pending.length; }
  push(chunk: Buffer): string[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const lines: string[] = [];
    let end: number;
    while ((end = this.pending.indexOf(10)) !== -1) {
      if (end > MAX_FRAME) throw new Error('Nachricht zu groß.');
      const line = this.pending.subarray(0, end).toString('utf8').replace(/\r$/, '');
      this.pending = this.pending.subarray(end + 1);
      if (line) lines.push(line);
    }
    if (this.pending.length > MAX_FRAME) throw new Error('Nachricht zu groß.');
    return lines;
  }
}

/**
 * MCP over WebSocket (one JSON-RPC message per text frame) or TCP (NDJSON).
 * With `tcpToken`, the first TCP line must be {"auth":"<token>"}; anything else closes the connection.
 * WebSocket clients authenticate during the HTTP upgrade instead.
 */
export class SocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private decoder = new LineDecoder();
  private authenticated: boolean;
  constructor(private socket: Socket | WebSocket, private options: { tcpToken?: string; authTimeoutMs?: number } = {}) {
    this.authenticated = socket instanceof WebSocket || options.tcpToken === undefined;
  }
  async start(): Promise<void> {
    this.socket.on('close', () => this.onclose?.());
    this.socket.on('error', () => this.onerror?.(new Error('Transportverbindung fehlgeschlagen.')));
    const socket = this.socket;
    if (socket instanceof WebSocket) {
      socket.on('message', (data, binary) => {
        if (binary) { socket.close(); return; }
        this.receive(data.toString());
      });
    } else {
      if (!this.authenticated) {
        const timer = setTimeout(() => { if (!this.authenticated) socket.destroy(); }, this.options.authTimeoutMs ?? 10_000);
        socket.once('close', () => clearTimeout(timer));
      }
      socket.on('data', chunk => {
        try {
          for (const line of this.decoder.push(chunk)) {
            if (socket.destroyed) return;
            if (this.authenticated) { this.receive(line); continue; }
            let auth: unknown;
            try { auth = (JSON.parse(line) as { auth?: unknown }).auth; } catch { /* rejected below */ }
            if (!tokenEquals(auth, this.options.tcpToken!)) { socket.destroy(); return; }
            this.authenticated = true;
          }
        } catch { void this.close(); }
      });
    }
  }
  private receive(text: string): void {
    let message: JSONRPCMessage;
    try {
      if (Buffer.byteLength(text) > MAX_FRAME) throw new Error('Nachricht zu groß.');
      message = JSONRPCMessageSchema.parse(JSON.parse(text));
    } catch { this.onerror?.(new Error('Ungültige JSON-RPC-Nachricht.')); void this.close(); return; }
    this.onmessage?.(message);
  }
  async send(message: JSONRPCMessage): Promise<void> {
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) > MAX_FRAME) throw new Error('Ausgehende Nachricht zu groß.');
    const socket = this.socket;
    await new Promise<void>((resolve, reject) => {
      if (socket instanceof WebSocket) socket.send(text, error => error ? reject(error) : resolve());
      else socket.write(text + '\n', error => error ? reject(error) : resolve());
    });
  }
  async close(): Promise<void> {
    if (this.socket instanceof WebSocket) this.socket.close();
    else this.socket.destroy();
  }
}