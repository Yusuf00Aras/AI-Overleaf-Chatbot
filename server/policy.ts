import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export function tokenEquals(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** Error whose message is safe to show to users and models (no secrets, no document content). */
export class UserError extends Error {}

export function safeMessage(error: unknown, fallback: string): string {
  if (error instanceof UserError) return error.message;
  if (error instanceof z.ZodError) {
    return 'Ungültige Eingabe: ' + error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || 'Wert'}: ${issue.message}`).join('; ');
  }
  return fallback;
}

const URL_ERROR = 'Eine HTTPS-Basis-URL ohne Zugangsdaten oder Pfad ist erforderlich (lokal auch HTTP).';

export function instanceUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new UserError(URL_ERROR); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new UserError(URL_ERROR);
  }
  return url.origin;
}

const validUrl = (value: string) => { try { instanceUrl(value); return true; } catch { return false; } };

const AI_URL_ERROR = 'KI-Endpunkt: HTTPS-Basis-URL ohne Zugangsdaten, Query oder Fragment erforderlich (lokal auch HTTP; keine Link-Local-Adressen).';

/** Base URL of an OpenAI-compatible endpoint (path allowed, e.g. https://host/api/v1). The API key is only ever sent there. */
export function aiEndpointUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new UserError(AI_URL_ERROR); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash ||
      /^169\.254\./.test(url.hostname) || /^\[fe[89ab]/i.test(url.hostname)) throw new UserError(AI_URL_ERROR);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
const validAiUrl = (value: string) => { try { aiEndpointUrl(value); return true; } catch { return false; } };

export const aiEndpointSchema = z.object({
  baseUrl: z.string().max(300).refine(validAiUrl, AI_URL_ERROR).transform(aiEndpointUrl),
  toolCalling: z.boolean().default(true),
  maxInputTokens: z.number().int().min(1000).max(10_000_000).optional(),
  maxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
}).strict();

export const instanceSchema = z.object({
  baseUrl: z.string().max(300).refine(validUrl, URL_ERROR).transform(instanceUrl),
});
export const projectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Ungültige Overleaf-Projekt-ID.').transform(value => value.toLowerCase());
export const workspaceScopeSchema = instanceSchema.extend({ projectId: projectIdSchema.optional() });
export type WorkspaceScope = z.infer<typeof workspaceScopeSchema>;
export const scopeSchema = instanceSchema.extend({ projectId: projectIdSchema });
export type Scope = z.infer<typeof scopeSchema>;

export const projectNameSchema = z.string().refine(
  value => !/[\/\\\x00-\x1f\x7f-\x9f]/.test(value), 'Projektname darf keine Schrägstriche oder Steuerzeichen enthalten.',
).trim().min(1).max(150);

export const pathSchema = z.string().min(1).max(300).refine(
  value => !value.startsWith('/') && !value.includes('\\') &&
    !value.split('/').some(part => part === '..' || part === '.' || !part) && !/[\x00-\x1f]/.test(value),
  'Ungültiger projekt-relativer Dateipfad.',
);

/** Blocks DNS rebinding (Host) and cross-site browser requests (Origin). Ports: own port plus Vite dev port. */
export function allowedRequest(host: string | undefined, origin: string | undefined, ports: readonly number[]): boolean {
  const hosts = ports.flatMap(port => [`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!host || !hosts.includes(host)) return false;
  return !origin || hosts.map(value => `http://${value}`).includes(origin);
}

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}