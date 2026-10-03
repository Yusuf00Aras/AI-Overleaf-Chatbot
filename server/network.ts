import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import { allowedRequest, tokenEquals } from './policy.js';

export class ConnectionLimit {
  active = 0;
  constructor(readonly max: number) {}
  get full() { return this.active >= this.max; }
  acquire(onRelease: (listener: () => void) => void) {
    this.active++;
    onRelease(() => { this.active--; });
  }
}

export interface UpgradeOptions {
  enabled: boolean;
  token: string;
  ports: readonly number[];
  limit: ConnectionLimit;
  onConnection(ws: WebSocket): void;
}

/** Authenticates the MCP WebSocket upgrade. Every malformed or unauthorized request is answered, never thrown. */
export function mcpUpgradeHandler(wss: WebSocketServer, options: UpgradeOptions) {
  return (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const reject = (status: string) => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    try {
      let upgradePath: string;
      try { upgradePath = new URL(req.url ?? '/', 'http://localhost').pathname; }
      catch { return reject('400 Bad Request'); }
      if (!options.enabled || upgradePath !== '/mcp') return reject('404 Not Found');
      if (!allowedRequest(req.headers.host, req.headers.origin, options.ports)) return reject('403 Forbidden');
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (!tokenEquals(bearer, options.token)) return reject('401 Unauthorized');
      if (options.limit.full) return reject('503 Service Unavailable');
      wss.handleUpgrade(req, socket, head, ws => options.onConnection(ws));
    } catch { reject('400 Bad Request'); }
  };
}
