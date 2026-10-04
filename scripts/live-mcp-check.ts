import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { connect as netConnect, createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocket, WebSocketServer } from 'ws';
import { attachGateway } from '../server/gateway.js';
import { ConnectionLimit, mcpUpgradeHandler } from '../server/network.js';
import type { BrowserOverleaf } from '../server/overleaf.js';
import { MAX_FRAME, SocketTransport } from '../server/transports.js';
import { stepper } from './live-common.js';

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
const text = (result: unknown) => (result as ToolResult).content[0]?.text ?? '';
const parse = (result: unknown) => JSON.parse(text(result));

/** Live MCP check: real TCP and WebSocket gateways on loopback with the logged-in adapter, read-only; stdio as a subprocess. */
export async function run(adapter: BrowserOverleaf, baseUrl: string) {
  const { step, summary } = stepper(500);
  const token = randomBytes(24).toString('hex');
  const options = { allowWrites: false };
  const tcp = createTcpServer(socket => { attachGateway(new SocketTransport(socket, { tcpToken: token, authTimeoutMs: 2000 }), adapter, options).catch(() => socket.destroy()); });
  tcp.listen(0, '127.0.0.1'); await once(tcp, 'listening');
  const http = createHttpServer((_req, res) => { res.statusCode = 404; res.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const httpPort = (http.address() as AddressInfo).port;
  http.on('upgrade', mcpUpgradeHandler(wss, { enabled: true, token, ports: [httpPort], limit: new ConnectionLimit(4),
    onConnection: ws => { attachGateway(new SocketTransport(ws), adapter, options).catch(() => ws.close()); } }));
  const clients: Client[] = [];

  const openTcp = async (auth: string) => {
    const socket = netConnect((tcp.address() as AddressInfo).port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(`${JSON.stringify({ auth })}\n`);
    return socket;
  };
  const openWs = (auth: string) => new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${httpPort}/mcp`, { headers: { Authorization: `Bearer ${auth}` } });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); });
    ws.once('error', reject);
  });
  const exercise = async (label: string, transport: SocketTransport) => {
    const client = new Client({ name: `live-${label}`, version: '1' });
    clients.push(client);
    await step(`${label}: initialize + listTools`, async () => {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map(tool => tool.name);
      if (names.includes('write_file')) throw new Error('Write tool offered despite read-only mode');
      return `${names.length} tools, write_file hidden`;
    }, m => m);
    await step(`${label}: connect_overleaf`, async () => { const r = await client.callTool({ name: 'connect_overleaf', arguments: { baseUrl } }); if (r.isError) throw new Error(text(r)); return text(r).slice(0, 60); }, m => m);
    await step(`${label}: auth_status`, async () => parse(await client.callTool({ name: 'auth_status', arguments: {} })), r => `authenticated=${r.authenticated}`);
    const list = await step(`${label}: list_projects`, async () => parse(await client.callTool({ name: 'list_projects', arguments: {} })), r => `${r.projects.length} projects`);
    const projectId = list?.projects[0]?.projectId;
    if (!projectId) return;
    const tree = await step(`${label}: get_project_tree`, async () => parse(await client.callTool({ name: 'get_project_tree', arguments: { projectId } })), r => `${r.entities.length} entries`);
    const filePath = tree?.rootDocPath;
    if (!filePath) return;
    await step(`${label}: read_file`, async () => parse(await client.callTool({ name: 'read_file', arguments: { projectId, filePath } })), r => `${r.content.length} chars, ${r.protocol}`);
    await step(`${label}: download_file without bytes`, async () => {
      const raw = text(await client.callTool({ name: 'download_file', arguments: { projectId, filePath } }));
      const result = JSON.parse(raw);
      if (raw.includes('dataBase64') || result.download?.availableToUser !== false) throw new Error('Binary data delivered over MCP');
      return `${result.download.bytes} bytes as metadata only`;
    }, m => m);
    await step(`${label}: write_file rejected`, async () => {
      const r = await client.callTool({ name: 'write_file', arguments: { projectId, filePath, content: 'x', revision: 'x' } }) as ToolResult;
      if (!r.isError) throw new Error('Write accepted in read-only mode');
      return text(r).slice(0, 60);
    }, m => m);
  };

  try {
    await step('TCP: wrong token disconnected', async () => {
      const socket = await openTcp('wrong'.repeat(8));
      await once(socket as Socket, 'close');
      return 'connection closed';
    }, m => m);
    await exercise('TCP', new SocketTransport(await openTcp(token)));
    await step('WS: wrong token rejected', async () => {
      try { await openWs('wrong'.repeat(8)); } catch (error) { return (error as Error).message; }
      throw new Error('Upgrade accepted without a valid token');
    }, m => m);
    await exercise('WS', new SocketTransport(await openWs(token)));

    // stdio runs as a separate process with its own browser; only the protocol handshake is checked, no login there.
    const stdio = new Client({ name: 'live-stdio', version: '1' });
    await step('stdio: process, initialize + listTools', async () => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith('OVERLEAF_ALLOW_'))) as Record<string, string>;
      await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('node_modules/tsx/dist/cli.mjs'), 'server/mcp.ts'], env, stderr: 'ignore' }));
      const names = (await stdio.listTools()).tools.map(tool => tool.name);
      const early = await stdio.callTool({ name: 'read_file', arguments: { projectId: 'a'.repeat(24), filePath: 'main.tex' } }) as ToolResult;
      return `${names.length} tools, write_file hidden=${!names.includes('write_file')}, rejected without connect=${early.isError === true}`;
    }, m => m);
    await stdio.close().catch(() => undefined);
  } finally {
    for (const client of clients) await client.close().catch(() => undefined);
    for (const ws of wss.clients) ws.terminate();
    tcp.close(); http.close(); http.closeAllConnections();
  }
  console.log(summary());
}
