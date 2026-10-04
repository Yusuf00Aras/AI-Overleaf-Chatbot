import type { BrowserOverleaf } from '../server/overleaf.js';
import { ToolSession } from '../server/tools.js';
import { describe, stepper } from './live-common.js';

/** Permanently deletes only trashed projects whose name starts with "Studio-Livetest" (explicitly approved by the user). */
export async function purgeCheck(adapter: BrowserOverleaf, baseUrl: string) {
  const { step, summary } = stepper();
  const listAll = async () => (await new ToolSession(adapter, { baseUrl }, false).call('list_projects', { includeArchived: true, includeTrashed: true, limit: 200 }) as any).projects as any[];
  const targets = await step('find trashed Studio-Livetest projects', async () => (await listAll()).filter(p => p.trashed && p.name.startsWith('Studio-Livetest')), r => `${r.length} projects`);
  for (const [index, project] of (targets ?? []).entries()) {
    const session = new ToolSession(adapter, { baseUrl, projectId: project.projectId }, false, false, { allowManageProjects: true, allowDestructive: true });
    if (index === 0) await step('delete with wrong confirmName refused', async () => {
      try { await session.call('manage_project', { projectId: project.projectId, action: 'delete', confirmName: `${project.name} wrong` }); }
      catch (error) { return describe(error).slice(0, 80); }
      throw new Error('Deletion executed without exact confirmation');
    }, m => m);
    await step(`delete ${project.projectId}`, () => session.call('manage_project', { projectId: project.projectId, action: 'delete', confirmName: project.name }) as Promise<any>, r => `confirmed=${r.confirmed}`);
  }
  const ids = new Set((targets ?? []).map(p => p.projectId));
  await step('verify gone, others untouched', async () => {
    const remaining = await listAll();
    if (remaining.some(p => ids.has(p.projectId))) throw new Error('Project still exists');
    return `${remaining.length} projects left: ${remaining.map(p => p.name).join(', ')}`;
  }, m => m);
  console.log(summary());
}
export const run = purgeCheck;
