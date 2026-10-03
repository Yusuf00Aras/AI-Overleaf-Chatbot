import type { BrowserOverleaf } from '../server/overleaf.js';
import { UserError } from '../server/policy.js';

export function describe(error: unknown) {
  if (error instanceof UserError) return error.message;
  return `${error instanceof Error ? error.name : 'Fehler'}: ${String(error instanceof Error ? error.message : error).split('\n')[0]!.slice(0, 200)}`;
}

/** Prints only metadata and pass/fail per step; never document contents or auth data. */
export function stepper(pauseMs = 1500) {
  let ok = 0, total = 0;
  async function step<T>(name: string, run: () => Promise<T>, detail: (value: T) => string): Promise<T | undefined> {
    await new Promise(resolve => setTimeout(resolve, pauseMs)); // Stay below the instance's request rate limit.
    total++;
    try {
      const value = await run();
      ok++;
      console.log(`OK    ${name}: ${detail(value)}`);
      return value;
    } catch (error) {
      console.log(`FAIL  ${name}: ${describe(error)}`);
      return undefined;
    }
  }
  return { step, summary: () => `Ergebnis: ${ok}/${total} Schritte erfolgreich.` };
}

export async function waitReady(adapter: BrowserOverleaf, scope: { baseUrl: string; projectId?: string }, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await adapter.status(scope);
    if (status.ready) return status.message;
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new UserError('Zeitüberschreitung beim Warten auf Anmeldung/Editor.');
}
