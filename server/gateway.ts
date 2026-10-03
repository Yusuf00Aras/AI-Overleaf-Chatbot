import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { UserError, safeMessage, workspaceScopeSchema, type WorkspaceScope } from './policy.js';
import type { OverleafAdapter } from './overleaf.js';
import { ToolSession, availableTools, type ToolOptions } from './tools.js';
import { extractDownloads } from './chat.js';
import { MAX_FRAME } from './transports.js';

/** Leaves room for JSON-RPC framing inside the socket frame limit, measured after string escaping. */
export const MAX_GATEWAY_RESULT = MAX_FRAME - 16 * 1024;

/** Write permission is set by the human operator (server configuration), never by tool arguments. */
export interface GatewayOptions extends Omit<ToolOptions, 'attachments'> { allowWrites: boolean; allowCreateProjects?: boolean }

export function operatorOptions(env: NodeJS.ProcessEnv): GatewayOptions {
  return { allowWrites: env.OVERLEAF_ALLOW_WRITES === '1', allowCreateProjects: env.OVERLEAF_ALLOW_CREATE_PROJECTS === '1',
    allowManageProjects: env.OVERLEAF_ALLOW_MANAGE_PROJECTS === '1', allowDestructive: env.OVERLEAF_ALLOW_DESTRUCTIVE === '1',
    allowComments: env.OVERLEAF_ALLOW_COMMENTS === '1' };
}

export async function attachGateway(transport: Transport, adapter: OverleafAdapter, options: GatewayOptions): Promise<Server> {
  const server = new Server({ name: 'overleaf-chat-studio', version: '0.1.0' }, { capabilities: { tools: {} } });
  let session: ToolSession | undefined;
  let selected: WorkspaceScope | undefined;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: 'connect_overleaf', description: `Select hosted (https://www.overleaf.com) or self-hosted Overleaf and open a visible login browser. Write access: ${options.allowWrites ? 'enabled by the operator' : 'disabled (read-only)'}.`,
    inputSchema: { type: 'object', properties: { baseUrl: { type: 'string' }, projectId: { type: 'string' } }, required: ['baseUrl'], additionalProperties: false },
  }, ...availableTools(selected, options.allowWrites, options.allowCreateProjects ?? false, options)] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      let result: unknown;
      if (request.params.name === 'connect_overleaf') {
        const scope = workspaceScopeSchema.strict().parse(request.params.arguments);
        session?.dispose();
        session = undefined;
        selected = undefined;
        result = await adapter.connect(scope);
        selected = scope;
        session = new ToolSession(adapter, scope, options.allowWrites, options.allowCreateProjects ?? false, options);
      } else {
        if (!session) throw new UserError('Zuerst connect_overleaf ausführen.');
        // Binary downloads are deliberately not forwarded to MCP clients; only metadata remains.
        result = extractDownloads(await session.call(request.params.name, request.params.arguments ?? {}), [], false);
      }
      const text = JSON.stringify(result);
      if (Buffer.byteLength(JSON.stringify(text)) > MAX_GATEWAY_RESULT) throw new UserError(`LIMIT_EXCEEDED: Ergebnis zu groß für den MCP-Transport (Grenze ${MAX_GATEWAY_RESULT} Bytes). Abschnittsweise lesen; eine bereits ausgeführte Aktion bleibt bestehen.`);
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      const text = safeMessage(error, 'Aktion fehlgeschlagen. Projektverbindung, Pfad, Freigabe und Revision prüfen. Nicht blind wiederholen.');
      return { isError: true, content: [{ type: 'text', text }] };
    }
  });
  await server.connect(transport);
  return server;
}