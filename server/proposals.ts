import { randomBytes } from 'node:crypto';
import { UserError, type Scope } from './policy.js';
import type { OverleafAdapter } from './overleaf.js';
import type { Proposal, ProposalSummary } from './tools.js';

export interface ProposalView extends ProposalSummary { id: string; tool: string; expiresAt: string }

/** RAM-only, single-use queue of changes awaiting explicit user confirmation. Never persisted or logged. */
export class ProposalStore {
  private items = new Map<string, { scope: Scope; tool: string; args: Record<string, unknown>; expires: number }>();
  constructor(private ttlMs = 15 * 60_000, private max = 20, private now = () => Date.now()) {}
  private prune() {
    for (const [id, item] of this.items) if (item.expires <= this.now()) this.items.delete(id);
  }
  add(scope: Scope, proposal: Proposal): ProposalView {
    this.prune();
    if (this.items.size >= this.max) throw new UserError('Zu viele offene Änderungsvorschläge. Zuerst bestätigen oder verwerfen.');
    const id = randomBytes(16).toString('hex'), expires = this.now() + this.ttlMs;
    this.items.set(id, { scope: { baseUrl: scope.baseUrl, projectId: scope.projectId }, tool: proposal.tool, args: { ...proposal.args }, expires });
    return { id, tool: proposal.tool, ...proposal.summary, expiresAt: new Date(expires).toISOString() };
  }
  /** Removes the proposal in every case; a mismatching scope never executes it. */
  take(id: string, scope: Scope): { tool: string; args: Record<string, unknown> } {
    this.prune();
    const item = this.items.get(id);
    this.items.delete(id);
    if (!item || item.scope.baseUrl !== scope.baseUrl || item.scope.projectId !== scope.projectId) {
      throw new UserError('Änderungsvorschlag unbekannt, abgelaufen, bereits verwendet oder für ein anderes Projekt.');
    }
    return { tool: item.tool, args: item.args };
  }
  clear() { this.items.clear(); }
  discard(id: string) { this.items.delete(id); }
  get size() { this.prune(); return this.items.size; }
}

/** Executes exactly once; remote revision and confirmation checks run again inside the connector. */
export async function applyProposal(adapter: OverleafAdapter, scope: Scope, proposal: { tool: string; args: Record<string, unknown> }) {
  let result: unknown;
  if (proposal.tool === 'write_document' && !adapter.execute) {
    const written = await adapter.write(scope, proposal.args.filePath as string, proposal.args.content as string, proposal.args.revision as string);
    result = { filePath: written.filePath, revision: written.revision, message: 'Editor-Inhalt geändert. Synchronisierung in Overleaf prüfen.' };
  } else {
    if (!adapter.execute) throw new UserError('PROTOCOL_UNSUPPORTED: Connector nicht verfügbar.');
    result = await adapter.execute(scope.baseUrl, proposal.tool, proposal.args);
  }
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result && typeof result === 'object' ? result : {})) {
    if (['content', 'dataBase64'].includes(key)) continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) summary[key] = typeof value === 'string' ? value.slice(0, 2048) : value;
  }
  return summary;
}
