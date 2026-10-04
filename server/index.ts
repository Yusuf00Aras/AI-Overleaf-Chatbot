import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createApp } from './app.js';
import { attachGateway, operatorOptions } from './gateway.js';
import { ConnectionLimit, mcpUpgradeHandler } from './network.js';
import { BrowserOverleaf } from './overleaf.js';
import { MAX_FRAME, SocketTransport } from './transports.js';

const PORT = Number(process.env.PORT ?? 3001);
const TCP_PORT = Number(process.env.MCP_TCP_PORT ?? 3002);
const VITE_PORT = 5173;
const MAX_GATEWAY_CONNECTIONS = 4;
const HOST = '127.0.0.1';

// The chat UI and the MCP gateway share one browser session and one serial operation queue.
const adapter = new BrowserOverleaf();
const app = createApp({ adapter, ports: [PORT, VITE_PORT], staticDir: path.resolve('dist') });
const http = createHttpServer(app);

const network = process.env.MCP_NETWORK === '1';
const gatewayToken = process.env.MCP_GATEWAY_TOKEN ?? '';
if (network && gatewayToken.length < 32) {
  console.error('MCP_NETWORK=1 requires MCP_GATEWAY_TOKEN with at least 32 characters.');
  process.exit(1);
}
const gatewayOptions = operatorOptions(process.env);
const limit = new ConnectionLimit(MAX_GATEWAY_CONNECTIONS);

function startGateway(transport: SocketTransport, onClose: (listener: () => void) => void): void {
  limit.acquire(onClose);
  attachGateway(transport, adapter, gatewayOptions).catch(() => { void transport.close(); });
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
http.on('upgrade', mcpUpgradeHandler(wss, { enabled: network, token: gatewayToken, ports: [PORT], limit,
  onConnection: ws => startGateway(new SocketTransport(ws), listener => ws.once('close', listener)) }));

let tcp: TcpServer | undefined;
if (network) {
  tcp = createTcpServer(socket => {
    if (limit.full) { socket.destroy(); return; }
    startGateway(new SocketTransport(socket, { tcpToken: gatewayToken }), listener => socket.once('close', listener));
  });
  tcp.listen(TCP_PORT, HOST, () => console.log(`MCP TCP gateway: tcp://${HOST}:${TCP_PORT} (NDJSON, first line {"auth":"<token>"})`));
}

http.listen(PORT, HOST, () => {
  console.log(`Overleaf Chat Studio: http://${HOST}:${PORT}`);
  if (network) console.log(`MCP WebSocket gateway: ws://${HOST}:${PORT}/mcp (Authorization: Bearer <token>)`);
  console.log(`MCP write access: ${gatewayOptions.allowWrites ? 'enabled (OVERLEAF_ALLOW_WRITES=1)' : 'read-only'}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  wss.clients.forEach(client => client.terminate());
  tcp?.close();
  http.close();
  http.closeAllConnections();
  void adapter.close().finally(() => process.exit(0));
});
