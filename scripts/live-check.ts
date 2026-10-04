import type { BrowserOverleaf } from '../server/overleaf.js';
import { ToolSession } from '../server/tools.js';
import { stepper, waitReady } from './live-common.js';

/** Read-only checks on an existing project (default: first active project). */
export async function readCheck(adapter: BrowserOverleaf, baseUrl: string, wanted?: string) {
  const { step, summary } = stepper();
  const session = new ToolSession(adapter, { baseUrl }, false);
  const call = (name: string, args: Record<string, unknown> = {}) => session.call(name, args) as Promise<any>;
  await step('auth_status', () => call('auth_status'), r => `authenticated=${r.authenticated}`);
  await step('dashboard catalog (legacy)', () => adapter.listProjects(baseUrl), r => `${r.projects.length} active projects`);
  const list = await step('list_projects', () => call('list_projects', { limit: 200 }), r => `${r.projects.length}/${r.totalProjects} projects`);
  const project = list?.projects.find((p: any) => wanted ? p.projectId === wanted : !p.name.startsWith('Studio-Livetest'));
  if (project) {
    const projectId: string = project.projectId;
    console.log(`>>>   Test project (read-only): ${projectId}`);
    const tree = await step('get_project_tree', () => call('get_project_tree', { projectId }),
      r => `${r.entities.length} entries, root=${r.rootDocPath ? 'yes' : 'no'}, compiler=${r.compiler}, tracking=${r.trackChangesActive}`);
    const filePath: string | undefined = tree?.rootDocPath ?? tree?.entities.find((e: any) => e.type === 'doc')?.filePath;
    if (filePath) {
      const file = { projectId, filePath };
      const read = await step('read_file', () => call('read_file', file), r => `${r.content.length} chars, protocol=${r.protocol}, version=${r.version}`);
      await step('read_document (alias)', () => call('read_document', file), r => `same revision=${r.revision === read?.revision}`);
      const sections = await step('get_sections', () => call('get_sections', file), r => `${r.sections.length} sections`);
      if (sections?.sections.length) await step('get_section_content', () => call('get_section_content', { ...file, sectionId: sections.sections[0].sectionId }), r => `${r.content.length} chars`);
      await step('validate_latex', () => call('validate_latex', file), r => `${r.issues.length} static hints`);
      await step('list_comments', () => call('list_comments', { ...file, status: 'all' }), r => `${r.threads.length} Threads`);
      await step('download_file', () => call('download_file', file), r => `${r.bytes} bytes, ${r.mimeType}`);
      if (await step('editor connect', async () => { await adapter.connect({ baseUrl, projectId }); return waitReady(adapter, { baseUrl, projectId }, 90_000); }, m => m)) {
        await step('browser editor read', () => adapter.read({ baseUrl, projectId }, filePath), r => `same as connector=${r.content === read?.content}`);
      }
    }
    await step('monitor_project_history', () => call('monitor_project_history', { projectId }), r => `${r.updates.length} Updates`);
  } else console.log('FAIL  No readable project found');
  console.log(summary());
}
