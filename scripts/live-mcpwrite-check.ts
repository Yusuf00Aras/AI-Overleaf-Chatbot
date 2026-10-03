import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { connect as netConnect, createServer as createTcpServer, type AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { attachGateway } from '../server/gateway.js';
import type { BrowserOverleaf } from '../server/overleaf.js';
import { ToolSession } from '../server/tools.js';
import { SocketTransport } from '../server/transports.js';
import { stepper } from './live-common.js';

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
const text = (result: unknown) => (result as ToolResult).content[0]?.text ?? '';
const parse = (result: unknown) => JSON.parse(text(result));

/** MCP write mode (allowWrites=true) over a real TCP gateway, only inside a disposable project that is deleted afterwards. */
export async function run(adapter: BrowserOverleaf, baseUrl: string) {
  const { step, summary } = stepper(1500);
  const name = `Studio-Livetest MCPWrite ${Date.now().toString(36)}`;
  const created = await step('create_project (Wegwerf)', () => new ToolSession(adapter, { baseUrl }, false, true).call('create_project', { name }) as Promise<any>, r => r.projectId);
  if (!created) { console.log(summary()); return; }
  const projectId: string = created.projectId;
  const token = randomBytes(24).toString('hex');
  const tcp = createTcpServer(socket => { attachGateway(new SocketTransport(socket, { tcpToken: token, authTimeoutMs: 2000 }), adapter, { allowWrites: true }).catch(() => socket.destroy()); });
  tcp.listen(0, '127.0.0.1'); await once(tcp, 'listening');
  const client = new Client({ name: 'live-mcpwrite', version: '1' });
  const call = async (tool: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name: tool, arguments: args }) as ToolResult;
    if (result.isError) throw new Error(text(result).slice(0, 120));
    return parse(result);
  };
  try {
    const socket = netConnect((tcp.address() as AddressInfo).port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(`${JSON.stringify({ auth: token })}\n`);
    await client.connect(new SocketTransport(socket));
    await step('connect_overleaf (Projekt)', () => call('connect_overleaf', { baseUrl, projectId }), () => 'verbunden');
    // Mutation tools are only listed once a project is selected.
    await step('listTools: write_file angeboten', async () => { const names = (await client.listTools()).tools.map(t => t.name); if (!names.includes('write_file')) throw new Error('write_file fehlt trotz allowWrites'); if (names.includes('manage_project')) throw new Error('manage_project ohne Freigabe angeboten'); return `${names.length} Werkzeuge`; }, m => m);
    const read = await step('read_file', () => call('read_file', { projectId, filePath: 'main.tex' }), r => `${r.content.length} Zeichen, ${r.protocol}`);
    if (read) {
      await step('write_file mit falscher Revision abgelehnt', async () => {
        try { await call('write_file', { projectId, filePath: 'main.tex', revision: 'falsch', content: 'x' }); } catch (error) { return (error as Error).message.slice(0, 60); }
        throw new Error('Falsche Revision angenommen');
      }, m => m);
      const written = await step('write_file (Betreiber-Schreibmodus)', () => call('write_file', { projectId, filePath: 'main.tex', revision: read.revision, content: `${read.content}% MCP-Schreibtest\n` }), r => `verification=${r.verification}`);
      if (written) await step('erneutes Lesen bestätigt Änderung', async () => {
        const after = await call('read_file', { projectId, filePath: 'main.tex' });
        if (!after.content.includes('MCP-Schreibtest')) throw new Error('Änderung nicht sichtbar');
        return after.revision as string;
      }, () => 'Änderung sichtbar');
      await step('verbrauchte Revision erneut abgelehnt', async () => {
        try { await call('write_file', { projectId, filePath: 'main.tex', revision: read.revision, content: 'veraltet' }); } catch (error) { return (error as Error).message.slice(0, 60); }
        throw new Error('Veraltete Revision angenommen');
      }, m => m);
    }
    await step('Verwaltung ohne Betreiberfreigabe nicht angeboten', async () => {
      const result = await client.callTool({ name: 'manage_project', arguments: { projectId, action: 'trash', confirmName: name } }) as ToolResult;
      if (!result.isError) throw new Error('manage_project ohne Freigabe ausgeführt');
      return text(result).slice(0, 60);
    }, m => m);
  } finally {
    await client.close().catch(() => undefined);
    tcp.close();
    const admin = new ToolSession(adapter, { baseUrl, projectId }, true, false, { allowManageProjects: true, allowDestructive: true });
    await step('trash', () => admin.call('manage_project', { projectId, action: 'trash', confirmName: name }) as Promise<any>, r => `confirmed=${r.confirmed}`);
    await step('delete permanently', () => admin.call('manage_project', { projectId, action: 'delete', confirmName: name }) as Promise<any>, r => `confirmed=${r.confirmed}`);
  }
  console.log(summary());
}
