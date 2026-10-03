import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import OpenAI from 'openai';
import { z } from 'zod';
import { chat, chatSchema } from './chat.js';
import type { OverleafAdapter } from './overleaf.js';
import { UserError, allowedRequest, safeMessage, workspaceScopeSchema, instanceSchema, scopeSchema, tokenEquals } from './policy.js';
import { ProposalStore, applyProposal } from './proposals.js';

export interface AppOptions {
  adapter: OverleafAdapter;
  /** Ports whose Host/Origin are accepted (own port plus Vite dev port). */
  ports: readonly number[];
  csrfToken?: string;
  staticDir?: string;
  proposals?: ProposalStore;
}

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function aiError(error: unknown): { status: number; message: string } | undefined {
  if (error instanceof OpenAI.APIConnectionError) return { status: 502, message: 'KI-Anbieter nicht erreichbar oder Zeitüberschreitung.' };
  if (!(error instanceof OpenAI.APIError)) return undefined;
  const messages: Record<number, string> = {
    400: 'Anfrage vom KI-Anbieter abgelehnt (z. B. Modell unterstützt keine Werkzeuge oder Kontext zu lang).',
    401: 'API-Schlüssel ungültig.',
    403: 'API-Schlüssel ohne Berechtigung für dieses Modell.',
    404: 'Modell nicht gefunden oder nicht freigeschaltet.',
    429: 'Rate-Limit oder Kontingent des KI-Anbieters erreicht.',
  };
  return { status: 502, message: messages[error.status ?? 0] ?? `Fehler beim KI-Anbieter (Status ${error.status ?? 'unbekannt'}).` };
}

export function createApp({ adapter, ports, csrfToken = randomBytes(32).toString('hex'), staticDir, proposals = new ProposalStore() }: AppOptions) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
    });
    if (!allowedRequest(req.headers.host, req.headers.origin, ports)) { res.status(403).json({ error: 'Anfrage abgelehnt.' }); return; }
    next();
  });

  const api = express.Router();
  api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  // No CORS headers: only same-origin pages can read the token. It protects all state-changing routes.
  api.get('/session', (req, res) => {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') { res.status(403).json({ error: 'Anfrage abgelehnt.' }); return; }
    res.json({ token: csrfToken });
  });

  api.use((req, res, next) => {
    if (req.method !== 'POST' || !req.is('application/json') || !tokenEquals(req.headers['x-studio-token'], csrfToken)) {
      res.status(403).json({ error: 'Sitzung ungültig. Seite neu laden.' });
      return;
    }
    next();
  });
  api.use(express.json({ limit: '4mb' }));

  const scopeBody = workspaceScopeSchema.strict();
  const decisionBody = z.object({ proposalId: z.string().regex(/^[a-f0-9]{32}$/), scope: scopeSchema.strict(), decision: z.enum(['apply', 'discard']) }).strict();
  api.post('/connect', async (req, res) => {
    const scope = scopeBody.parse(req.body);
    proposals.clear(); // A new connection is a new scope: older proposals must never execute.
    res.json(await adapter.connect(scope));
  });
  api.post('/status', async (req, res) => { res.json(await adapter.status(scopeBody.parse(req.body))); });
  api.post('/projects', async (req, res) => { res.json(await adapter.listProjects(instanceSchema.strict().parse(req.body).baseUrl)); });
  api.post('/chat', async (req, res) => {
    const input = chatSchema.parse(req.body);
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    res.json(await chat(input, adapter, controller.signal, undefined, proposals));
  });
  // Explicit user decision on one queued change. Single use: the proposal is removed before execution.
  api.post('/proposals', async (req, res) => {
    const body = decisionBody.parse(req.body);
    const proposal = proposals.take(body.proposalId, body.scope);
    if (body.decision === 'discard') { res.json({ status: 'discarded' }); return; }
    res.json({ status: 'applied', result: await applyProposal(adapter, body.scope, proposal) });
  });
  api.use((_req, res) => { res.status(404).json({ error: 'Unbekannter Endpunkt.' }); });

  // Never log request bodies, API keys or document content; only the error class and route.
  api.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent || req.socket.destroyed) return;
    const type = (error as { type?: string } | null)?.type;
    if (type === 'entity.too.large') { res.status(413).json({ error: 'Anfrage zu groß.' }); return; }
    if (type === 'entity.parse.failed') { res.status(400).json({ error: 'Ungültiges JSON.' }); return; }
    const ai = aiError(error);
    if (ai) { res.status(ai.status).json({ error: ai.message }); return; }
    if (error instanceof UserError || error instanceof z.ZodError) { res.status(400).json({ error: safeMessage(error, '') }); return; }
    console.error(`Fehler in ${req.method} ${req.path}: ${error instanceof Error ? error.name : 'Unbekannt'}`);
    res.status(500).json({ error: 'Interner Fehler. Verbindung im Overleaf-Browser prüfen.' });
  });
  app.use('/api', api);

  if (staticDir && existsSync(path.join(staticDir, 'index.html'))) {
    app.use(express.static(staticDir, { index: 'index.html' }));
    app.get('/{*page}', (_req, res) => { res.sendFile(path.join(staticDir, 'index.html')); });
  }
  return app;
}
