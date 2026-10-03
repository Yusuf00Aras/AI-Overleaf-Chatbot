import { randomBytes } from 'node:crypto';
import type { APIResponse, BrowserContext } from 'playwright';
import { UserError, instanceUrl } from './policy.js';
import { MAX_BYTES, ProjectSocket, assertSupportedProtocol, checkRevision, documentRevision, historyTextOperation, id, lf, object,
  snapshotToVisible, textOperation, trackedChangeObserved, treeEntities, visibleToSnapshot, type Entity, type ProjectClient, type SocketDocument } from './project-socket.js';
import { parseSections, replaceSection, sectionContent } from './sections.js';

export const CAPABILITIES = ['auth_status', 'list_projects', 'create_project', 'clone_project', 'import_project_zip',
  'manage_project', 'update_project_settings', 'get_project_tree', 'read_file', 'write_file', 'create_file',
  'manage_entity', 'upload_file', 'download_file', 'get_sections', 'get_section_content', 'write_section',
  'compile_project', 'stop_compile', 'list_comments', 'reply_to_comment', 'add_comment', 'set_comment_status',
  'monitor_project_history'] as const;
export type ProjectProvider = (context: BrowserContext, baseUrl: string, projectId: string) => Promise<ProjectClient>;
function string(value: unknown, max = 500000, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.length)) throw new UserError('INVALID_ARGUMENT: Text fehlt oder überschreitet das Limit.');
  return value;
}
function choice<T extends string>(value: unknown, options: readonly T[]): T {
  if (!options.includes(value as T)) throw new UserError('INVALID_ARGUMENT: Unzulässiger Optionswert.');
  return value as T;
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new UserError('INVALID_ARGUMENT: Ganzzahl außerhalb des Limits.');
  return value as number;
}
function bool(value: unknown, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new UserError('INVALID_ARGUMENT: Boolean erforderlich.');
  return value;
}
function name(value: unknown): string {
  const result = string(value, 150);
  if (!result.trim() || /[/\\\x00-\x1f\x7f-\x9f]/.test(result) || ['.', '..'].includes(result)) throw new UserError('INVALID_ARGUMENT: Ungültiger Name.');
  return result;
}
export function projectPath(value: unknown, allowRoot = false): string {
  const result = string(value, 300, allowRoot);
  if (allowRoot && result === '') return result;
  if (/[:\\\x00-\x1f\x7f]/.test(result) || result.split('/').some(part => !part || part === '.' || part === '..' || part.length > 150)) throw new UserError('INVALID_ARGUMENT: Nur sichere projekt-relative Pfade erlaubt.');
  return result;
}
function text(value: unknown, empty = true): string {
  const result = lf(string(value, 500000, empty));
  if (Buffer.byteLength(result) > MAX_BYTES) throw new UserError('LIMIT_EXCEEDED: Text überschreitet 512 KiB.');
  return result;
}
export function decodeBinary(value: unknown): Buffer {
  const encoded = string(value, 4 * Math.ceil(MAX_BYTES / 3), true);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new UserError('INVALID_ARGUMENT: Ungültiges Base64.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_BYTES || bytes.toString('base64') !== encoded) throw new UserError('LIMIT_EXCEEDED: Binärdaten ungültig oder größer als 512 KiB.');
  return bytes;
}
export function positionOffset(content: string, value: unknown): number {
  const pos = object(value), line = integer(pos.line, 1, content.length + 1), column = integer(pos.column, 1, content.length + 1);
  const lines = content.split('\n');
  if (line > lines.length || column > lines[line - 1]!.length + 1) throw new UserError('INVALID_ARGUMENT: UTF-16-Position außerhalb des Dokuments.');
  const offset = lines.slice(0, line - 1).reduce((total, item) => total + item.length + 1, 0) + column - 1;
  if (offset > 0 && offset < content.length && /[\uD800-\uDBFF]/.test(content[offset - 1]!) && /[\uDC00-\uDFFF]/.test(content[offset]!)) throw new UserError('INVALID_ARGUMENT: Position teilt ein Unicode-Zeichen.');
  return offset;
}
function position(content: string, offset: number): { line: number; column: number } {
  const prefix = content.slice(0, offset), lines = prefix.split('\n');
  return { line: lines.length, column: lines.at(-1)!.length + 1 };
}
/** `Retry-After` is whole seconds or an HTTP date; anything else (or more than an hour) gives no hint. */
export function retryAfterMs(header: string | undefined, now = Date.now()): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  const ms = /^\d{1,7}$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) && ms >= 0 && ms <= 3_600_000 ? Math.ceil(ms) : undefined;
}
function rateLimited(header: string | undefined): string {
  const wait = retryAfterMs(header);
  return `RATE_LIMITED: Overleaf-Anfragelimit erreicht. ${wait === undefined ? 'Kurz warten' : `Mindestens ${Math.ceil(wait / 1000)} s warten (retryAfterMs=${wait})`}; Änderungen nicht blind wiederholen.`;
}
export interface CommentRange { threadId: string; start: number; end: number; resolved?: boolean }
export function commentRanges(doc: SocketDocument): CommentRange[] {
  if (doc.protocol === 'history-ot') {
    const snapshot = doc.snapshot ?? {};
    const raw: unknown[] = Array.isArray(snapshot.comments) ? snapshot.comments : [];
    return raw.flatMap((item: any) => (Array.isArray(item?.ranges) ? item.ranges : []).flatMap((range: any) => {
      if (!Number.isSafeInteger(range?.pos) || !Number.isSafeInteger(range?.length) || range.pos < 0 || range.length < 0 || range.pos + range.length > snapshot.content.length) return [];
      return [{ threadId: id(item.id), start: snapshotToVisible(snapshot, range.pos), end: snapshotToVisible(snapshot, range.pos + range.length), ...(typeof item.resolved === 'boolean' ? { resolved: item.resolved } : {}) }];
    }));
  }
  const raw = doc.ranges == null ? [] : object(doc.ranges).comments ?? [];
  if (!Array.isArray(raw)) throw new UserError('PROTOCOL_UNSUPPORTED: Kommentarbereiche ungültig.');
  return raw.flatMap(item => {
    const range = object(item), op = range.op;
    if (!op || typeof op.c !== 'string' || !Number.isSafeInteger(op.p) || op.p < 0 || op.p + op.c.length > doc.content.length) return [];
    return [{ threadId: id(op.t ?? range.id), start: op.p, end: op.p + op.c.length, ...(typeof range.resolved === 'boolean' ? { resolved: range.resolved } : {}) }];
  });
}

/** Independent private web API. Each execute bootstraps auth from the connected RAM-only browser context.
 * No filesystem, external MCP client, auth store, response logging, redirects or mutation retries.
 * The optional provider exists for isolated protocol tests, not for sharing auth across instances.
 */
export class FullOverleafApi {
  private readonly baseUrl: string;
  constructor(private readonly context: BrowserContext, baseUrl: string,
    private readonly provider: ProjectProvider = (context, origin, projectId) => ProjectSocket.open(context, origin, projectId)) {
    this.baseUrl = instanceUrl(baseUrl);
  }
  async execute(tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (!(CAPABILITIES as readonly string[]).includes(tool)) throw new UserError('INVALID_ARGUMENT: Unbekannte Overleaf-Funktion.');
    object(args);
    if (['localPath', 'localZipPath', 'cookie', 'cookies', 'session', 'baseUrl'].some(key => key in args)) throw new UserError('INVALID_ARGUMENT: Lokale Dateisystem-/Auth-Zugriffe und Origin-Overrides sind gesperrt.');
    // Caller-owned state remains local to this operation, even if the class is reused concurrently.
    const auth = await this.bootstrap();
    const request = (path: string, method = 'GET', body?: Record<string, unknown>, multipart?: Record<string, any>, timeout = 30000) =>
      this.request(path, method, auth.csrf, body, multipart, timeout);
    const json = async (path: string, method = 'GET', body?: Record<string, unknown>, multipart?: Record<string, any>, timeout?: number) => {
      const { bytes, mimeType } = await request(path, method, body, multipart, timeout);
      // Some mutations answer `200 text/plain "OK"`; their outcome is verified separately.
      if (!bytes.length || (method !== 'GET' && !/json/i.test(mimeType))) return {};
      try { return JSON.parse(bytes.toString('utf8')) as unknown; } catch { throw new UserError('PROTOCOL_UNSUPPORTED: Ungültige JSON-Antwort.'); }
    };
    const catalog = async () => {
      const response = object(await json('/api/project', 'POST', {}));
      if (!Array.isArray(response.projects) || (response.totalSize !== undefined && response.totalSize !== response.projects.length)) throw new UserError('PROTOCOL_UNSUPPORTED: Projektliste nicht vollständig.');
      return response.projects.map((raw: unknown) => {
        const p = object(raw), projectId = id(p.id ?? p._id);
        return { projectId, id: projectId, name: name(p.name), archived: bool(p.archived), trashed: bool(p.trashed),
          accessLevel: string(p.accessLevel ?? 'unknown', 100), ...(p.lastUpdated ? { lastUpdated: string(p.lastUpdated, 100) } : {}), url: `${this.baseUrl}/project/${projectId}` };
      });
    };
    const use = async <T>(projectId: string, callback: (client: ProjectClient) => Promise<T>): Promise<T> => {
      let client: ProjectClient | undefined;
      try {
        client = await this.provider(this.context, this.baseUrl, projectId);
        if (id(client.project._id) !== projectId) throw new UserError('PROTOCOL_UNSUPPORTED: Falsche Projektidentität.');
        return await callback(client);
      } catch (error) { throw error instanceof UserError ? error : new UserError('PROTOCOL_UNSUPPORTED: Projekt-Socket konnte nicht verarbeitet werden.'); }
      finally { client?.close(); }
    };
    const entity = (client: ProjectClient, filePath: string, type?: Entity['type']) => {
      const found = treeEntities(client.project).entities.find(item => item.filePath === filePath && (!type || item.type === type));
      if (!found) throw new UserError('NOT_FOUND: Entität nicht gefunden oder falscher Typ.');
      return found;
    };
    const folder = (client: ProjectClient, filePath: string) => filePath ? entity(client, filePath, 'folder').id : treeEntities(client.project).rootFolderId;
    const tree = (client: ProjectClient) => {
      const parsed = treeEntities(client.project), p = client.project;
      const state = p.trackChangesState;
      const trackChangesActive = state === true || (state && typeof state === 'object' && state[auth.userId] === true) || false;
      return { projectId: id(p._id), ...parsed, rootDocPath: parsed.entities.find(item => item.id === p.rootDoc_id)?.filePath,
        compiler: typeof p.compiler === 'string' ? p.compiler : undefined, imageName: typeof p.imageName === 'string' ? p.imageName : undefined,
        spellCheckLanguage: typeof p.spellCheckLanguage === 'string' ? p.spellCheckLanguage : undefined, trackChangesActive };
    };
    const read = async (client: ProjectClient, path: string) => client.joinDoc(entity(client, path, 'doc').id);
    const reread = async (client: ProjectClient, doc: SocketDocument) => { await client.leaveDoc(doc.docId); return client.joinDoc(doc.docId); };
    const documentResult = (projectId: string, filePath: string, doc: SocketDocument) => ({ projectId, filePath, docId: doc.docId,
      content: doc.content, protocol: doc.protocol, version: doc.version, revision: documentRevision(projectId, doc) });
    const write = async (projectId: string, client: ProjectClient, path: string, doc: SocketDocument, content: string, revision: unknown, mode: unknown) => {
      checkRevision(revision, projectId, doc);
      assertSupportedProtocol(doc);
      const writeMode = choice(mode ?? 'untracked', ['untracked', 'tracked'] as const);
      // Reserve envelope space before submission, including JSON escaping of document contents.
      if (Buffer.byteLength(JSON.stringify({ ...documentResult(projectId, path, { ...doc, content }), writeMode })) > MAX_BYTES - 1024) throw new UserError('LIMIT_EXCEEDED: Schreibresultat überschreitet 512 KiB; keine Änderung ausgeführt.');
      const history = doc.protocol === 'history-ot', tracked = writeMode === 'tracked';
      if (tracked && !history) {
        // Instances without the review API (e.g. Community Edition) silently ignore tracking metadata.
        try { await threads(projectId); }
        catch (error) {
          if (error instanceof UserError && error.message.startsWith('PROTOCOL_UNSUPPORTED')) throw new UserError('PROTOCOL_UNSUPPORTED: Nachverfolgte Änderungen auf dieser Instanz nicht verfügbar (keine Review-Funktion); keine Änderung ausgeführt.');
          throw error;
        }
      }
      // History-OT carries tracking inline per component; ShareJS uses update metadata. Never downgrade either.
      const op = history ? historyTextOperation(doc.snapshot!, doc.content, content, tracked ? { userId: auth.userId, ts: new Date().toISOString() } : undefined) : textOperation(doc.content, content);
      if (op.length) await client.apply(doc, op, tracked && !history ? { tc: auth.userId } : undefined);
      const observed = op.length ? await reread(client, doc) : doc;
      if (observed.content !== content || observed.protocol !== doc.protocol || (op.length && observed.version <= doc.version)) throw new UserError('OUTCOME_UNKNOWN: Schreibänderung nicht vollständig bestätigt. Nicht wiederholen.');
      if (tracked && op.length && !trackedChangeObserved(doc, observed, auth.userId)) throw new UserError('PARTIAL_RESULT: Text geändert und bestätigt, nachverfolgte Änderung aber nicht beobachtet. Nicht wiederholen; in Overleaf prüfen.');
      return { ...documentResult(projectId, path, observed), writeMode, trackChangesActive: tree(client).trackChangesActive,
        verification: op.length ? 'ack-applied-reread' : 'unchanged', trackingMetadataSubmitted: tracked && op.length > 0,
        ...(tracked && op.length ? { trackingVerified: true } : {}) };
    };
    const created = async (route: string, body?: Record<string, unknown>, form?: Record<string, any>) => {
      const result = object(await json(route, 'POST', body, form));
      if (result.success === false) throw new UserError('REMOTE_ERROR: Projekterstellung abgelehnt.');
      if (typeof result.project_id !== 'string') throw new UserError('OUTCOME_UNKNOWN: Projekterstellung nicht bestätigt. Projektliste prüfen; nicht wiederholen.');
      const projectId = id(result.project_id);
      // Creation is already confirmed by its returned ID. Do not turn a follow-up tree failure into a retry.
      return { projectId, name: name(args.name), url: `${this.baseUrl}/project/${projectId}`, confirmation: 'api-response' };
    };
    const threads = async (projectId: string) => {
      try { return object(await json(`/project/${projectId}/threads`)); }
      catch (error) {
        if (error instanceof UserError && /Status 404/.test(error.message)) throw new UserError('PROTOCOL_UNSUPPORTED: Kommentar-Threads auf dieser Instanz nicht verfügbar (HTTP 404, z. B. Community Edition ohne Review-Funktion).');
        throw error;
      }
    };
    const messageView = (raw: unknown) => {
      const m = object(raw);
      return { id: typeof m.id === 'string' ? m.id : undefined, content: text(m.content ?? ''),
        timestamp: typeof m.timestamp === 'string' || typeof m.timestamp === 'number' ? m.timestamp : undefined,
        userId: typeof m.user_id === 'string' ? m.user_id : undefined,
        author: m.user && typeof m.user.name === 'string' ? m.user.name : undefined };
    };
    const result = await (async (): Promise<unknown> => {
      if (tool === 'auth_status') return { authenticated: true, userId: auth.userId, persistence: 'memory-only' };
      if (tool === 'list_projects') {
        const all = await catalog();
        const query = args.query === undefined ? '' : string(args.query, 200, true).toLocaleLowerCase();
        const includeArchived = bool(args.includeArchived), includeTrashed = bool(args.includeTrashed);
        const filtered = all.filter(p => (includeArchived || !p.archived) && (includeTrashed || !p.trashed) && p.name.toLocaleLowerCase().includes(query));
        const sort = choice(args.sort ?? 'lastUpdated', ['lastUpdated', 'name']);
        filtered.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : (b.lastUpdated ?? '').localeCompare(a.lastUpdated ?? '') || a.name.localeCompare(b.name));
        return { projects: filtered.slice(0, integer(args.limit ?? 50, 1, 200)), totalMatched: filtered.length, totalProjects: all.length };
      }
      if (tool === 'create_project') return created('/project/new', { projectName: name(args.name), template: choice(args.template ?? 'blank', ['blank', 'example']) === 'blank' ? 'none' : 'example' });
      if (tool === 'clone_project') return created(`/Project/${id(args.sourceProjectId)}/clone`, { projectName: name(args.name) });
      if (tool === 'import_project_zip') {
        const filename = name(args.filename ?? 'project.zip'), bytes = decodeBinary(args.dataBase64);
        if (!/\.zip$/i.test(filename) || bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new UserError('INVALID_ARGUMENT: ZIP-Datei erforderlich.');
        return created('/project/new/upload', undefined, { name: name(args.name), qqfile: { name: filename, mimeType: 'application/zip', buffer: bytes } });
      }
      const projectId = id(args.projectId);
      const prefix = `/project/${projectId}`;
      if (tool === 'manage_project') {
        const action = choice(args.action, ['rename', 'trash', 'restore', 'archive', 'unarchive', 'delete']);
        const current = (await catalog()).find(p => p.projectId === projectId);
        if (!current) throw new UserError('NOT_FOUND: Projekt nicht gefunden.');
        if (['trash', 'archive', 'delete'].includes(action) && args.confirmName !== current.name) throw new UserError('CONFIRMATION_MISMATCH: Aktuellen Projektnamen exakt bestätigen.');
        if (action === 'delete' && !current.trashed) throw new UserError('INVALID_ARGUMENT: Permanentes Löschen nur aus dem Papierkorb.');
        const newName = action === 'rename' ? name(args.newName) : current.name;
        if (action === 'rename') await json(`${prefix}/rename`, 'POST', { newProjectName: newName });
        else {
          const route = action === 'delete' ? `/Project/${projectId}` : `${['archive', 'unarchive'].includes(action) ? '/Project/' + projectId : prefix}/${['archive', 'unarchive'].includes(action) ? 'archive' : 'trash'}`;
          await json(route, ['restore', 'unarchive', 'delete'].includes(action) ? 'DELETE' : 'POST', {});
        }
        const observed = (await catalog()).find(p => p.projectId === projectId);
        const confirmed = action === 'delete' ? !observed : !!observed && (action === 'rename' ? observed.name === newName : action === 'trash' ? observed.trashed : action === 'restore' ? !observed.trashed : action === 'archive' ? observed.archived : !observed.archived);
        if (!confirmed) throw new UserError('OUTCOME_UNKNOWN: Projektänderung nicht bestätigt. Nicht wiederholen.');
        return { projectId, action, name: newName, confirmed: true };
      }
      if (tool === 'stop_compile') { await json(`${prefix}/compile/stop`, 'POST', {}); return { projectId, requested: true, confirmation: 'http-accepted' }; }
      if (tool === 'monitor_project_history') {
        const since = args.sinceVersion === undefined ? undefined : integer(args.sinceVersion, 0, Number.MAX_SAFE_INTEGER);
        const raw = object(await json(`${prefix}/updates?min_count=25`));
        if (!Array.isArray(raw.updates)) throw new UserError('PROTOCOL_UNSUPPORTED: History-Antwort ungültig.');
        const updates = raw.updates.map((value: unknown) => {
          const u = object(value), m = object(u.meta);
          const fromVersion = integer(u.fromV, 0, Number.MAX_SAFE_INTEGER), toVersion = integer(u.toV, fromVersion, Number.MAX_SAFE_INTEGER);
          return { fromVersion, toVersion, startedAt: new Date(m.start_ts).toISOString(), endedAt: new Date(m.end_ts).toISOString(),
            authors: (m.users ?? []).map((person: any) => person ? { id: id(person.id), displayName: `${string(person.first_name ?? '', 150, true)} ${string(person.last_name ?? '', 150, true)}`.trim() } : null),
            paths: (u.pathnames ?? []).map((p: unknown) => projectPath(p)),
            projectOperations: (u.project_ops ?? []).map((value: unknown) => {
              const operation = object(value), type = operation.add ? 'add' : operation.rename ? 'rename' : operation.remove ? 'remove' : undefined;
              if (!type) throw new UserError('PROTOCOL_UNSUPPORTED: History-Operation unbekannt.');
              const data = object(operation[type]);
              return { type, atVersion: integer(operation.atV, 0, Number.MAX_SAFE_INTEGER), path: projectPath(data.pathname), ...(type === 'rename' ? { newPath: projectPath(data.newPathname) } : {}) };
            }),
            labels: (u.labels ?? []).map((l: any) => ({ id: string(l.id, 200), comment: text(l.comment ?? ''), version: integer(l.version, 0, Number.MAX_SAFE_INTEGER), createdAt: string(l.created_at, 100) })) };
        }).sort((a: any, b: any) => b.toVersion - a.toVersion);
        const currentVersion = updates[0]?.toVersion ?? null;
        return { projectId, currentVersion, nextSinceVersion: currentVersion ?? since ?? null, hasEarlierHistory: raw.nextBeforeTimestamp !== undefined,
          gapDetected: since !== undefined && updates.length > 0 && Math.min(...updates.map((u: any) => u.fromVersion)) > since,
          updates: updates.filter((u: any) => since === undefined || u.toVersion > since) };
      }
      if (tool === 'reply_to_comment') {
        const threadId = id(args.threadId), content = text(args.content, false);
        const before = object((await threads(projectId))[threadId]);
        const existing = (before.messages ?? []).map(messageView);
        let uncertain = false;
        try { await json(`${prefix}/thread/${threadId}/messages`, 'POST', { content }); }
        catch (error) { if (!(error instanceof UserError) || !error.message.startsWith('OUTCOME_UNKNOWN')) throw error; uncertain = true; }
        const after = object((await threads(projectId))[threadId]), messages = (after.messages ?? []).map(messageView);
        const observed = messages.filter((m: ReturnType<typeof messageView>) => m.content === content && m.userId === auth.userId && (m.id ? !existing.some((old: ReturnType<typeof messageView>) => old.id === m.id) : messages.length > existing.length));
        if (observed.length !== 1) throw new UserError('OUTCOME_UNKNOWN: Neue Antwort nicht eindeutig beobachtet; nicht erneut senden.');
        return { threadId, message: observed[0], recoveredAfterTimeout: uncertain, writeMode: 'untracked' };
      }
      if (tool === 'update_project_settings') {
        const settings: Record<string, unknown> = {};
        if (args.compiler !== undefined) settings.compiler = choice(args.compiler, ['pdflatex', 'latex', 'xelatex', 'lualatex']);
        if (args.imageName !== undefined) settings.imageName = string(args.imageName, 150);
        if (args.spellCheckLanguage !== undefined) settings.spellCheckLanguage = string(args.spellCheckLanguage, 40, true);
        if (args.rootFilePath !== undefined) settings.rootDocId = await use(projectId, async client => entity(client, projectPath(args.rootFilePath), 'doc').id);
        if (!Object.keys(settings).length) throw new UserError('INVALID_ARGUMENT: Mindestens eine Einstellung erforderlich.');
        await json(`${prefix}/settings`, 'POST', settings);
        return use(projectId, async client => {
          for (const [key, expected] of Object.entries(settings)) if (client.project[key === 'rootDocId' ? 'rootDoc_id' : key] !== expected) throw new UserError('OUTCOME_UNKNOWN: Einstellung nicht bestätigt.');
          return tree(client);
        });
      }
      return use(projectId, async client => {
        if (tool === 'get_project_tree') return tree(client);
        if (tool === 'compile_project') {
          const root = args.rootFilePath === undefined ? treeEntities(client.project).entities.find(e => e.id === client.project.rootDoc_id && e.type === 'doc') : entity(client, projectPath(args.rootFilePath), 'doc');
          if (!root) throw new UserError('INVALID_ARGUMENT: Kein Wurzeldokument konfiguriert.');
          const compiled = object(await json(`${prefix}/compile`, 'POST', { rootDoc_id: root.id, check: 'silent', incrementalCompilesEnabled: true }, undefined, integer(args.timeoutMs ?? 120000, 1000, 900000)));
          const status = choice(compiled.status, ['success', 'error', 'failure', 'timedout', 'compile-in-progress', 'stopped', 'validation-problems']);
          const outputFiles = (compiled.outputFiles ?? []).map((raw: unknown) => {
            const output = object(raw);
            const url = output.url === undefined ? undefined : this.outputUrl(string(output.url, 2048));
            return { path: output.path === undefined ? undefined : projectPath(output.path), type: output.type === undefined ? undefined : string(output.type, 100), url };
          });
          return { projectId, rootFilePath: root.filePath, status, outputFiles };
        }
        if (tool === 'list_comments') {
          const all = await threads(projectId), status = choice(args.status ?? 'open', ['open', 'resolved', 'all']);
          const author = args.author === undefined ? undefined : string(args.author, 200).toLocaleLowerCase();
          const filePath = args.filePath === undefined ? undefined : projectPath(args.filePath);
          const locations = new Map<string, { filePath: string; doc: SocketDocument; range: CommentRange }>();
          let positionsUnavailable = !filePath;
          // Bounded single-file inspection; no implicit join-all traversal.
          if (filePath) {
            const doc = await read(client, filePath);
            positionsUnavailable = false;
            for (const range of commentRanges(doc)) locations.set(range.threadId, { filePath, doc, range });
          }
          const listed = Object.entries(all).flatMap(([threadId, raw]) => {
            id(threadId);
            const thread = object(raw), messages = (thread.messages ?? []).map(messageView), location = locations.get(threadId);
            const resolved = location?.range.resolved ?? bool(thread.resolved);
            if ((filePath && !location) || (status !== 'all' && resolved !== (status === 'resolved')) || (author && !messages.some((m: ReturnType<typeof messageView>) => [m.author, m.userId].some(v => v?.toLocaleLowerCase().includes(author))))) return [];
            return [{ threadId, status: resolved ? 'resolved' : 'open', messages, ...(location ? { filePath, start: position(location.doc.content, location.range.start), end: position(location.doc.content, location.range.end), quotedText: location.doc.content.slice(location.range.start, location.range.end) } : { unlocated: true }) }];
          });
          return { threads: listed, positionsUnavailable };
        }
        const filePath = projectPath(args.filePath ?? args.path);
        if (tool === 'create_file' || (tool === 'manage_entity' && args.action === 'create_folder')) {
          const parsed = treeEntities(client.project);
          if (parsed.entities.some(e => e.filePath === filePath)) throw new UserError('ALREADY_EXISTS: Zielpfad existiert.');
          const parts = filePath.split('/'), basename = parts.pop()!, parentId = folder(client, parts.join('/'));
          const type = tool === 'create_file' ? 'doc' : 'folder';
          const content = tool === 'create_file' ? text(args.content ?? '') : '';
          if (Buffer.byteLength(JSON.stringify(content)) > MAX_BYTES - 4096) throw new UserError('LIMIT_EXCEEDED: Initialer Dateiinhalt zu groß; keine Erstellung ausgeführt.');
          const createdEntity = object(await json(`${prefix}/${type}`, 'POST', { parent_folder_id: parentId, name: basename }));
          const entityId = id(createdEntity._id ?? createdEntity.id);
          if (content) {
            try {
              const doc = await client.joinDoc(entityId);
              if (doc.content !== '') throw new UserError('OUTCOME_UNKNOWN: Neue Datei ist nicht leer; keine Überschreibung.');
              return await write(projectId, client, filePath, doc, content, documentRevision(projectId, doc), 'untracked');
            } catch {
              throw new UserError(`PARTIAL_RESULT: Datei ${entityId} wurde erstellt; Initialinhalt nicht bestätigt. Datei lesen, Erstellung nicht wiederholen.`);
            }
          }
          return { projectId, filePath, id: entityId, type, confirmation: 'api-response' };
        }
        if (tool === 'manage_entity') {
          const action = choice(args.action, ['rename', 'move', 'delete']), current = entity(client, filePath);
          let destination = filePath;
          if (action === 'delete') {
            if (args.confirmPath !== filePath) throw new UserError('CONFIRMATION_MISMATCH: Exakten Entitätspfad bestätigen.');
            await json(`${prefix}/${current.type}/${current.id}`, 'DELETE');
          } else if (action === 'rename') {
            const newName = name(args.newName); destination = [...filePath.split('/').slice(0, -1), newName].join('/');
            if (treeEntities(client.project).entities.some(e => e.filePath === destination && e.id !== current.id)) throw new UserError('ALREADY_EXISTS: Ziel existiert.');
            await json(`${prefix}/${current.type}/${current.id}/rename`, 'POST', { name: newName });
          } else {
            const target = projectPath(args.destinationFolderPath, true), folderId = folder(client, target);
            if (current.type === 'folder' && (target === filePath || target.startsWith(filePath + '/'))) throw new UserError('INVALID_ARGUMENT: Ordner nicht in sich selbst verschieben.');
            destination = (target ? target + '/' : '') + filePath.split('/').at(-1)!;
            if (treeEntities(client.project).entities.some(e => e.filePath === destination && e.id !== current.id)) throw new UserError('ALREADY_EXISTS: Ziel existiert.');
            await json(`${prefix}/${current.type}/${current.id}/move`, 'POST', { folder_id: folderId });
          }
          return use(projectId, async observed => {
            const found = treeEntities(observed.project).entities.find(e => e.id === current.id);
            if (action === 'delete' ? !!found : found?.filePath !== destination) throw new UserError('OUTCOME_UNKNOWN: Entitätsänderung nicht bestätigt.');
            return { projectId, action, filePath, destination: action === 'delete' ? undefined : destination, confirmed: true };
          });
        }
        if (tool === 'upload_file') {
          const bytes = decodeBinary(args.dataBase64), exists = treeEntities(client.project).entities.find(e => e.filePath === filePath);
          const overwrite = bool(args.overwrite);
          if (args.confirmPath !== undefined) projectPath(args.confirmPath);
          if (exists && (!overwrite || args.confirmPath !== filePath)) throw new UserError('CONFIRMATION_MISMATCH: Überschreiben benötigt overwrite=true und exakten confirmPath.');
          if (exists?.type === 'folder') throw new UserError('INVALID_ARGUMENT: Ordner kann nicht überschrieben werden.');
          const parts = filePath.split('/'), basename = parts.pop()!, parentId = folder(client, parts.join('/'));
          const response = await json(`${prefix}/upload?folder_id=${parentId}`, 'POST', undefined, { name: basename, qqfile: { name: basename, mimeType: 'application/octet-stream', buffer: bytes } });
          const upload = object(Array.isArray(response) ? response[0] : response);
          if (upload.success === false) throw new UserError('REMOTE_ERROR: Upload abgelehnt.');
          const entityId = id(upload.entity_id ?? upload._id);
          if (exists && entityId !== exists.id) throw new UserError('OUTCOME_UNKNOWN: Upload hat Entitätsidentität nicht erhalten.');
          return { projectId, filePath, id: entityId, bytes: bytes.length, replaced: !!exists, confirmation: 'api-response', writeMode: 'untracked' };
        }
        if (tool === 'download_file') {
          const current = entity(client, filePath);
          if (current.type === 'folder') throw new UserError('INVALID_ARGUMENT: Nur einzelne Dateien herunterladen.');
          const response = await request(`/Project/${projectId}/${current.type}/${current.id}${current.type === 'doc' ? '/download' : ''}`);
          const mimeType = response.mimeType.split(';')[0]!;
          return { filePath, mimeType, dataBase64: response.bytes.toString('base64'), bytes: response.bytes.length };
        }
        const doc = await read(client, filePath);
        if (tool === 'read_file') return documentResult(projectId, filePath, doc);
        if (tool === 'get_sections') return { projectId, filePath, revision: documentRevision(projectId, doc), sections: parseSections(doc.content), singleFileOnly: true };
        if (tool === 'get_section_content') return { projectId, filePath, revision: documentRevision(projectId, doc), ...sectionContent(doc.content, string(args.sectionId, 100)) };
        if (tool === 'write_file' || tool === 'write_section') {
          checkRevision(args.revision, projectId, doc);
          const content = tool === 'write_section' ? text(replaceSection(doc.content, string(args.sectionId, 100), text(args.content))) : text(args.content);
          return write(projectId, client, filePath, doc, content, args.revision, args.writeMode);
        }
        if (tool === 'add_comment') {
          checkRevision(args.revision, projectId, doc); assertSupportedProtocol(doc);
          const start = positionOffset(doc.content, args.start), end = positionOffset(doc.content, args.end);
          const expectedText = text(args.expectedText, false), content = text(args.content, false);
          if (end <= start || doc.content.slice(start, end) !== expectedText) throw new UserError('REVISION_CONFLICT: Auswahl stimmt nicht mit expectedText überein.');
          const threadId = randomBytes(12).toString('hex');
          let recoveredAfterTimeout = false;
          try { await json(`${prefix}/thread/${threadId}/messages`, 'POST', { content }); }
          catch (error) {
            if (!(error instanceof UserError) || !error.message.startsWith('OUTCOME_UNKNOWN')) throw error;
            const observed = (await threads(projectId))[threadId];
            if (!observed || !(object(observed).messages ?? []).some((m: any) => m.content === content && m.user_id === auth.userId)) throw new UserError('OUTCOME_UNKNOWN: Kommentar-Thread nicht bestätigt. Nicht erneut senden.');
            recoveredAfterTimeout = true;
          }
          try {
            const op = doc.protocol === 'history-ot'
              ? [{ commentId: threadId, ranges: [{ pos: visibleToSnapshot(doc.snapshot!, start), length: visibleToSnapshot(doc.snapshot!, end) - visibleToSnapshot(doc.snapshot!, start) }] }]
              : [{ p: start, c: expectedText, t: threadId }];
            await client.apply(doc, op);
          }
          catch (error) {
            // Observe once on a fresh socket; never submit an ambiguous comment twice or delete its thread.
            const recovered = await use(projectId, async fresh => {
              const observed = await read(fresh, filePath), range = commentRanges(observed).find(r => r.threadId === threadId);
              return range?.start === start && range.end === end && observed.content.slice(start, end) === expectedText && observed.protocol === doc.protocol && observed.version > doc.version ? observed : undefined;
            });
            if (!recovered) throw new UserError(`OUTCOME_UNKNOWN: Kommentar-Thread ${threadId} existiert; Verankerung nicht bestätigt. Nicht wiederholen.`);
            return { threadId, revision: documentRevision(projectId, recovered), anchored: true, recoveredAfterTimeout: true, writeMode: 'untracked' };
          }
          const observed = await reread(client, doc), range = commentRanges(observed).find(r => r.threadId === threadId);
          if (!range || range.start !== start || range.end !== end || observed.content.slice(start, end) !== expectedText || observed.protocol !== doc.protocol || observed.version <= doc.version) throw new UserError(`OUTCOME_UNKNOWN: Kommentar-Thread ${threadId}; exakte Verankerung nicht bestätigt.`);
          return { threadId, revision: documentRevision(projectId, observed), anchored: true, recoveredAfterTimeout, writeMode: 'untracked' };
        }
        if (tool === 'set_comment_status') {
          checkRevision(args.revision, projectId, doc); assertSupportedProtocol(doc);
          const threadId = id(args.threadId), status = choice(args.status, ['open', 'resolved']);
          if (!commentRanges(doc).some(r => r.threadId === threadId)) throw new UserError('NOT_FOUND: Kommentar nicht an diesem Dokument verankert.');
          // History-OT stores the status in the document snapshot; ShareJS uses dedicated REST actions.
          if (doc.protocol === 'history-ot') await client.apply(doc, [{ commentId: threadId, resolved: status === 'resolved' }]);
          else await json(`${prefix}/doc/${doc.docId}/thread/${threadId}/${status === 'resolved' ? 'resolve' : 'reopen'}`, 'POST', {});
          const observed = await reread(client, doc), range = commentRanges(observed).find(r => r.threadId === threadId), thread = (await threads(projectId))[threadId];
          const resolved = range?.resolved ?? (thread ? object(thread).resolved : undefined);
          if (resolved !== (status === 'resolved')) throw new UserError('OUTCOME_UNKNOWN: Kommentarstatus nicht bestätigt.');
          return { threadId, status, revision: documentRevision(projectId, observed), confirmed: true, writeMode: 'untracked' };
        }
        throw new UserError('INVALID_ARGUMENT: Unbekannte Operation.');
      });
    })().catch(error => { throw error instanceof UserError ? error : new UserError('PROTOCOL_UNSUPPORTED: Antwort konnte nicht sicher verarbeitet werden.'); });
    // No output truncation; decoded binaries and their larger Base64 JSON envelopes are both bounded.
    const outputBytes = Buffer.byteLength(JSON.stringify(result));
    if (outputBytes > MAX_BYTES) throw new UserError('LIMIT_EXCEEDED: Ergebnis überschreitet 512 KiB; keine Kürzung.');
    return result;
  }
  private async bootstrap(): Promise<{ csrf: string; userId: string }> {
    const { bytes } = await this.request('/project', 'GET');
    const html = bytes.toString('utf8'), meta = new Map<string, string>();
    for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
      const attributes = new Map<string, string>();
      for (const attr of tag[0].matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)) attributes.set(attr[1]!.toLowerCase(), attr[3]!);
      if (attributes.has('name') && attributes.has('content')) meta.set(attributes.get('name')!, attributes.get('content')!);
    }
    const csrf = meta.get('ol-csrfToken'), userId = meta.get('ol-user_id');
    if (!csrf || !/^[a-zA-Z0-9_.+\/-]{1,512}$/.test(csrf) || !userId || !/^[a-f0-9]{24}$/i.test(userId)) throw new UserError('AUTH_REQUIRED: Im verbundenen Browser anmelden; Auth-Metadaten fehlen.');
    return { csrf, userId: id(userId) };
  }
  private async request(path: string, method: string, csrf?: string, body?: Record<string, unknown>, multipart?: Record<string, any>, timeout = 30000): Promise<{ bytes: Buffer; mimeType: string }> {
    const url = new URL(path, this.baseUrl);
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || url.origin !== this.baseUrl || url.username || url.password || url.hash) throw new UserError('INVALID_ARGUMENT: Fremde Request-Origin gesperrt.');
    let response: APIResponse | undefined;
    try {
      response = await this.context.request.fetch(url.href, { method, maxRedirects: 0, timeout,
        headers: csrf ? { 'x-csrf-token': csrf } : {}, ...(multipart ? { multipart: { ...multipart, ...(csrf ? { _csrf: csrf } : {}) } } : body ? { data: body } : {}) });
      const responseUrl = new URL(response.url());
      if (responseUrl.origin !== this.baseUrl || responseUrl.username || responseUrl.password || responseUrl.href !== url.href) throw new UserError('HTTP_ERROR: Antwort-URL nicht eindeutig; Weiterleitungen gesperrt.');
      const status = response.status();
      if (status < 200 || status >= 300) throw new UserError(status === 401 || status === 403 ? 'AUTH_REQUIRED: Zugriff nicht autorisiert.'
        : status === 429 ? rateLimited(response.headers()['retry-after']) : `HTTP_ERROR: Overleaf antwortete mit Status ${status}; keine Wiederholung.`);
      const length = response.headers()['content-length'];
      if (length && Number(length) > MAX_BYTES) throw new UserError('LIMIT_EXCEEDED: Antwort größer als 512 KiB.');
      const bytes = await response.body();
      if (bytes.length > MAX_BYTES) throw new UserError('LIMIT_EXCEEDED: Antwort größer als 512 KiB.');
      return { bytes, mimeType: response.headers()['content-type'] ?? 'application/octet-stream' };
    } catch (error) {
      throw error instanceof UserError ? error : new UserError(method === 'GET' ? 'NETWORK_ERROR: Overleaf-Anfrage fehlgeschlagen.' : 'OUTCOME_UNKNOWN: Anfrage möglicherweise verarbeitet. Nicht blind wiederholen.');
    } finally { await response?.dispose().catch(() => undefined); }
  }
  private outputUrl(value: string): string {
    const url = new URL(value, this.baseUrl);
    if (url.origin !== this.baseUrl || url.username || url.password || url.hash || url.search || value.includes('\\')) throw new UserError('PROTOCOL_UNSUPPORTED: Unsichere Compile-Ausgabe-URL (fremde Origin oder Query).');
    return url.pathname;
  }
}