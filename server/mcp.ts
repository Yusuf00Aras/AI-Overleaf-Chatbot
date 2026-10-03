import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { attachGateway, operatorOptions } from './gateway.js';
import { BrowserOverleaf } from './overleaf.js';

const adapter = new BrowserOverleaf();
// Writes only when the operator sets OVERLEAF_ALLOW_WRITES=1 in the MCP client configuration.
const server = await attachGateway(new StdioServerTransport(), adapter, operatorOptions(process.env));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  void Promise.all([server.close(), adapter.close()]).finally(() => process.exit(0));
});