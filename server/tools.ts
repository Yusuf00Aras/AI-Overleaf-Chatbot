import { z } from 'zod';
import { UserError, projectIdSchema, projectNameSchema, workspaceScopeSchema, scopeSchema, type WorkspaceScope } from './policy.js';
import type { OverleafAdapter } from './overleaf.js';
import { CAPABILITIES, decodeBinary, projectPath } from './full-api.js';
import { sectionContent } from './sections.js';

const MAX_BYTES = 512 * 1024;
const id = z.string().regex(/^[a-fA-F0-9]{24}$/);
const path = z.string().min(1).max(300).refine(value => { try { projectPath(value); return true; } catch { return false; } }, 'Ungültiger projekt-relativer Dateipfad.');
const folder = z.union([path, z.literal('')]);
const text = z.string().max(500_000).refine(value => Buffer.byteLength(value) <= MAX_BYTES, 'Text größer als 512 KiB.');
const revision = z.string().min(1).max(2048);
const name = z.string().min(1).max(150).refine(value => projectNameSchema.safeParse(value).success && !['.', '..'].includes(value.trim()), 'Ungültiger Name.');
const position = z.object({ line: z.number().int().min(1), column: z.number().int().min(1) }).strict();
const project = { projectId: id };
const file = { ...project, filePath: path };
const edit = { ...file, content: text, revision };
const writeMode = z.enum(['untracked', 'tracked']).optional();
const schemas = {
  auth_status: z.object({}).strict(),
  list_projects: z.object({ query: z.string().max(200).optional(), includeArchived: z.boolean().optional(), includeTrashed: z.boolean().optional(), sort: z.enum(['lastUpdated', 'name']).optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
  create_project: z.object({ name, template: z.enum(['blank', 'example']).optional() }).strict(),
  clone_project: z.object({ sourceProjectId: id, name }).strict(),
  import_project_zip: z.object({ name, attachmentId: z.string().min(1).max(100), filename: name.optional() }).strict(),
  manage_project: z.object({ ...project, action: z.enum(['rename', 'trash', 'restore', 'archive', 'unarchive', 'delete']), newName: name.optional(), confirmName: name.optional() }).strict(),
  update_project_settings: z.object({ ...project, rootFilePath: path.optional(), compiler: z.enum(['pdflatex', 'latex', 'xelatex', 'lualatex']).optional(), imageName: z.string().min(1).max(150).optional(), spellCheckLanguage: z.string().max(40).optional() }).strict(),
  get_project_tree: z.object(project).strict(),
  read_file: z.object(file).strict(),
  write_file: z.object({ ...edit, writeMode }).strict(),
  create_file: z.object({ ...file, content: text.optional() }).strict(),
  manage_entity: z.object({ ...project, path, action: z.enum(['create_folder', 'rename', 'move', 'delete']), newName: name.optional(), destinationFolderPath: folder.optional(), confirmPath: path.optional() }).strict(),
  upload_file: z.object({ ...file, attachmentId: z.string().min(1).max(100), overwrite: z.boolean().optional(), confirmPath: path.optional() }).strict(),
  download_file: z.object(file).strict(),
  get_sections: z.object(file).strict(),
  get_section_content: z.object({ ...file, sectionId: z.string().min(1).max(100) }).strict(),
  write_section: z.object({ ...edit, sectionId: z.string().min(1).max(100), writeMode }).strict(),
  compile_project: z.object({ ...project, rootFilePath: path.optional(), timeoutMs: z.number().int().min(1000).max(900000).optional() }).strict(),
  stop_compile: z.object(project).strict(),
  list_comments: z.object({ ...project, filePath: path.optional(), status: z.enum(['open', 'resolved', 'all']).optional(), author: z.string().max(200).optional() }).strict(),
  reply_to_comment: z.object({ ...project, threadId: id, content: text.min(1) }).strict(),
  add_comment: z.object({ ...edit, start: position, end: position, expectedText: text.min(1) }).strict(),
  set_comment_status: z.object({ ...file, revision, threadId: id, status: z.enum(['open', 'resolved']) }).strict(),
  monitor_project_history: z.object({ ...project, sinceVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() }).strict(),
  validate_latex: z.object(file).strict(),
  preview_edit: z.object(edit).strict(),
  describe_capabilities: z.object({}).strict(),
  read_document: z.object({ filePath: path, projectId: id.optional() }).strict(),
  write_document: z.object({ filePath: path, content: text, revision }).strict(),
  compile_document: z.object({}).strict(),
};
type ToolName = keyof typeof schemas;
const descriptions: Partial<Record<ToolName, string>> = {
  auth_status: 'Check authentication without exposing cookies, tokens or session secrets.',
  list_projects: 'List accessible projects on the connected instance; optional archived/trashed filters.',
  create_project: 'Create one project. Shared one-attempt budget with clone/import including failures. Does not select it.',
  clone_project: 'Copy any accessible source on this instance. Requires creation permission; does not select it.',
  import_project_zip: 'Import user ZIP attachment by attachmentId. No filesystem or model-supplied binary data.',
  upload_file: 'Upload user attachment by attachmentId into selection. Overwrite requires destructive permission and exact confirmPath; never tracked.',
  download_file: 'Download one file. Chat returns bytes to the user only, not the model.',
  write_file: 'Replace text using exact prior read revision. Selected project/write permission required. Consume revision on failure; no blind retry.',
  write_section: 'Replace section using exact prior document read revision and selected project/write permission.',
  add_comment: 'Anchor comment with UTF-16 positions, exact expectedText and prior read revision. Separate comment permission.',
  set_comment_status: 'Resolve/reopen comment using prior read revision. Separate comment permission.',
  compile_project: 'Compile selected project; returns actual API status. Consumes remote compile allowance.',
  validate_latex: 'Read file and run local static brace/environment checks; not compilation or citation/package verification.',
  preview_edit: 'Read-only bounded diff against prior read revision; re-read to check freshness. No writing.',
  describe_capabilities: 'Local support/caveat table, permissions and protocol caveats. No remote calls.',
  read_document: 'Legacy alias of read_file (document-bound revision when the connector is available); optional projectId defaults to selection.',
  write_document: 'Legacy alias of untracked write_file with selected project, write permission and prior read revision.',
  compile_document: 'Legacy alias of compile_project for the selected project.',
};
export const toolDefinitions = (Object.keys(schemas) as ToolName[]).map(name => ({ name,
  description: descriptions[name] ?? `${name}: same connected instance; mutations require explicit permissions and selected project. No blind retry.`,
  inputSchema: z.toJSONSchema(schemas[name], { target: 'draft-7' }) as { type: 'object'; properties: Record<string, unknown>; [key: string]: unknown },
}));
export const canonicalToolDefinitions = toolDefinitions.filter(tool => (CAPABILITIES as readonly string[]).includes(tool.name));
export const attachmentSchema = z.object({ id: z.string().min(1).max(100), name, dataBase64: z.string().max(4 * Math.ceil(MAX_BYTES / 3)).refine(value => {
  try { decodeBinary(value); return true; } catch { return false; }
}, 'Ungültiges Base64 oder Anhang größer als 512 KiB.') }).strict();
export const attachmentsSchema = z.array(attachmentSchema).max(3).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Anhang-IDs müssen eindeutig sein.');
export interface ProposalSummary { title: string; target: string; destructive: boolean; diff?: string; truncated?: boolean }
export interface Proposal { tool: string; args: Record<string, unknown>; summary: ProposalSummary }
export interface ToolOptions {
  allowManageProjects?: boolean;
  allowDestructive?: boolean;
  allowComments?: boolean;
  attachments?: { id: string; name: string; dataBase64: string }[];
  /** Larger documents are withheld from the caller; only section reads/writes stay possible. */
  maxContentChars?: number;
  /** When set, text replacements and destructive actions are queued for explicit user confirmation instead of executed. */
  propose?: (proposal: Proposal) => string;
}
const creators = new Set(['create_project', 'clone_project', 'import_project_zip']);
const writers = new Set(['write_file', 'write_section', 'create_file', 'manage_entity', 'upload_file', 'update_project_settings', 'write_document']);
const commenters = new Set(['reply_to_comment', 'add_comment', 'set_comment_status']);
const mutations = new Set([...writers, ...commenters, 'manage_project', 'compile_project', 'stop_compile', 'compile_document']);
const revisionMutations = new Set(['write_file', 'write_section', 'add_comment', 'set_comment_status']);
export function availableTools(scope: WorkspaceScope | undefined, allowWrites: boolean, allowCreateProjects = false, options: ToolOptions = {}) {
  return toolDefinitions.filter(tool => (!creators.has(tool.name) || allowCreateProjects) &&
    (!writers.has(tool.name) || allowWrites) && (!commenters.has(tool.name) || options.allowComments === true) &&
    (tool.name !== 'manage_project' || options.allowManageProjects === true) &&
    (!mutations.has(tool.name) || !!scope?.projectId) &&
    (!['upload_file', 'import_project_zip'].includes(tool.name) || !!options.attachments?.length)).map(tool => {
      const inputSchema = { ...tool.inputSchema, properties: { ...tool.inputSchema.properties } };
      if (!options.allowDestructive && tool.name === 'manage_project') inputSchema.properties.action = { type: 'string', enum: ['rename', 'restore', 'archive', 'unarchive'] };
      if (!options.allowDestructive && tool.name === 'manage_entity') inputSchema.properties.action = { type: 'string', enum: ['create_folder', 'rename', 'move'] };
      if (!options.allowDestructive && tool.name === 'upload_file') inputSchema.properties.overwrite = { type: 'boolean', const: false };
      if (mutations.has(tool.name) && scope?.projectId && 'projectId' in inputSchema.properties) inputSchema.properties.projectId = { type: 'string', const: scope.projectId };
      return { ...tool, inputSchema };
    });
}
export class ToolSession {
  private reads = new Map<string, { revision: string; content?: string; sectionOnly?: boolean }>();
  private creationUsed = false;
  private scope: WorkspaceScope;
  private options: ToolOptions;
  constructor(private adapter: OverleafAdapter, scope: WorkspaceScope, private allowWrites: boolean, private allowCreateProjects = false, options: ToolOptions = {}) {
    this.scope = workspaceScopeSchema.strict().parse(scope);
    this.options = { ...options, attachments: attachmentsSchema.parse(options.attachments ?? []).map(item => ({ ...item })) };
  }
  private selectedScope() {
    if (!this.scope.projectId) throw new UserError('Zuerst ein Projekt ausdrücklich auswählen.');
    return scopeSchema.parse(this.scope);
  }
  private requireRead(projectId: string, filePath: string, revision: unknown, allowSection = false) {
    const read = this.reads.get(`${projectId}:${filePath}`);
    if (!read || read.revision !== revision) throw new UserError('Vor der Änderung muss diese Datei im ausgewählten Projekt in dieser Sitzung gelesen und die zurückgegebene Revision unverändert übergeben werden.');
    if (read.sectionOnly && !allowSection) throw new UserError('Dokument wurde nur abschnittsweise gelesen. Nur write_section mit dieser Revision erlaubt.');
    return read;
  }
  private invalidate(projectId: string) {
    for (const key of this.reads.keys()) if (key.startsWith(`${projectId}:`)) this.reads.delete(key);
  }
  private async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.adapter.execute) throw new UserError('PROTOCOL_UNSUPPORTED: Vollständige API im Adapter nicht verfügbar; nur Legacy-Lesen/Schreiben/Compile und Projektliste/Erstellung unterstützt.');
    return this.adapter.execute(this.scope.baseUrl, name, args);
  }
  private async read(projectId: string, filePath: string) {
    this.reads.delete(`${projectId}:${filePath}`); // Failed fresh reads must not leave an old authorization cached.
    // Legacy aliases share the document-bound connector whenever it is available.
    const result = this.adapter.execute
      ? await this.execute('read_file', { projectId, filePath })
      : await this.adapter.read(scopeSchema.parse({ ...this.scope, projectId }), filePath);
    const parsed = z.object({ content: text, revision }).passthrough().parse(result);
    const max = this.options.maxContentChars;
    if (max !== undefined && parsed.content.length > max) {
      this.reads.set(`${projectId}:${filePath}`, { revision: parsed.revision, sectionOnly: true });
      const { content: _omitted, ...rest } = parsed;
      return { ...rest, contentOmitted: true, contentChars: parsed.content.length,
        message: `LIMIT_EXCEEDED: Dokument (${parsed.content.length} Zeichen) zu groß für den KI-Kontext (Grenze ${max}). Mit get_sections/get_section_content abschnittsweise lesen; nur write_section ist erlaubt.` };
    }
    this.reads.set(`${projectId}:${filePath}`, { revision: parsed.revision, content: parsed.content });
    return result;
  }
  private fullRead(projectId: string, filePath: string) {
    const read = this.reads.get(`${projectId}:${filePath}`);
    if (read?.content === undefined) throw new UserError('Dokument zu groß oder nicht vollständig gelesen; diese Aktion ist nicht verfügbar.');
    return { revision: read.revision, content: read.content };
  }
  private needsConfirmation(name: string, args: Record<string, unknown>) {
    return ['write_file', 'write_section', 'write_document'].includes(name) || (name === 'manage_entity' && args.action === 'delete') ||
      (name === 'upload_file' && args.overwrite === true) || (name === 'manage_project' && ['trash', 'delete'].includes(args.action as string));
  }
  private async summarize(name: string, args: Record<string, unknown>, prior?: { content?: string }): Promise<ProposalSummary> {
    const target = String(args.filePath ?? args.path ?? args.projectId);
    if (name === 'write_section') {
      let before = prior?.content === undefined ? undefined : sectionContent(prior.content, args.sectionId as string).content;
      if (before === undefined) {
        const current = z.object({ revision, content: z.string() }).passthrough().parse(await this.execute('get_section_content', { projectId: args.projectId, filePath: args.filePath, sectionId: args.sectionId }));
        if (current.revision !== args.revision) throw new UserError('REVISION_CONFLICT: Dokument seit dem Lesen geändert. Erneut lesen.');
        before = current.content;
      }
      const diff = previewDiff(before, args.content as string);
      return { title: `Abschnitt ${String(args.sectionId)} ersetzen${args.writeMode === 'tracked' ? ' (nachverfolgt)' : ''}`, target, destructive: false, diff: diff.snippet, truncated: diff.truncated };
    }
    if (['write_file', 'write_document'].includes(name)) {
      const diff = previewDiff(prior!.content!, args.content as string);
      return { title: `Datei ändern${args.writeMode === 'tracked' ? ' (nachverfolgt)' : ''}`, target, destructive: false, diff: diff.snippet, truncated: diff.truncated };
    }
    if (name === 'upload_file') return { title: `Datei mit Anhang überschreiben (${decodeBinary(args.dataBase64).length} Bytes)`, target, destructive: true };
    if (name === 'manage_entity') return { title: 'Datei/Ordner löschen', target, destructive: true };
    return { title: args.action === 'delete' ? `Projekt „${String(args.confirmName)}“ endgültig löschen` : `Projekt „${String(args.confirmName)}“ in den Papierkorb verschieben`, target, destructive: true };
  }
  private async proposeOrExecute(name: string, args: Record<string, unknown>, prior?: { content?: string }, run: () => Promise<unknown> = () => this.execute(name, args)) {
    if (!this.options.propose || !this.needsConfirmation(name, args)) return run();
    const summary = await this.summarize(name, args, prior);
    const proposalId = this.options.propose({ tool: name, args: { ...args }, summary });
    return { pendingUserConfirmation: true, proposalId, ...summary, executed: false,
      message: 'Noch NICHT ausgeführt. Der Nutzer muss diese Änderung in der Oberfläche bestätigen. Nicht erneut vorschlagen oder wiederholen; vor weiteren Änderungen an dieser Datei Bestätigung abwarten und neu lesen.' };
  }
  async call(name: string, input: unknown): Promise<unknown> {
    if (!Object.hasOwn(schemas, name)) throw new UserError('Unbekanntes Werkzeug.');
    if (creators.has(name) && !this.allowCreateProjects) throw new UserError('Projekterstellung nicht freigegeben.');
    if (writers.has(name) && !this.allowWrites) throw new UserError('Schreibzugriff nicht freigegeben.');
    if (commenters.has(name) && !this.options.allowComments) throw new UserError('Kommentare nicht freigegeben.');
    if (name === 'manage_project' && !this.options.allowManageProjects) throw new UserError('Projektverwaltung nicht freigegeben.');
    const args = schemas[name as ToolName].parse(input) as Record<string, unknown>;
    for (const field of ['projectId', 'sourceProjectId']) if (args[field] !== undefined) args[field] = projectIdSchema.parse(args[field]);
    for (const field of ['name', 'newName', 'filename']) if (args[field] !== undefined) args[field] = projectNameSchema.parse(args[field]);
    if (mutations.has(name)) {
      const selected = this.selectedScope();
      if (args.projectId !== undefined && args.projectId !== selected.projectId) throw new UserError('Änderungen nur im ausdrücklich ausgewählten Projekt erlaubt.');
    }
    if (name === 'describe_capabilities') return { canonicalTools: CAPABILITIES, support: [
      { feature: 'Canonical 24 tools', supported: !!this.adapter.execute, caveat: 'Private API; instance/protocol dependent. No mutation retries.' },
      { feature: 'Legacy tools', supported: true, caveat: this.adapter.execute ? 'Aliases of read_file/write_file (untracked)/compile_project with document-bound revisions.' : 'Browser editor fallback with content revisions; no tracked changes.' },
      { feature: 'Cross-project reads/clone source', supported: true, caveat: 'Same instance only; mutations never change selection.' },
      { feature: 'ShareJS/tracked writes', supported: !!this.adapter.execute, caveat: 'Explicit writeMode; tracked writes verified by reread ranges, otherwise PARTIAL_RESULT. No untracked fallback.' },
      { feature: 'HistoryOT writes/comments', supported: !!this.adapter.execute, caveat: 'Text operations, tracked changes, comment anchors and status via History-OT; verified by reread. Not live-validated on every instance version.' },
      { feature: 'Static validation/preview', supported: true, caveat: 'Single-file checks, not compilation or citation verification.' },
      { feature: 'User confirmation', supported: !!this.options.propose, caveat: 'Text replacements and destructive actions are queued until the user confirms them in the UI.' },
      { feature: 'Binary attachments', supported: !!this.options.attachments?.length, caveat: 'User attachmentId only; max 3 × 512 KiB. No filesystem; gateway has no attachment ingress and returns no download bytes.' },
    ], permissions: { allowWrites: this.allowWrites, allowCreateProjects: this.allowCreateProjects, allowManageProjects: this.options.allowManageProjects === true, allowDestructive: this.options.allowDestructive === true, allowComments: this.options.allowComments === true, selectedProjectId: this.scope.projectId ?? null } };
    if (name === 'auth_status') {
      const result = z.object({ authenticated: z.boolean() }).passthrough().parse(await this.execute(name, args));
      return { authenticated: result.authenticated, persistence: 'memory-only' };
    }
    if (name === 'list_projects') {
      if (this.adapter.execute) return this.execute(name, args);
      const result = await this.adapter.listProjects(this.scope.baseUrl);
      if (!Object.keys(args).length) return result;
      const projects = result.projects.filter(p => p.name.toLocaleLowerCase().includes(String(args.query ?? '').toLocaleLowerCase()));
      if (args.sort === 'name') projects.sort((a, b) => a.name.localeCompare(b.name));
      return { projects: projects.slice(0, Number(args.limit ?? 50)), totalMatched: projects.length, totalProjects: result.projects.length, caveat: 'Legacy catalog: active projects only; archived/trashed/lastUpdated unavailable.' };
    }
    if (creators.has(name)) {
      if (this.creationUsed) throw new UserError('Projekterstellung bereits verbraucht. Projektliste prüfen; nicht erneut versuchen.');
      this.creationUsed = true;
      // Report missing/invalid user attachments explicitly, while still consuming the attempt.
      if (name === 'import_project_zip') this.resolveAttachment(args, true);
      try {
        if (this.adapter.execute) return await this.execute(name, args);
        if (name !== 'create_project' || (args.template !== undefined && args.template !== 'blank')) throw new UserError('PROTOCOL_UNSUPPORTED');
        return await this.adapter.createProject(this.scope.baseUrl, args.name as string);
      } catch { throw new UserError('Projekterstellung nicht bestätigt. Projektliste prüfen; nicht erneut versuchen.'); }
    }
    if (name === 'read_document') return this.read((args.projectId as string | undefined) ?? this.selectedScope().projectId, args.filePath as string);
    if (name === 'read_file') return this.read(args.projectId as string, args.filePath as string);
    if (name === 'write_document') {
      const scope = this.selectedScope(), filePath = args.filePath as string;
      const prior = this.requireRead(scope.projectId, filePath, args.revision);
      this.reads.delete(`${scope.projectId}:${filePath}`);
      const canonical = { projectId: scope.projectId, filePath, content: args.content, revision: args.revision };
      if (this.adapter.execute) return this.proposeOrExecute('write_file', canonical, prior);
      return this.proposeOrExecute('write_document', canonical, prior, async () => {
        const result = await this.adapter.write(scope, filePath, args.content as string, args.revision as string);
        return { filePath: result.filePath, revision: result.revision, message: 'Editor-Inhalt geändert. Synchronisierung in Overleaf prüfen.' };
      });
    }
    if (name === 'compile_document') return this.adapter.execute ? this.execute('compile_project', { projectId: this.selectedScope().projectId }) : this.adapter.compile(this.selectedScope());
    if (name === 'validate_latex') {
      await this.read(args.projectId as string, args.filePath as string);
      const read = this.fullRead(args.projectId as string, args.filePath as string);
      return { projectId: args.projectId, filePath: args.filePath, revision: read.revision, ...validateLatex(read.content), caveat: 'Lokale statische Prüfung, keine Kompilierung; Pakete, Includes und Zitate nicht verifiziert.' };
    }
    if (name === 'preview_edit') {
      const projectId = args.projectId as string, filePath = args.filePath as string;
      const prior = this.requireRead(projectId, filePath, args.revision);
      await this.read(projectId, filePath);
      const fresh = this.fullRead(projectId, filePath);
      if (fresh.revision !== prior.revision || fresh.content !== prior.content) {
        this.reads.delete(`${projectId}:${filePath}`);
        throw new UserError('REVISION_CONFLICT: Vorschau veraltet; Datei erneut lesen.');
      }
      return { projectId, filePath, revision: fresh.revision, ...previewDiff(fresh.content, args.content as string), writing: false };
    }
    if (name === 'manage_project') {
      if (['trash', 'delete'].includes(args.action as string) && !this.options.allowDestructive) throw new UserError('Destruktive Aktionen nicht freigegeben.');
      if (args.action === 'rename' && !args.newName) throw new UserError('newName erforderlich.');
      if (['trash', 'archive', 'delete'].includes(args.action as string)) {
        if (args.confirmName === undefined) throw new UserError('CONFIRMATION_MISMATCH: Aktuellen Projektnamen exakt bestätigen.');
        const result = z.object({ projects: z.array(z.object({ projectId: id, name: z.string() }).passthrough()) }).passthrough().parse(await this.execute('list_projects', { includeArchived: true, includeTrashed: true, limit: 200 }));
        const current = result.projects.find(p => p.projectId.toLowerCase() === args.projectId);
        if (!current || args.confirmName !== current.name) throw new UserError('CONFIRMATION_MISMATCH: Aktuellen Projektnamen exakt bestätigen.');
      }
    }
    if (name === 'manage_entity') {
      if (args.action === 'delete' && (!this.options.allowDestructive || args.confirmPath !== args.path)) throw new UserError('Destruktive Aktionen benötigen Freigabe und exakten confirmPath.');
      if (args.action === 'rename' && !args.newName) throw new UserError('newName erforderlich.');
      if (args.action === 'move' && args.destinationFolderPath === undefined) throw new UserError('destinationFolderPath erforderlich.');
    }
    if (name === 'update_project_settings' && Object.keys(args).length === 1) throw new UserError('Mindestens eine Einstellung erforderlich.');
    if (name === 'upload_file') {
      if (args.overwrite && (!this.options.allowDestructive || args.confirmPath !== args.filePath)) throw new UserError('Überschreiben benötigt destruktive Freigabe und exakten confirmPath.');
      this.resolveAttachment(args);
    }
    if (revisionMutations.has(name)) {
      const prior = this.requireRead(args.projectId as string, args.filePath as string, args.revision, name === 'write_section');
      this.reads.delete(`${args.projectId}:${args.filePath}`);
      return this.proposeOrExecute(name, args, prior);
    }
    if (mutations.has(name)) this.invalidate(args.projectId as string);
    if (['get_sections', 'get_section_content'].includes(name)) {
      const result = await this.execute(name, args);
      const parsed = z.object({ revision }).passthrough().safeParse(result);
      const key = `${args.projectId}:${args.filePath}`;
      // Section reads authorize only write_section for the same document revision.
      if (parsed.success && this.reads.get(key)?.revision !== parsed.data.revision) this.reads.set(key, { revision: parsed.data.revision, sectionOnly: true });
      return result;
    }
    return this.proposeOrExecute(name, args);
  }
  private resolveAttachment(args: Record<string, unknown>, zip = false) {
    const attachment = this.options.attachments?.find(item => item.id === args.attachmentId);
    if (!attachment) throw new UserError('Kein Benutzer-Anhang verfügbar. Gateway unterstützt keine Anhang-Uploads.');
    if (zip) {
      args.filename ??= attachment.name;
      const bytes = decodeBinary(attachment.dataBase64);
      if (!/\.zip$/i.test(args.filename as string) || bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new UserError('ZIP-Anhang erforderlich.');
    }
    delete args.attachmentId;
    args.dataBase64 = attachment.dataBase64;
  }
  dispose() { this.reads.clear(); this.options.attachments = []; }
}

export function validateLatex(content: string) {
  const issues: { line: number; message: string }[] = [];
  const braces: number[] = [], environments: { name: string; line: number }[] = [];
  const add = (line: number, message: string) => { if (issues.length < 50) issues.push({ line, message }); };
  const tokens = /\\(begin|end)\s*\{([^{}\r\n]{1,150})\}|\\verb\*?([^a-zA-Z\s])/y;
  let line = 1, literal: string | undefined;
  for (let index = 0; index < content.length; index++) {
    const char = content[index]!;
    if (char === '\n') { line++; continue; }
    if (literal) {
      const close = `\\end{${literal}}`;
      if (content.startsWith(close, index)) { environments.pop(); literal = undefined; index += close.length - 1; }
      continue;
    }
    if (char === '%') {
      const newline = content.indexOf('\n', index);
      index = newline < 0 ? content.length : newline - 1;
      continue;
    }
    if (char === '\\') {
      tokens.lastIndex = index;
      const token = tokens.exec(content);
      if (!token) {
        if (content[index + 1] === '\n') line++;
        index++; // Escaped braces/percent/backslash are not syntax tokens.
        continue;
      }
      const tokenLine = line;
      line += (token[0].match(/\n/g) ?? []).length;
      index += token[0].length - 1;
      if (token[3]) {
        const end = content.indexOf(token[3], index + 1), newline = content.indexOf('\n', index + 1);
        if (end < 0 || (newline >= 0 && end > newline)) add(tokenLine, 'Nicht geschlossenes Inline-Verbatim.');
        index = end >= 0 && (newline < 0 || end < newline) ? end : newline >= 0 ? newline - 1 : content.length;
      } else if (token[1] === 'begin') {
        environments.push({ name: token[2]!, line: tokenLine });
        if (/^(verbatim\*?|lstlisting|minted)$/.test(token[2]!)) literal = token[2];
      } else if (environments.at(-1)?.name === token[2]) environments.pop();
      else add(tokenLine, `Nicht passende Umgebung: end{${token[2]!.slice(0, 100)}}.`);
    } else if (char === '{') braces.push(line);
    else if (char === '}') {
      if (braces.length) braces.pop();
      else add(line, 'Schließende Klammer ohne Öffnung.');
    }
  }
  for (const line of braces.slice(0, 50)) add(line, 'Nicht geschlossene Klammer.');
  for (const open of environments.slice(0, 50)) add(open.line, `Nicht geschlossene Umgebung: ${open.name.slice(0, 100)}.`);
  return { check: 'static-only', issues, passedStaticChecks: issues.length === 0, compiled: false };
}
export function previewDiff(before: string, after: string) {
  const a = before.split('\n'), b = after.split('\n');
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - end - 1] === b[b.length - end - 1]) end++;
  const removed = a.slice(start, a.length - end), added = b.slice(start, b.length - end);
  const all = [...removed.map(line => '-' + line), ...added.map(line => '+' + line)];
  const snippet = [`@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`, ...all.slice(0, 40).map(line => line.slice(0, 200))].join('\n').slice(0, 6000);
  return { changed: before !== after, removedLines: removed.length, addedLines: added.length, beforeBytes: Buffer.byteLength(before), afterBytes: Buffer.byteLength(after), snippet, truncated: all.length > 40 || all.some(line => line.length > 200) || snippet.length >= 6000, caveat: 'Single replacement-region diff, not minimal multi-hunk diff.' };
}