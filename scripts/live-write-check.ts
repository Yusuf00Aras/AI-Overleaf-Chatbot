import type { BrowserOverleaf } from '../server/overleaf.js';
import { ProposalStore, applyProposal } from '../server/proposals.js';
import { ToolSession } from '../server/tools.js';
import { describe, stepper, waitReady } from './live-common.js';

const probe = Buffer.from('Studio-Livetest Upload\n');
const attachments = [{ id: 'probe', name: 'probe.txt', dataBase64: probe.toString('base64') }, { id: 'probe2', name: 'probe2.txt', dataBase64: Buffer.from('ersetzt\n').toString('base64') }];

/** Write checks only in a disposable "Studio-Livetest" project (reused or created), moved to the trash at the end. */
export async function writeCheck(adapter: BrowserOverleaf, baseUrl: string, reuse?: string) {
  const { step, summary } = stepper();
  const admin = new ToolSession(adapter, { baseUrl }, false, !reuse);
  let name = `Studio-Livetest ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
  const project = reuse
    ? await step('reuse disposable project', async () => {
      const listed = await admin.call('list_projects', { query: 'Studio-Livetest', includeTrashed: true, limit: 200 }) as any;
      const found = listed.projects.find((p: any) => p.projectId === reuse);
      if (!found?.name.startsWith('Studio-Livetest')) throw new Error('Nur Projekte namens "Studio-Livetest …" werden beschrieben.');
      name = found.name;
      return found;
    }, r => `${r.projectId} (${r.name}), trashed=${r.trashed}`)
    : await step('create_project', () => admin.call('create_project', { name }) as Promise<any>, r => `${r.projectId} (${name})`);
  if (!project) { console.log(summary()); return; }
  const projectId: string = project.projectId;
  const scope = { baseUrl, projectId };
  const session = new ToolSession(adapter, scope, true, false, { allowManageProjects: true, allowDestructive: true, attachments });
  const call = (tool: string, args: Record<string, unknown> = {}) => session.call(tool, { projectId, ...args }) as Promise<any>;
  if (project.trashed) await step('restore', () => call('manage_project', { action: 'restore' }), r => `confirmed=${r.confirmed}`);

  const tree = await step('get_project_tree', () => call('get_project_tree'), r => `${r.entities.length} Einträge, root=${r.rootDocPath}, tracking=${r.trackChangesActive}`);
  const main: string = tree?.rootDocPath ?? 'main.tex';
  const fresh = () => call('read_file', { filePath: main }).catch(() => undefined);
  let read = await step('read_file', () => call('read_file', { filePath: main }), r => `${r.content.length} Zeichen, Protokoll=${r.protocol}, Version=${r.version}`);
  if (read) await step('write_file (untracked)', () => call('write_file', { filePath: main, revision: read.revision, content: `${read.content}% untracked\n` }), r => `verification=${r.verification}, Version=${r.version}`);
  read = await fresh();
  if (read) await step('write_file (tracked)', async () => {
    try {
      const result = await call('write_file', { filePath: main, revision: read.revision, content: `${read.content}% tracked\n`, writeMode: 'tracked' });
      return `trackingVerified=${result.trackingVerified}`;
    } catch (error) {
      const after = await fresh();
      if (after?.version !== read.version) throw new Error(`${describe(error)} – Dokument trotzdem geändert`);
      return `abgelehnt ohne Änderung: ${describe(error).slice(0, 80)}`;
    }
  }, m => m);
  read = await fresh();
  if (read) await step('stale revision rejected remotely', async () => {
    await call('write_file', { filePath: main, revision: read.revision, content: `${read.content}% eins\n` });
    // Bypasses the session's read bookkeeping on purpose to prove the connector's own revision check.
    try { await adapter.execute(baseUrl, 'write_file', { projectId, filePath: main, revision: read.revision, content: 'veraltet' }); } catch (error) { return describe(error).slice(0, 80); }
    throw new Error('Veraltete Revision wurde akzeptiert');
  }, m => m);
  read = await fresh();
  if (read) await step('preview_edit', () => call('preview_edit', { filePath: main, revision: read.revision, content: `${read.content}% Vorschau\n` }), r => `writing=${r.writing}, +${r.addedLines}/-${r.removedLines}`);

  const store = new ProposalStore();
  const proposing = new ToolSession(adapter, scope, true, false, { propose: proposal => store.add(scope, proposal).id });
  const proposalRead = await proposing.call('read_file', { projectId, filePath: main }).catch(() => undefined) as any;
  if (proposalRead) await step('confirmation proposal + apply', async () => {
    const pending = await proposing.call('write_file', { projectId, filePath: main, revision: proposalRead.revision, content: `${proposalRead.content}% bestätigt\n` }) as any;
    const unchanged = (await call('read_file', { filePath: main })).content === proposalRead.content;
    const applied = await applyProposal(adapter, scope, store.take(pending.proposalId, scope));
    return `pending=${pending.pendingUserConfirmation}, vorher unverändert=${unchanged}, angewendet=${applied.verification}`;
  }, m => m);
  const legacy = await step('read_document (Alias)', () => call('read_document', { filePath: main }), r => `${r.content.length} Zeichen`);
  if (legacy) await step('write_document (Alias)', () => session.call('write_document', { filePath: main, revision: legacy.revision, content: `${legacy.content}% legacy\n` }) as Promise<any>, r => `verification=${r.verification}`);

  const suffix = Date.now().toString(36), chapter = `kapitel-${suffix}.tex`, folder = `livetest-${suffix}`, upload = `probe-${suffix}.txt`;
  await step('create_file', () => call('create_file', { filePath: chapter, content: '\\section{Eins}\nalt\n\\section{Zwei}\nbleibt\n' }), r => `Version=${r.version ?? '-'}`);
  const sections = await step('get_sections', () => call('get_sections', { filePath: chapter }), r => `${r.sections.length} Abschnitte`);
  if (sections?.sections.length) await step('write_section', async () => {
    await call('write_section', { filePath: chapter, revision: sections.revision, sectionId: sections.sections[0].sectionId, content: '\nneu\n' });
    const after = await call('read_file', { filePath: chapter });
    return `ersetzt=${after.content.includes('\nneu\n') && !after.content.includes('alt')}, Rest erhalten=${after.content.includes('bleibt')}`;
  }, m => m);
  await step('create_folder', () => call('manage_entity', { path: folder, action: 'create_folder' }), () => 'ok');
  await step('move', () => call('manage_entity', { path: chapter, action: 'move', destinationFolderPath: folder }), r => `→ ${r.destination}`);
  await step('rename', () => call('manage_entity', { path: `${folder}/${chapter}`, action: 'rename', newName: `neu-${chapter}` }), r => `→ ${r.destination}`);
  await step('upload_file', () => call('upload_file', { filePath: upload, attachmentId: 'probe' }), r => `${r.bytes} Bytes, replaced=${r.replaced}`);
  await step('download_file', () => call('download_file', { filePath: upload }), r => `Bytes identisch=${Buffer.from(r.dataBase64, 'base64').equals(probe)}`);
  await step('upload_file (overwrite)', () => call('upload_file', { filePath: upload, attachmentId: 'probe2', overwrite: true, confirmPath: upload }), r => `replaced=${r.replaced}`);
  await step('delete (confirmPath)', () => call('manage_entity', { path: `${folder}/neu-${chapter}`, action: 'delete', confirmPath: `${folder}/neu-${chapter}` }), r => `confirmed=${r.confirmed}`);
  await step('settings: xelatex', () => call('update_project_settings', { compiler: 'xelatex' }), r => `compiler=${r.compiler}`);
  await step('settings: pdflatex', () => call('update_project_settings', { compiler: 'pdflatex' }), r => `compiler=${r.compiler}`);
  await step('compile_project', () => call('compile_project', { timeoutMs: 180_000 }), r => `status=${r.status}, ${r.outputFiles.length} Ausgabedateien`);
  await step('monitor_project_history', () => call('monitor_project_history'), r => `${r.updates.length} Updates`);
  if (await step('editor connect', async () => { await adapter.connect(scope); return waitReady(adapter, scope, 90_000); }, m => m)) {
    const current = await fresh();
    await step('browser editor read', () => adapter.read(scope, main), r => `gleich wie Connector=${r.content === current?.content} (${r.content.length}/${current?.content.length} Zeichen)`);
  }
  await step('trash project (restorable)', () => call('manage_project', { action: 'trash', confirmName: name }), r => `confirmed=${r.confirmed}`);
  console.log(summary());
}
