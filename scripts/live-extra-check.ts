import { crc32 } from 'node:zlib';
import type { BrowserOverleaf } from '../server/overleaf.js';
import { revisionOf } from '../server/overleaf.js';
import { ToolSession } from '../server/tools.js';
import { describe, stepper, waitReady } from './live-common.js';

/** Minimal stored (uncompressed) ZIP so the import test needs no extra dependency or file on disk. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), fileName = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(fileName.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, data); centrals.push(central, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Remaining live checks; only "Studio-Livetest" projects are changed and all are moved to the trash afterwards. */
export async function extraCheck(adapter: BrowserOverleaf, baseUrl: string, reuse: string) {
  // Lets an already running session reach named checks (scripts/live-<name>-check.ts) without a restart or new login.
  if (/^[a-z]+$/.test(reuse)) return (await import(`./live-${reuse}-check.ts?t=${Date.now()}`)).run(adapter, baseUrl);
  const { step, summary } = stepper();
  const stamp = Date.now().toString(36);
  const lookup = async (projectId: string) => {
    const listed = await new ToolSession(adapter, { baseUrl }, false).call('list_projects', { query: 'Studio-Livetest', includeArchived: true, includeTrashed: true, limit: 200 }) as any;
    return listed.projects.find((p: any) => p.projectId === projectId);
  };
  const project = await step('reuse disposable project', async () => {
    const found = await lookup(reuse);
    if (!found?.name.startsWith('Studio-Livetest')) throw new Error('Only projects named "Studio-Livetest …" may be written to.');
    return found;
  }, r => `${r.name}, trashed=${r.trashed}`);
  if (!project) { console.log(summary()); return; }
  let name: string = project.name;
  const projectId = reuse, scope = { baseUrl, projectId };
  const session = new ToolSession(adapter, scope, true, false, { allowManageProjects: true, allowDestructive: true,
    attachments: [{ id: 'probe', name: 'probe.txt', dataBase64: Buffer.from('Uploaded to subfolder\n').toString('base64') }] });
  const call = (tool: string, args: Record<string, unknown> = {}) => session.call(tool, { projectId, ...args }) as Promise<any>;
  const trash = (id: string, confirmName: string) => new ToolSession(adapter, { baseUrl, projectId: id }, false, false, { allowManageProjects: true, allowDestructive: true })
    .call('manage_project', { projectId: id, action: 'trash', confirmName }) as Promise<any>;
  if (project.trashed) await step('restore', () => call('manage_project', { action: 'restore' }), r => `confirmed=${r.confirmed}`);

  const renamed = `Studio-Livetest renamed ${stamp}`;
  if (await step('rename', () => call('manage_project', { action: 'rename', newName: renamed }), r => `confirmed=${r.confirmed}`)) name = renamed;
  await step('archive', () => call('manage_project', { action: 'archive', confirmName: name }), r => `confirmed=${r.confirmed}`);
  await step('unarchive', () => call('manage_project', { action: 'unarchive' }), r => `confirmed=${r.confirmed}`);

  const clone = await step('clone_project', () => new ToolSession(adapter, { baseUrl }, false, true).call('clone_project', { sourceProjectId: projectId, name: `Studio-Livetest Copy ${stamp}` }) as Promise<any>, r => r.projectId);
  if (clone) {
    await step('clone tree readable', () => new ToolSession(adapter, { baseUrl }, false).call('get_project_tree', { projectId: clone.projectId }) as Promise<any>, r => `${r.entities.length} entries`);
    await step('trash clone', () => trash(clone.projectId, clone.name), r => `confirmed=${r.confirmed}`);
  }
  const archive = zip({ 'main.tex': '\\documentclass{article}\n\\begin{document}\nZIP-Import\n\\end{document}\n', 'chapter/one.tex': '\\section{One}\n' });
  const imported = await step('import_project_zip', () => new ToolSession(adapter, { baseUrl }, false, true, { attachments: [{ id: 'zip', name: 'livetest.zip', dataBase64: archive.toString('base64') }] })
    .call('import_project_zip', { name: `Studio-Livetest Import ${stamp}`, attachmentId: 'zip' }) as Promise<any>, r => `${r.projectId} (${archive.length} bytes ZIP)`);
  if (imported) {
    await step('import tree', () => new ToolSession(adapter, { baseUrl }, false).call('get_project_tree', { projectId: imported.projectId }) as Promise<any>,
      r => `paths=${r.entities.filter((e: any) => e.type !== 'folder').map((e: any) => e.filePath).sort().join(',')}`);
    await step('trash import', () => trash(imported.projectId, imported.name), r => `confirmed=${r.confirmed}`);
  }

  await step('create_file (alt-root)', () => call('create_file', { filePath: `root-${stamp}.tex`, content: '\\documentclass{article}\n\\begin{document}\nRoot\n\\end{document}\n' }), () => 'ok');
  await step('rootFilePath set', () => call('update_project_settings', { rootFilePath: `root-${stamp}.tex` }), r => `rootDocPath=${r.rootDocPath}`);
  await step('rootFilePath restored', () => call('update_project_settings', { rootFilePath: 'main.tex' }), r => `rootDocPath=${r.rootDocPath}`);
  await step('create_folder', () => call('manage_entity', { path: `folder-${stamp}`, action: 'create_folder' }), () => 'ok');
  await step('upload to subfolder', () => call('upload_file', { filePath: `folder-${stamp}/probe.txt`, attachmentId: 'probe' }), r => `${r.bytes} bytes`);
  await step('download from subfolder', () => call('download_file', { filePath: `folder-${stamp}/probe.txt` }), r => `bytes identical=${Buffer.from(r.dataBase64, 'base64').toString() === 'Uploaded to subfolder\n'}`);
  await step('stop_compile', () => call('stop_compile'), r => `confirmation=${r.confirmation}`);

  // Same 150 000-character limit as the chat: the model gets only sections of larger documents.
  const big = Array.from({ length: 40 }, (_, i) => `\\section{Part ${i}}\n${'Lorem ipsum dolor sit amet. '.repeat(150)}\n`).join('');
  const limited = new ToolSession(adapter, scope, true, false, { maxContentChars: 150_000 });
  await step('create_file (large)', () => call('create_file', { filePath: `large-${stamp}.tex`, content: big }), () => `${big.length} chars`);
  const bigRead = await step('read_file (large, truncated)', () => limited.call('read_file', { projectId, filePath: `large-${stamp}.tex` }) as Promise<any>, r => `contentOmitted=${r.contentOmitted}, ${r.contentChars} chars`);
  if (bigRead) await step('write_file on large document rejected', async () => {
    try { await limited.call('write_file', { projectId, filePath: `large-${stamp}.tex`, revision: bigRead.revision, content: 'x' }); }
    catch (error) { return describe(error).slice(0, 80); }
    throw new Error('Full overwrite allowed without full text');
  }, m => m);
  const bigSections = await step('get_sections (large)', () => limited.call('get_sections', { projectId, filePath: `large-${stamp}.tex` }) as Promise<any>, r => `${r.sections.length} sections`);
  if (bigSections) await step('write_section (large)', async () => {
    await limited.call('write_section', { projectId, filePath: `large-${stamp}.tex`, revision: bigSections.revision, sectionId: bigSections.sections[0].sectionId, content: '\nShort.\n' });
    const after = await call('read_file', { filePath: `large-${stamp}.tex` });
    return `${after.content.length} chars, rest preserved=${after.content.includes('\\section{Part 39}')}`;
  }, m => m);

  // Legacy browser-editor fallback write, normally replaced by the document-bound connector.
  if (await step('editor connect', async () => { await adapter.connect(scope); return waitReady(adapter, scope, 90_000); }, m => m)) {
    const before = await step('browser editor read', () => adapter.read(scope, 'main.tex'), r => `${r.content.length} chars`);
    if (before) await step('browser editor write', async () => {
      const written = await adapter.write(scope, 'main.tex', `${before.content}% Editor write test\n`, revisionOf(before.content));
      await new Promise(resolve => setTimeout(resolve, 3000)); // Give the editor time to sync to the server.
      const remote = await call('read_file', { filePath: 'main.tex' });
      return `editor confirmed=${written.content.endsWith('% Editor write test\n')}, server sees change=${remote.content === written.content}`;
    }, m => m);
  }
  await step('trash project (restorable)', () => trash(projectId, name), r => `confirmed=${r.confirmed}`);
  console.log(summary());
}
