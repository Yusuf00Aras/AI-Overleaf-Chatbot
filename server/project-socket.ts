import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket, { type ClientOptions } from 'ws';
import type { BrowserContext } from 'playwright';
import { UserError, instanceUrl } from './policy.js';
import { proxyFor, proxyTunnel } from './proxy.js';

export const MAX_BYTES = 512 * 1024;
export const lf = (text: string) => text.replace(/\r\n?/g, '\n');
export const hash = (text: string) => createHash('sha256').update(lf(text)).digest('hex');
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UserError('PROTOCOL_UNSUPPORTED: Ungültige Objektstruktur.');
  return value as Record<string, any>;
}
export function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) throw new UserError('INVALID_ARGUMENT: Ungültige ID.');
  return value.toLowerCase();
}
export interface Entity { id: string; filePath: string; type: 'doc' | 'file' | 'folder'; parentId: string; hash?: string }
export interface SocketDocument { docId: string; protocol: string; version: number; content: string; ranges: unknown; snapshot?: Record<string, any> }
export function documentRevision(projectId: string, document: SocketDocument): string {
  return Buffer.from(JSON.stringify({ projectId, docId: document.docId, protocol: document.protocol,
    version: document.version, hash: hash(document.content) })).toString('base64url');
}
export function checkRevision(revision: unknown, projectId: string, document: SocketDocument): void {
  if (typeof revision !== 'string' || revision.length > 2048 || revision !== documentRevision(projectId, document)) {
    throw new UserError('REVISION_CONFLICT: Dokumentidentität, Protokoll, Version oder Inhalt geändert. Erneut lesen.');
  }
}
export function textOperation(before: string, after: string): Record<string, unknown>[] {
  let left = 0;
  while (left < before.length && left < after.length && before[left] === after[left]) left++;
  if (left && /[\uD800-\uDBFF]/.test(before[left - 1]!)) left--;
  let rightBefore = before.length, rightAfter = after.length;
  while (rightBefore > left && rightAfter > left && before[rightBefore - 1] === after[rightAfter - 1]) { rightBefore--; rightAfter--; }
  if (rightBefore < before.length && /[\uDC00-\uDFFF]/.test(before[rightBefore]!)) { rightBefore++; rightAfter++; }
  const ops: Record<string, unknown>[] = [];
  if (rightBefore > left) ops.push({ p: left, d: before.slice(left, rightBefore) });
  if (rightAfter > left) ops.push({ p: left, i: after.slice(left, rightAfter) });
  return ops;
}
function deletedRanges(snapshot: Record<string, any>): { pos: number; length: number }[] {
  return (snapshot.trackedChanges ?? []).filter((change: any) => change?.tracking?.type === 'delete')
    .map((change: any) => change.range).sort((a: any, b: any) => a.pos - b.pos);
}
/** Editor-visible UTF-16 offset to raw History-OT offset (raw text still contains tracked deletions). */
export function visibleToSnapshot(snapshot: Record<string, any>, offset: number): number {
  let deleted = 0;
  for (const range of deletedRanges(snapshot)) {
    if (offset > range.pos - deleted) deleted += range.length;
    else break;
  }
  return offset + deleted;
}
export function snapshotToVisible(snapshot: Record<string, any>, offset: number): number {
  let deleted = 0;
  for (const range of deletedRanges(snapshot)) {
    if (offset < range.pos) break;
    if (offset < range.pos + range.length) return range.pos - deleted;
    deleted += range.length;
  }
  return offset - deleted;
}
function edit(ops: Record<string, unknown>[]) {
  return { position: (ops[0]?.p as number | undefined) ?? 0, deleted: (ops.find(op => op.d !== undefined)?.d as string | undefined) ?? '',
    inserted: (ops.find(op => op.i !== undefined)?.i as string | undefined) ?? '' };
}
export interface Tracking { userId: string; ts: string }
/** Single minimal History-OT text operation over the raw snapshot; tracked variants mark instead of removing. */
export function historyTextOperation(snapshot: Record<string, any>, before: string, after: string, tracking?: Tracking): Record<string, unknown>[] {
  const raw = snapshot.content;
  if (typeof raw !== 'string' || raw.includes('\r')) throw new UserError('PROTOCOL_UNSUPPORTED: History-Snapshot nicht sicher abbildbar; keine Änderung ausgeführt.');
  const ops = textOperation(before, after);
  if (!ops.length) return [];
  const { position, deleted, inserted } = edit(ops);
  const start = visibleToSnapshot(snapshot, position), end = visibleToSnapshot(snapshot, position + deleted.length);
  const op: unknown[] = [];
  if (start > 0) op.push(start);
  if (inserted) op.push(tracking ? { i: inserted, tracking: { type: 'insert', userId: tracking.userId, ts: tracking.ts } } : inserted);
  if (end > start) op.push(tracking ? { r: end - start, tracking: { type: 'delete', userId: tracking.userId, ts: tracking.ts } } : -(end - start));
  if (raw.length > end) op.push(raw.length - end);
  return [{ textOperation: op }];
}
/** True only if the reread document shows tracked changes by this user for the submitted edit. */
export function trackedChangeObserved(before: SocketDocument, after: SocketDocument, userId: string): boolean {
  const ops = textOperation(before.content, after.content);
  if (!ops.length) return true;
  const { position, deleted, inserted } = edit(ops);
  if (after.protocol === 'history-ot') {
    if (!before.snapshot || !after.snapshot) return false;
    const changes: any[] = Array.isArray(after.snapshot.trackedChanges) ? after.snapshot.trackedChanges : [];
    const start = visibleToSnapshot(before.snapshot, position), removed = visibleToSnapshot(before.snapshot, position + deleted.length) - start;
    const covered = (type: string, from: number, length: number) => !length || changes.some(change => change?.tracking?.type === type &&
      change.tracking.userId === userId && change.range?.pos <= from && change.range.pos + change.range.length >= from + length);
    return covered('insert', start, inserted.length) && covered('delete', start + inserted.length, removed);
  }
  const list = (doc: SocketDocument): any[] => Array.isArray((doc.ranges as any)?.changes) ? (doc.ranges as any).changes : [];
  const old = new Set(list(before).map(change => change?.id));
  const fresh = list(after).filter(change => change && !old.has(change.id) && change.metadata?.user_id === userId &&
    Number.isSafeInteger(change.op?.p) && change.op.p >= position && change.op.p <= position + inserted.length);
  return (!inserted || fresh.some(change => typeof change.op.i === 'string')) && (!deleted || fresh.some(change => typeof change.op.d === 'string'));
}
export function treeEntities(project: Record<string, any>): { entities: Entity[]; rootFolderId: string } {
  const roots = project.rootFolder;
  if (!Array.isArray(roots) || roots.length !== 1) throw new UserError('PROTOCOL_UNSUPPORTED: Projektwurzel nicht eindeutig.');
  const entities: Entity[] = [], seen = new Set<string>(), paths = new Set<string>();
  const walk = (raw: unknown, prefix: string, depth: number) => {
    if (depth > 50 || entities.length > 10000) throw new UserError('LIMIT_EXCEEDED: Projektbaum zu groß.');
    const folder = object(raw), folderId = id(folder._id);
    if (seen.has(folderId)) throw new UserError('PROTOCOL_UNSUPPORTED: Doppelte Entität.');
    seen.add(folderId);
    for (const [key, type] of [['docs', 'doc'], ['fileRefs', 'file'], ['folders', 'folder']] as const) {
      const items = folder[key] ?? [];
      if (!Array.isArray(items)) throw new UserError('PROTOCOL_UNSUPPORTED: Ungültiger Projektbaum.');
      for (const rawItem of items) {
        const item = object(rawItem), entityId = id(item._id);
        if (typeof item.name !== 'string' || !item.name || /[/\\\x00-\x1f]/.test(item.name) || ['.', '..'].includes(item.name)) throw new UserError('PROTOCOL_UNSUPPORTED: Unsicherer Entitätspfad.');
        const filePath = prefix + item.name;
        if (paths.has(filePath) || seen.has(entityId)) throw new UserError('PROTOCOL_UNSUPPORTED: Entität nicht eindeutig.');
        paths.add(filePath);
        // Overleaf stores the git blob hash (`git hash-object`) on binary file refs only.
        entities.push({ id: entityId, filePath, type, parentId: folderId, ...(type === 'file' && typeof item.hash === 'string' && /^[a-f0-9]{40}$/i.test(item.hash) ? { hash: item.hash.toLowerCase() } : {}) });
        if (type === 'folder') walk(item, filePath + '/', depth + 1);
        else seen.add(entityId);
      }
    }
  };
  walk(roots[0], '', 0);
  return { entities, rootFolderId: id(object(roots[0])._id) };
}

export interface ProjectClient {
  project: Record<string, any>;
  joinDoc(docId: string): Promise<SocketDocument>;
  leaveDoc(docId: string): Promise<void>;
  apply(doc: SocketDocument, op: unknown[], meta?: Record<string, unknown>): Promise<void>;
  close(): void;
}
export type WebSocketFactory = (url: string, options: ClientOptions) => WebSocket;

/** One disposable Socket.IO 0.9 connection. Never persists cookies or follows redirects. */
export class ProjectSocket extends EventEmitter implements ProjectClient {
  project: Record<string, any> = {};
  private counter = 0;
  private pending = new Map<number, { resolve: (args: unknown[]) => void; reject: (error: UserError) => void; timer: NodeJS.Timeout }>();
  private waiters = new Set<(error: UserError) => void>();
  private closed = false;
  private constructor(private socket: WebSocket, private timeoutMs: number) {
    super();
    socket.on('message', data => {
      try { this.receive(data.toString()); } catch { this.fail(new UserError('PROTOCOL_UNSUPPORTED: Ungültiger Socket-Frame.')); }
    });
    socket.on('error', () => this.fail(new UserError('OUTCOME_UNKNOWN: Socket-Verbindung fehlgeschlagen. Nicht blind wiederholen.')));
    socket.on('close', () => this.fail(new UserError('OUTCOME_UNKNOWN: Socket-Verbindung geschlossen. Nicht blind wiederholen.')));
    socket.on('unexpected-response', (_req, response) => {
      response.resume();
      this.fail(new UserError('HTTP_ERROR: WebSocket-Upgrade abgelehnt; Weiterleitungen sind gesperrt.'));
    });
  }
  static async open(context: BrowserContext, inputUrl: string, projectId: string,
    factory: WebSocketFactory = (url, options) => new WebSocket(url, options), timeoutMs = 15000): Promise<ProjectSocket> {
    const baseUrl = instanceUrl(inputUrl);
    projectId = id(projectId);
    let handshake: string;
    try {
      const handshakeUrl = `${baseUrl}/socket.io/1/?projectId=${projectId}&t=${Date.now()}`;
      const response = await context.request.get(handshakeUrl, { maxRedirects: 0, timeout: timeoutMs });
      try {
        if (response.status() !== 200 || response.url() !== handshakeUrl) throw new UserError('HTTP_ERROR: Socket-Handshake abgelehnt oder weitergeleitet.');
        const body = await response.body();
        if (body.length > 4096) throw new UserError('PROTOCOL_UNSUPPORTED: Socket-Handshake zu groß.');
        handshake = body.toString('utf8');
      } finally { await response.dispose(); }
    } catch (error) { throw error instanceof UserError ? error : new UserError('NETWORK_ERROR: Socket-Handshake fehlgeschlagen.'); }
    const parts = handshake.split(':');
    if (parts.length !== 4 || !/^[a-zA-Z0-9_-]{1,200}$/.test(parts[0]!) || !parts[3]!.split(',').includes('websocket')) throw new UserError('PROTOCOL_UNSUPPORTED: Socket.IO 0.9 nicht angeboten.');
    let cookie: string;
    try {
      // BrowserContext is the explicitly connected, in-memory context, not an external session store.
      cookie = (await context.cookies(`${baseUrl}/socket.io/1/websocket/${parts[0]}`)).map(c => `${c.name}=${c.value}`).join('; ');
    } catch { throw new UserError('AUTH_REQUIRED: Browserkontext nicht verfügbar.'); }
    let client: ProjectSocket;
    const proxy = proxyFor(baseUrl);
    try {
      client = new ProjectSocket(factory(`${baseUrl.replace(/^http/, 'ws')}/socket.io/1/websocket/${parts[0]}`, {
        headers: { Cookie: cookie, Origin: baseUrl }, followRedirects: false, perMessageDeflate: false,
        maxPayload: MAX_BYTES * 4, handshakeTimeout: timeoutMs,
        ...(proxy ? { createConnection: proxyTunnel(proxy) as unknown as ClientOptions['createConnection'] } : {}),
      }), timeoutMs);
    } catch { throw new UserError('NETWORK_ERROR: Socket konnte nicht geöffnet werden.'); }
    try {
      const [raw] = await client.wait('joinProjectResponse');
      const join = object(raw);
      if (id(object(join.project)._id) !== projectId || join.protocolVersion !== 2) throw new UserError('PROTOCOL_UNSUPPORTED: Projektidentität oder Socket-Protokoll nicht unterstützt.');
      client.project = object(join.project);
      treeEntities(client.project);
      return client;
    } catch (error) { client.close(); throw error; }
  }
  private fail(error: UserError): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const reject of [...this.waiters]) reject(error);
    this.socket.terminate();
  }
  private receive(frame: string): void {
    if (frame === '2::') { this.socket.send('2::'); return; }
    if (frame.startsWith('0:') || frame.startsWith('7:')) { this.fail(new UserError('OUTCOME_UNKNOWN: Socket hat Operation abgelehnt oder Verbindung beendet.')); return; }
    const match = /^(\d+):([^:]*):([^:]*):?([\s\S]*)$/.exec(frame);
    if (!match) throw new Error('frame');
    if (match[1] === '5') {
      const event = object(JSON.parse(match[4]!));
      if (typeof event.name !== 'string' || !Array.isArray(event.args)) throw new Error('event');
      if (event.name === 'connectionRejected') { this.fail(new UserError('AUTH_REQUIRED: Projekt-Socket abgelehnt.')); return; }
      this.emit(event.name, ...event.args);
    } else if (match[1] === '6') {
      // Socket.IO 0.9 sends a bare `id` when the callback has no arguments (e.g. applyOtUpdate).
      const ack = /^(\d+)(?:\+([\s\S]*))?$/.exec(match[4]!);
      if (!ack) throw new Error('ack');
      const pending = this.pending.get(Number(ack[1]));
      if (!pending) return;
      const args: unknown = ack[2] ? JSON.parse(ack[2]) : [];
      if (!Array.isArray(args)) throw new Error('ack args');
      clearTimeout(pending.timer); this.pending.delete(Number(ack[1])); pending.resolve(args);
    }
  }
  private wait(event: string, predicate: (...args: any[]) => boolean = () => true): Promise<any[]> {
    if (this.closed) return Promise.reject(new UserError('OUTCOME_UNKNOWN: Socket geschlossen.'));
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.off(event, listener); this.waiters.delete(failure); };
      const failure = (error: UserError) => { cleanup(); reject(error); };
      const listener = (...args: any[]) => { if (predicate(...args)) { cleanup(); resolve(args); } };
      const timer = setTimeout(() => failure(new UserError('OUTCOME_UNKNOWN: Socket-Bestätigung ausgeblieben. Nicht blind wiederholen.')), this.timeoutMs);
      this.on(event, listener); this.waiters.add(failure);
    });
  }
  call(name: string, args: unknown[]): Promise<unknown[]> {
    if (this.closed) return Promise.reject(new UserError('OUTCOME_UNKNOWN: Socket geschlossen.'));
    const number = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(number); reject(new UserError('OUTCOME_UNKNOWN: Socket-Antwort ausgeblieben. Nicht blind wiederholen.')); }, this.timeoutMs);
      this.pending.set(number, { resolve, reject, timer });
      try { this.socket.send(`5:${number}+::${JSON.stringify({ name, args })}`); }
      catch { clearTimeout(timer); this.pending.delete(number); reject(new UserError('OUTCOME_UNKNOWN: Socket-Senden fehlgeschlagen.')); }
    });
  }
  async joinDoc(docId: string): Promise<SocketDocument> {
    docId = id(docId);
    const [error, raw, version, , ranges, protocol = 'sharejs-text-ot'] = await this.call('joinDoc', [docId, { encodeRanges: true, supportsHistoryOT: true }]);
    if (error) throw new UserError('REMOTE_ERROR: Dokumentzugriff abgelehnt.');
    if (!Number.isSafeInteger(version) || (version as number) < 0) throw new UserError('PROTOCOL_UNSUPPORTED: Ungültige Dokumentversion.');
    let content: string, snapshot: Record<string, any> | undefined;
    if (protocol === 'history-ot') {
      snapshot = object(raw);
      if (typeof snapshot.content !== 'string') throw new UserError('PROTOCOL_UNSUPPORTED: History-Snapshot fehlt.');
      content = snapshot.content;
      const deleted = (snapshot.trackedChanges ?? []).filter((change: any) => change.tracking?.type === 'delete').map((change: any) => change.range).sort((a: any, b: any) => a.pos - b.pos);
      let cursor = 0, visible = '';
      for (const range of deleted) {
        if (!Number.isSafeInteger(range.pos) || !Number.isSafeInteger(range.length) || range.pos < cursor || range.length < 0 || range.pos + range.length > content.length) throw new UserError('PROTOCOL_UNSUPPORTED: History-Bereiche ungültig.');
        visible += content.slice(cursor, range.pos); cursor = range.pos + range.length;
      }
      content = visible + content.slice(cursor);
    } else if (protocol === 'sharejs-text-ot' || protocol === 'sharejs') {
      if (!Array.isArray(raw) || raw.some(line => typeof line !== 'string')) throw new UserError('PROTOCOL_UNSUPPORTED: Dokument-Snapshot ungültig.');
      content = raw.map((line: string) => {
        if ([...line].some(char => char.charCodeAt(0) > 255)) return line;
        const decoded = Buffer.from(line, 'latin1').toString('utf8');
        return decoded.includes('\uFFFD') ? line : decoded;
      }).join('\n');
    } else throw new UserError('PROTOCOL_UNSUPPORTED: Unbekanntes OT-Protokoll.');
    content = lf(content);
    if (content.length > 500000 || Buffer.byteLength(content) > MAX_BYTES) throw new UserError('LIMIT_EXCEEDED: Dokument zu groß.');
    return { docId, protocol: String(protocol), version: version as number, content, ranges, ...(snapshot ? { snapshot } : {}) };
  }
  async leaveDoc(docId: string): Promise<void> {
    const [error] = await this.call('leaveDoc', [id(docId)]);
    if (error) throw new UserError('REMOTE_ERROR: Dokument konnte nicht verlassen werden.');
  }
  async apply(doc: SocketDocument, op: unknown[], meta?: Record<string, unknown>): Promise<void> {
    assertSupportedProtocol(doc);
    if (!op.length) throw new UserError('INVALID_ARGUMENT: Leere OT-Änderung.');
    const update = { doc: doc.docId, v: doc.version, op, ...(meta ? { meta } : {}) };
    if (Buffer.byteLength(JSON.stringify(update)) > MAX_BYTES) throw new UserError('LIMIT_EXCEEDED: OT-Änderung zu groß.');
    const applied = this.wait('otUpdateApplied', message => message?.doc === doc.docId && message?.v === doc.version);
    // Attach immediately: an event timeout must not cause an unhandled rejection while the ACK is pending.
    void applied.catch(() => undefined);
    const rejected = (error: unknown, message?: any) => {
      if (!message?.doc_id || message.doc_id === doc.docId) this.fail(new UserError('REMOTE_ERROR: OT-Änderung abgelehnt.'));
    };
    this.on('otUpdateError', rejected);
    try {
      const [error] = await this.call('applyOtUpdate', [doc.docId, update]);
      if (error) throw new UserError('REMOTE_ERROR: OT-Änderung nicht angenommen.');
      await applied;
    } catch (error) { this.close(); throw error; }
    finally { this.off('otUpdateError', rejected); }
  }
  close(): void { this.fail(new UserError('OUTCOME_UNKNOWN: Socket geschlossen.')); }
}
export function assertSupportedProtocol(doc: SocketDocument): void {
  if (!['sharejs', 'sharejs-text-ot', 'history-ot'].includes(doc.protocol)) throw new UserError('PROTOCOL_UNSUPPORTED: Unbekanntes OT-Protokoll; keine Änderung ausgeführt.');
  if (doc.protocol === 'history-ot' && (!doc.snapshot || typeof doc.snapshot.content !== 'string')) throw new UserError('PROTOCOL_UNSUPPORTED: History-Snapshot fehlt; keine Änderung ausgeführt.');
}