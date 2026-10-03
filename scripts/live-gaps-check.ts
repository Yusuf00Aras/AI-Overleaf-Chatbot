import { createHash } from 'node:crypto';
import type { BrowserOverleaf } from '../server/overleaf.js';
import { ToolSession } from '../server/tools.js';
import { stepper } from './live-common.js';

/** Parameters that were never run live: example template, imageName/spellCheckLanguage, other compile root, history cursor, blob hash. */
export async function run(adapter: BrowserOverleaf, baseUrl: string) {
  const { step, summary } = stepper();
  const name = `Studio-Livetest Luecken ${Date.now().toString(36)}`;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const gitBlob = createHash('sha1').update(`blob ${png.length}\0`).update(png).digest('hex');
  const created = await step('create_project (template example)', () => new ToolSession(adapter, { baseUrl }, false, true).call('create_project', { name, template: 'example' }) as Promise<any>, r => `${r.projectId}, root=${r.rootDocPath}`);
  if (!created) { console.log(summary()); return; }
  const projectId: string = created.projectId;
  const session = new ToolSession(adapter, { baseUrl, projectId }, true, false, { allowManageProjects: true, allowDestructive: true,
    attachments: [{ id: 'bild', name: 'bild.png', dataBase64: png.toString('base64') }] });
  const call = (tool: string, args: Record<string, unknown> = {}) => session.call(tool, { projectId, ...args }) as Promise<any>;
  try {
    const tree = await step('get_project_tree (Beispielinhalt)', () => call('get_project_tree'), r => `${r.entities.length} Einträge, root=${r.rootDocPath}, image=${r.imageName}, spell=${r.spellCheckLanguage}`);
    const before = { imageName: tree?.imageName as string | undefined, spellCheckLanguage: tree?.spellCheckLanguage as string | undefined };
    await step('settings: spellCheckLanguage de', () => call('update_project_settings', { spellCheckLanguage: 'de' }), r => `spell=${r.spellCheckLanguage}`);
    if (before.spellCheckLanguage !== undefined) await step('settings: spellCheckLanguage zurück', () => call('update_project_settings', { spellCheckLanguage: before.spellCheckLanguage }), r => `spell=${r.spellCheckLanguage}`);
    if (before.imageName) await step('settings: imageName (unverändert setzen)', () => call('update_project_settings', { imageName: before.imageName }), r => `image=${r.imageName}`);
    await step('create_file other.tex', () => call('create_file', { filePath: 'other.tex', content: '\\documentclass{article}\n\\begin{document}\nAnderes Wurzeldokument\n\\end{document}\n' }), r => `${r.filePath ?? 'ok'}`);
    await step('compile_project (anderes rootFilePath)', () => call('compile_project', { rootFilePath: 'other.tex', timeoutMs: 180_000 }), r => `status=${r.status}, root=${r.rootFilePath}, ${r.outputFiles.length} Ausgabedateien`);
    const stillRoot = await step('Standard-Root unverändert', () => call('get_project_tree'), r => `root=${r.rootDocPath}`);
    if (stillRoot && stillRoot.rootDocPath === 'other.tex') console.log('FAIL  Standard-Root wurde durch den Compile-Aufruf verändert.');
    await step('upload_file (PNG)', () => call('upload_file', { filePath: 'bild.png', attachmentId: 'bild' }), r => `${r.bytes} Bytes`);
    await step('Blob-Hash im Baum', async () => {
      const entity = (await call('get_project_tree')).entities.find((e: any) => e.filePath === 'bild.png');
      if (!entity?.hash) throw new Error('Kein hash am Binärdatei-Eintrag.');
      if (entity.hash !== gitBlob) throw new Error(`hash weicht ab (erwartet ${gitBlob}, erhalten ${entity.hash}).`);
      return entity.hash as string;
    }, hash => `${hash} = git hash-object`);
    const history = await step('monitor_project_history (ohne Cursor)', () => call('monitor_project_history'), r => `currentVersion=${r.currentVersion}, ${r.updates.length} Updates`);
    if (history?.currentVersion != null) {
      await step('monitor_project_history (sinceVersion = aktuell)', () => call('monitor_project_history', { sinceVersion: history.currentVersion }), r => `${r.updates.length} neuere Updates, gapDetected=${r.gapDetected}`);
      await step('monitor_project_history (sinceVersion = 0)', () => call('monitor_project_history', { sinceVersion: 0 }), r => `${r.updates.length} Updates seit 0`);
    } else console.log('INFO  Verlauf ohne Version; Cursor-Schritte übersprungen.');
    await step('list_projects (sort name, limit 3)', () => new ToolSession(adapter, { baseUrl }, false).call('list_projects', { sort: 'name', limit: 3 }) as Promise<any>,
      r => { const names = r.projects.map((p: any) => p.name as string); if (names.some((n: string, i: number) => i && names[i - 1]!.localeCompare(n) > 0)) throw new Error('nicht alphabetisch'); return `${names.length}/${r.totalMatched} sortiert`; });
  } finally {
    await step('trash', () => call('manage_project', { action: 'trash', confirmName: name }), r => `confirmed=${r.confirmed}`);
    await step('delete permanently', () => call('manage_project', { action: 'delete', confirmName: name }), r => `confirmed=${r.confirmed}`);
  }
  console.log(summary());
}
