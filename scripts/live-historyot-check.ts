import type { BrowserOverleaf } from '../server/overleaf.js';
import { ToolSession } from '../server/tools.js';
import { describe, stepper } from './live-common.js';

/** History-OT check in a fresh disposable project; the project is permanently deleted afterwards. */
export async function run(adapter: BrowserOverleaf, baseUrl: string) {
  const { step, summary } = stepper();
  const name = `Studio-Livetest HistoryOT ${Date.now().toString(36)}`;
  const created = await step('create_project', () => new ToolSession(adapter, { baseUrl }, false, true).call('create_project', { name }) as Promise<any>, r => r.projectId);
  if (!created) { console.log(summary()); return; }
  const projectId: string = created.projectId;
  const session = new ToolSession(adapter, { baseUrl, projectId }, true, false, { allowManageProjects: true, allowDestructive: true });
  const call = (tool: string, args: Record<string, unknown> = {}) => session.call(tool, { projectId, ...args }) as Promise<any>;
  try {
    const tree = await step('get_project_tree', () => call('get_project_tree'), r => `root=${r.rootDocPath}, tracking=${r.trackChangesActive}`);
    const main: string = tree?.rootDocPath ?? 'main.tex';
    let read = await step('read_file', () => call('read_file', { filePath: main }), r => `Protokoll=${r.protocol}, Version=${r.version}, ${r.content.length} Zeichen`);
    if (read?.protocol !== 'history-ot') console.log(`INFO  Instanz liefert ${read?.protocol ?? 'nichts'} statt history-ot; History-OT-Pfad hier nicht prüfbar.`);
    if (read) await step('write_file (untracked)', () => call('write_file', { filePath: main, revision: read.revision, content: read.content.replace('\\end{document}', 'History-OT Zeile\n\\end{document}') }), r => `verification=${r.verification}, Version=${r.version}`);
    read = await call('read_file', { filePath: main }).catch(() => undefined);
    if (read) await step('write_file (Ersetzen + Löschen)', () => call('write_file', { filePath: main, revision: read.revision, content: read.content.replace('History-OT Zeile', 'Ersetzt') }), r => `verification=${r.verification}`);
    read = await call('read_file', { filePath: main }).catch(() => undefined);
    if (read) await step('write_file (tracked)', async () => {
      try { return `trackingVerified=${(await call('write_file', { filePath: main, revision: read.revision, content: read.content.replace('Ersetzt', 'Nachverfolgt'), writeMode: 'tracked' })).trackingVerified}`; }
      catch (error) {
        const after = await call('read_file', { filePath: main });
        return `abgelehnt (${describe(error).slice(0, 60)}), Dokument unverändert=${after.content === read.content}`;
      }
    }, m => m);
    await step('create_file + write_section', async () => {
      await call('create_file', { filePath: 'kapitel.tex', content: '\\section{Eins}\nalt\n\\section{Zwei}\nbleibt\n' });
      const sections = await call('get_sections', { filePath: 'kapitel.tex' });
      await call('write_section', { filePath: 'kapitel.tex', revision: sections.revision, sectionId: sections.sections[0].sectionId, content: '\nneu\n' });
      const after = await call('read_file', { filePath: 'kapitel.tex' });
      return `Protokoll=${after.protocol}, ersetzt=${after.content.includes('\nneu\n')}, Rest=${after.content.includes('bleibt')}`;
    }, m => m);
  } finally {
    await step('trash', () => call('manage_project', { action: 'trash', confirmName: name }), r => `confirmed=${r.confirmed}`);
    await step('delete permanently', () => call('manage_project', { action: 'delete', confirmName: name }), r => `confirmed=${r.confirmed}`);
  }
  console.log(summary());
}
