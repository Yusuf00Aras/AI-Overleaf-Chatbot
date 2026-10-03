import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { post, type Attachment, type Download, type ChatResponse, type ChatMessage, type DecisionResponse, type Proposal, type Scope, type ProjectInfo, type ToolActivity } from './api';
import { HOSTED_URL, parseProjectId } from './project';
import { MAX_ENDPOINTS, OPENAI, endpointHost, endpointUrl, loadEndpoints, mergeEndpoints, parseEndpoints, saveEndpoints, toModel, type Endpoint } from './endpoints';

type Connection = 'none' | 'busy' | 'opened' | 'ready';
type View = 'chat' | 'settings';
interface Entry extends ChatMessage {
  activity?: ToolActivity[]; local?: boolean; downloads?: Download[];
  attachments?: Pick<Attachment, 'id' | 'name'>[]; proposals?: Proposal[];
}
interface Decision { status: 'busy' | 'applied' | 'discarded' | 'failed'; message?: string }

const TOOL_LABELS: Record<string, string> = {
  list_projects: 'Projekte aufgelistet', create_project: 'Projekt erstellt',
  auth_status: 'Anmeldung geprüft', clone_project: 'Projekt kopiert', import_project_zip: 'ZIP importiert',
  manage_project: 'Projekt verwaltet', update_project_settings: 'Einstellungen geändert',
  get_project_tree: 'Projektbaum gelesen', read_file: 'Datei gelesen', write_file: 'Textdatei geändert',
  create_file: 'Textdatei erstellt', manage_entity: 'Datei/Ordner verwaltet', upload_file: 'Anhang hochgeladen',
  download_file: 'Download bereitgestellt', get_sections: 'Abschnitte aufgelistet',
  get_section_content: 'Abschnitt gelesen', write_section: 'Abschnitt geändert',
  compile_project: 'Kompilierung verarbeitet', stop_compile: 'Kompilierung gestoppt',
  list_comments: 'Kommentare gelesen', reply_to_comment: 'Kommentar beantwortet',
  add_comment: 'Kommentar hinzugefügt', set_comment_status: 'Kommentarstatus geändert',
  monitor_project_history: 'Verlauf abgefragt', validate_latex: 'Statisch geprüft (kein Compile)',
  preview_edit: 'Änderungsvorschau (ohne Schreiben)', describe_capabilities: 'Fähigkeiten beschrieben',
  read_document: 'Gelesen', write_document: 'Geschrieben', compile_document: 'Kompilierung angefordert',
};
const MAX_MESSAGE = 30_000;
const MAX_ATTACHMENT_BYTES = 512 * 1024;
const TOOL_GROUPS = [
  { title: 'Anmeldung & Projekte', tools: ['auth_status', 'list_projects', 'create_project', 'clone_project', 'import_project_zip', 'manage_project', 'update_project_settings'] },
  { title: 'Dateien & Abschnitte', tools: ['get_project_tree', 'read_file', 'write_file', 'create_file', 'manage_entity', 'upload_file', 'download_file', 'get_sections', 'get_section_content', 'write_section'] },
  { title: 'Kompilierung, Kommentare & Verlauf', tools: ['compile_project', 'stop_compile', 'list_comments', 'reply_to_comment', 'add_comment', 'set_comment_status', 'monitor_project_history'] },
  { title: '3 lokale Erweiterungen', tools: ['validate_latex', 'preview_edit', 'describe_capabilities'] },
  { title: 'Legacy-Aliasse', tools: ['read_document', 'write_document', 'compile_document'] },
];

function readAttachment(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Anhang konnte nicht gelesen werden.'));
    reader.onabort = () => reject(new Error('Lesen des Anhangs abgebrochen.'));
    reader.onload = () => typeof reader.result === 'string' && reader.result.includes(',')
      ? resolve(reader.result.slice(reader.result.indexOf(',') + 1))
      : reject(new Error('Anhang konnte nicht kodiert werden.'));
    reader.readAsDataURL(file);
  });
}

function downloadFile(download: Download) {
  const bytes = Uint8Array.from(atob(download.dataBase64), char => char.charCodeAt(0));
  // Never navigate to remote content or render it inline, even for HTML/SVG responses.
  const url = URL.createObjectURL(new Blob([bytes], { type: download.mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = download.name.split(/[\\/]/).at(-1)?.replace(/[\x00-\x1f\x7f]/g, '_') || 'download';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function App() {
  const [instance, setInstance] = useState<'hosted' | 'self'>('hosted');
  const [customUrl, setCustomUrl] = useState('');
  const [projectInput, setProjectInput] = useState('');
  const [connection, setConnection] = useState<Connection>('none');
  const [statusText, setStatusText] = useState('');
  const [view, setView] = useState<View>('chat');
  const [custom, setCustom] = useState<Endpoint[]>(() => loadEndpoints());
  const [endpointId, setEndpointId] = useState(OPENAI.id);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [model, setModel] = useState(OPENAI.models[0]!.id);
  const [endpointForm, setEndpointForm] = useState({ url: '', name: '', modelId: '', modelName: '', toolCalling: true, vision: false, maxInput: '', maxOutput: '' });
  const [importText, setImportText] = useState('');
  const [endpointNote, setEndpointNote] = useState<{ ok: boolean; text: string } | undefined>();
  const [allowWrites, setAllowWrites] = useState(false);
  const [allowCreateProjects, setAllowCreateProjects] = useState(false);
  const [allowManageProjects, setAllowManageProjects] = useState(false);
  const [allowDestructive, setAllowDestructive] = useState(false);
  const [allowComments, setAllowComments] = useState(false);
  const [fullAccess, setFullAccess] = useState(false);
  const [confirmChanges, setConfirmChanges] = useState(true);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const attachmentRef = useRef<HTMLInputElement>(null);
  const attachmentRequestRef = useRef(0);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [privacyAck, setPrivacyAck] = useState(false);
  const [messages, setMessages] = useState<Entry[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | undefined>(undefined);
  const endRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);

  const projectId = parseProjectId(projectInput);
  const endpoints = [OPENAI, ...custom];
  const endpoint = endpoints.find(item => item.id === endpointId) ?? OPENAI;
  const modelDef = endpoint.models.find(item => item.id === model);
  const apiKey = keys[endpoint.id] ?? '';
  const destination = endpoint.baseUrl ? endpointHost(endpoint.baseUrl) : 'OpenAI';
  const modelOk = endpoint.baseUrl ? !!modelDef : !!model.trim();
  const baseUrl = instance === 'hosted' ? HOSTED_URL : customUrl.trim().replace(/\/+$/, '');
  const scope: Scope | undefined = baseUrl && (!projectInput || projectId)
    ? { baseUrl, ...(projectId ? { projectId } : {}) } : undefined;
  const canSend = !!scope && connection === 'ready' && apiKey.length >= 10 && modelOk && privacyAck && !busy && !attachmentBusy && !catalogBusy && !statusBusy && !!input.trim();
  const scopeLocked = busy || connection === 'busy' || catalogBusy || statusBusy;
  const mutationsDisabled = !scope?.projectId || connection !== 'ready' || scopeLocked;
  // Full access is a deliberate user mode: it stays on across turns, until the instance or project changes.
  const grant = { writes: allowWrites || fullAccess, create: allowCreateProjects || fullAccess, manage: allowManageProjects || fullAccess,
    destructive: allowDestructive || fullAccess, comments: allowComments || fullAccess };
  const grantCount = Object.values(grant).filter(Boolean).length;

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, busy]);
  useEffect(() => { saveEndpoints(custom); }, [custom]);

  // Chat content goes to the selected endpoint, so the privacy acknowledgement never carries over to another one.
  function selectEndpoint(id: string, nextModel?: string) {
    const target = endpoints.find(item => item.id === id) ?? OPENAI;
    setEndpointId(target.id);
    setModel(nextModel ?? target.models[0]!.id);
    if (target.id !== endpointId) setPrivacyAck(false);
  }

  function applyEndpoints(incoming: Endpoint[]) {
    const merged = mergeEndpoints(custom, incoming);
    setCustom(merged);
    const first = incoming[0]!;
    const known = merged.find(item => item.baseUrl === first.baseUrl)!;
    setEndpointId(known.id);
    setModel(first.models[0]!.id);
    if (known.id !== endpointId) setPrivacyAck(false);
  }

  function addEndpoint(event: FormEvent) {
    event.preventDefault();
    try {
      const base = endpointUrl(endpointForm.url);
      const number = (value: string) => value.trim() ? Number(value) : undefined;
      const added = toModel({ id: endpointForm.modelId, name: endpointForm.modelName, toolCalling: endpointForm.toolCalling, vision: endpointForm.vision,
        maxInputTokens: number(endpointForm.maxInput), maxOutputTokens: number(endpointForm.maxOutput) });
      applyEndpoints([{ id: `custom:${base}`, name: endpointForm.name.trim() || endpointHost(base), baseUrl: base, models: [added] }]);
      setEndpointForm({ url: '', name: '', modelId: '', modelName: '', toolCalling: true, vision: false, maxInput: '', maxOutput: '' });
      setEndpointNote({ ok: true, text: `Modell „${added.name}“ gespeichert und ausgewählt. Dafür unten den API-Schlüssel eintragen.` });
    } catch (err) { setEndpointNote({ ok: false, text: (err as Error).message }); }
  }

  function importEndpoints() {
    try {
      const incoming = parseEndpoints(importText);
      applyEndpoints(incoming);
      setImportText('');
      setEndpointNote({ ok: true, text: `${incoming.length} Endpunkt(e) mit ${incoming.reduce((total, item) => total + item.models.length, 0)} Modell(en) importiert. Enthaltene API-Schlüssel wurden ignoriert.` });
    } catch (err) { setEndpointNote({ ok: false, text: (err as Error).message }); }
  }

  function removeEndpoint() {
    if (!endpoint.baseUrl) return;
    setCustom(current => current.filter(item => item.id !== endpoint.id));
    setKeys(current => { const { [endpoint.id]: _removed, ...rest } = current; return rest; });
    selectEndpoint(OPENAI.id);
    setEndpointNote({ ok: true, text: 'Endpunkt entfernt.' });
  }

  function removeModel() {
    if (!endpoint.baseUrl || endpoint.models.length < 2) return;
    const rest = endpoint.models.filter(item => item.id !== model);
    setCustom(current => current.map(item => item.id === endpoint.id ? { ...item, models: rest } : item));
    setModel(rest[0]!.id);
    setEndpointNote({ ok: true, text: 'Modell entfernt.' });
  }

  // Any change of instance or project revokes write permission and discards the session.
  function clearAttachments() {
    attachmentRequestRef.current++;
    setAttachments([]);
    setAttachmentBusy(false);
    if (attachmentRef.current) attachmentRef.current.value = '';
  }

  async function pickAttachments(files: File[]) {
    const request = ++attachmentRequestRef.current;
    if (attachmentRef.current) attachmentRef.current.value = '';
    setError('');
    if (files.length + attachments.length > 3 || files.some(file => file.size > MAX_ATTACHMENT_BYTES) ||
      files.reduce((total, file) => total + file.size, attachments.reduce((total, item) => total + atob(item.dataBase64).length, 0)) > 3 * MAX_ATTACHMENT_BYTES) {
      setError('Maximal 3 Anhänge, je 512 KiB und zusammen 1,5 MiB.');
      return;
    }
    if (files.some(file => !file.name.trim() || file.name.length > 150 || /[/\\\x00-\x1f\x7f-\x9f]/.test(file.name) || ['.', '..'].includes(file.name))) {
      setError('Anhangname ungültig (maximal 150 Zeichen, keine Pfade oder Steuerzeichen).');
      return;
    }
    setAttachmentBusy(true);
    try {
      const added = await Promise.all(files.map(async file => ({ id: crypto.randomUUID(), name: file.name, dataBase64: await readAttachment(file) })));
      if (request === attachmentRequestRef.current) setAttachments(current => [...current, ...added]);
    } catch (err) {
      if (request === attachmentRequestRef.current) setError((err as Error).message);
    } finally {
      if (request === attachmentRequestRef.current) setAttachmentBusy(false);
    }
  }

  function changeScope(update: () => void, instanceChanged = false) {
    requestRef.current++;
    update();
    setAllowWrites(false);
    setAllowCreateProjects(false);
    setAllowManageProjects(false);
    setAllowDestructive(false);
    setAllowComments(false);
    setFullAccess(false);
    clearAttachments();
    if (instanceChanged) { setProjects([]); setCatalogLoaded(false); setProjectInput(''); }
    setConnection('none');
    setStatusText('');
    setMessages([]);
    setDecisions({});
    setError('');
  }

  async function connect() {
    if (!scope) return;
    const request = ++requestRef.current;
    setConnection('busy');
    setStatusText('Browser wird geöffnet …');
    try {
      const result = await post<{ message: string }>('connect', scope);
      if (request !== requestRef.current) return;
      setConnection('opened');
      setStatusText(result.message);
    } catch (err) {
      if (request !== requestRef.current) return;
      setConnection('none');
      setStatusText((err as Error).message);
    }
  }

  async function checkStatus() {
    if (!scope) return;
    const request = ++requestRef.current;
    setStatusBusy(true);
    try {
      const result = await post<{ ready: boolean; message: string }>('status', scope);
      if (request !== requestRef.current) return;
      setConnection(result.ready ? 'ready' : 'opened');
      setStatusText(result.message);
    } catch (err) {
      if (request !== requestRef.current) return;
      setConnection('opened');
      setStatusText((err as Error).message);
    } finally {
      setStatusBusy(false);
    }
  }

  async function loadProjects() {
    if (!scope || scopeLocked) return;
    const request = requestRef.current;
    setCatalogBusy(true);
    setError('');
    try {
      const result = await post<{ projects: ProjectInfo[] }>('projects', { baseUrl });
      if (request !== requestRef.current) return;
      setProjects(result.projects);
      setCatalogLoaded(true);
    } catch (err) {
      if (request === requestRef.current) { setProjects([]); setCatalogLoaded(false); setError((err as Error).message); }
    } finally { setCatalogBusy(false); }
  }

  async function decide(proposal: Proposal, decision: 'apply' | 'discard') {
    if (!scope?.projectId || decisions[proposal.id]) return;
    const request = requestRef.current;
    setDecisions(current => ({ ...current, [proposal.id]: { status: 'busy' } }));
    try {
      const result = await post<DecisionResponse>('proposals', { proposalId: proposal.id, scope, decision });
      if (request !== requestRef.current) return;
      const details = result.result ? ['verification', 'writeMode', 'trackingVerified', 'confirmed']
        .filter(key => result.result![key] !== undefined).map(key => `${key}: ${String(result.result![key])}`).join(', ') : '';
      setDecisions(current => ({ ...current, [proposal.id]: result.status === 'applied'
        ? { status: 'applied', message: `Übernommen${details ? ` (${details})` : ''}. Für weitere Änderungen neu lesen lassen.` }
        : { status: 'discarded', message: 'Verworfen. Nichts geändert.' } }));
    } catch (err) {
      if (request !== requestRef.current) return;
      setDecisions(current => ({ ...current, [proposal.id]: { status: 'failed', message: `Nicht übernommen: ${(err as Error).message} Vorschlag verbraucht; nicht blind wiederholen.` } }));
    }
  }

  async function decideAll(entry: Entry, decision: 'apply' | 'discard') {
    const request = requestRef.current;
    for (const proposal of entry.proposals ?? []) {
      if (request !== requestRef.current) return; // Scope changed: the remaining proposals are gone.
      if (!decisions[proposal.id]) await decide(proposal, decision);
    }
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if (!canSend || !scope) return;
    const turnAttachments = attachments;
    const history: Entry[] = [...messages, { role: 'user', content: text,
      attachments: turnAttachments.map(({ id, name }) => ({ id, name })) }];
    clearAttachments();
    setMessages(history);
    setInput('');
    setError('');
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const payload = history.filter(entry => !entry.local && entry.content).slice(-40)
        .map(({ role, content }) => ({ role, content: content.slice(0, MAX_MESSAGE) }));
      const result = await post<ChatResponse>('chat',
        { apiKey, model: model.trim(),
          ...(endpoint.baseUrl ? { endpoint: { baseUrl: endpoint.baseUrl, toolCalling: modelDef?.toolCalling ?? false,
            ...(modelDef?.maxInputTokens ? { maxInputTokens: modelDef.maxInputTokens } : {}), ...(modelDef?.maxOutputTokens ? { maxOutputTokens: modelDef.maxOutputTokens } : {}) } } : {}),
          scope, allowWrites: grant.writes, allowCreateProjects: grant.create, allowManageProjects: grant.manage, allowDestructive: grant.destructive, allowComments: grant.comments, confirmChanges,
          attachments: turnAttachments, messages: payload }, controller.signal);
      setMessages(current => [...current, { role: 'assistant', content: result.reply || 'Fertig.', activity: result.activity, downloads: result.downloads, proposals: result.proposals }]);
    } catch (err) {
      if (controller.signal.aborted) {
        setMessages(current => [...current, { role: 'assistant', local: true,
          content: 'Abgebrochen. Bereits ausgeführte Änderungen bleiben bestehen – Dokument im Overleaf-Browser prüfen.' }]);
      } else setError((err as Error).message);
    } finally {
      setBusy(false);
      // Sensitive grants are one-turn only (including errors and cancellation) unless the user chose full access.
      if (!fullAccess) {
        setAllowCreateProjects(false);
        setAllowManageProjects(false);
        setAllowDestructive(false);
        setAllowComments(false);
      }
      clearAttachments();
      turnAttachments.length = 0;
      abortRef.current = undefined;
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
  }

  const missing = [
    !scope && 'gültige Instanz / Projektauswahl',
    scope && connection !== 'ready' && 'Verbindung prüfen',
    apiKey.length < 10 && 'API-Schlüssel (Einstellungen)',
    !modelOk && 'Modell',
    !privacyAck && 'Datenschutzhinweis (Einstellungen)',
  ].filter(Boolean);

  return (
    <div className="layout">
      <nav className="topbar" aria-label="Hauptnavigation">
        <div className="brand">
          <h1>Overleaf Chat Studio</h1>
          <span className="badge">experimentell</span>
        </div>
        <div className="tabs" role="tablist" aria-label="Bereiche">
          <button type="button" role="tab" id="tab-chat" aria-selected={view === 'chat'} aria-controls="panel-chat"
            onClick={() => setView('chat')}>Chat</button>
          <button type="button" role="tab" id="tab-settings" aria-selected={view === 'settings'} aria-controls="panel-settings"
            onClick={() => setView('settings')}>Einstellungen</button>
        </div>
        <ul className="topbar-status" aria-label="Aktuelle Auswahl">
          <li className={`chip chip-${connection}`}>{connection === 'ready' ? 'Verbunden' : 'Nicht verbunden'}</li>
          <li className="chip">{projectId ? 'Projekt gewählt' : 'Kein Projekt'}</li>
          <li className="chip">{destination} · {model || '–'}</li>
        </ul>
      </nav>

      {error && <div className="error" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="Schließen">×</button></div>}

      <aside className="settings" id="panel-settings" role="tabpanel" aria-labelledby="tab-settings" hidden={view !== 'settings'}>
        <ol className="steps" aria-label="Einrichtung">
          <li className={connection === 'ready' ? 'done' : ''}><span className="mark" aria-hidden="true" />{connection === 'ready' ? 'Overleaf verbunden' : 'Overleaf verbinden'}</li>
          <li className={apiKey.length >= 10 && modelOk ? 'done' : ''}><span className="mark" aria-hidden="true" />{apiKey.length >= 10 && modelOk ? `Schlüssel für ${destination} gesetzt` : 'API-Schlüssel eintragen'}</li>
          <li className={privacyAck ? 'done' : ''}><span className="mark" aria-hidden="true" />{privacyAck ? 'Datenschutz bestätigt' : 'Datenschutz bestätigen'}</li>
          <li className={grantCount ? 'done' : 'optional'}><span className="mark" aria-hidden="true" />{grantCount ? `${grantCount} Freigabe(n) aktiv` : 'Freigaben optional – ohne nur Lesen'}</li>
        </ol>
        <section className="card">
          <h2>1 · Overleaf</h2>
          <h3 className="sub">Instanz</h3>
          <div className="segmented" role="radiogroup" aria-label="Instanz">
            <button type="button" role="radio" aria-checked={instance === 'hosted'} disabled={scopeLocked}
              onClick={() => changeScope(() => setInstance('hosted'), true)}>overleaf.com</button>
            <button type="button" role="radio" aria-checked={instance === 'self'} disabled={scopeLocked}
              onClick={() => changeScope(() => setInstance('self'), true)}>Self-hosted</button>
          </div>
          {instance === 'self' && (
            <label>Basis-URL
              <input type="url" placeholder="https://overleaf.example.org" value={customUrl} disabled={scopeLocked}
                onChange={event => { const value = event.target.value; changeScope(() => setCustomUrl(value), true); }} />
            </label>
          )}
          <h3 className="sub">Projekt</h3>
          <label>Projekt-Link oder -ID (optional)
            <input placeholder={`${baseUrl || HOSTED_URL}/project/…`} value={projectInput} disabled={scopeLocked} spellCheck={false}
              onChange={event => { const value = event.target.value; changeScope(() => setProjectInput(value)); }} />
          </label>
          {projectInput && !projectId && <p className="hint warn">Keine gültige Projekt-ID erkannt.</p>}
          <p className="hint">Ohne Projekt: nur Lesen und Projektliste. Ändern nur im ausgewählten Projekt.</p>
          <h3 className="sub">Verbindung</h3>
          <div className="row">
            <button type="button" className="primary" disabled={!scope || scopeLocked} onClick={() => void connect()}>
              {connection === 'none' || connection === 'busy' ? 'Browser öffnen' : 'Erneut verbinden'}
            </button>
            <button type="button" disabled={connection === 'none' || scopeLocked} onClick={() => void checkStatus()}>
              {statusBusy ? 'Prüfe …' : 'Verbindung prüfen'}
            </button>
          </div>
          <p className={`status status-${connection}`} aria-live="polite">
            <span className="dot" />{statusText || 'Nicht verbunden.'}
          </p>
          <p className="hint">Anmeldung im separat geöffneten Chromium; der integrierte VS-Code-Browser wird nicht übernommen.</p>
          <button type="button" disabled={connection !== 'ready' || scopeLocked} onClick={() => void loadProjects()}>
            {catalogBusy ? 'Lade Projekte …' : 'Projektliste laden'}
          </button>
          {catalogLoaded && (
            <label>Projekt auswählen ({projects.length})
              <select value={projectId ?? ''} disabled={scopeLocked}
                onChange={event => { const value = event.target.value; changeScope(() => setProjectInput(value)); }}>
                <option value="">Alle Projekte · nur Lesen / Erstellen</option>
                {projectId && !projects.some(project => project.projectId === projectId) && <option value={projectId}>Manuell ausgewähltes Projekt</option>}
                {projects.map(project => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}
              </select>
            </label>
          )}
          {catalogLoaded && !projects.length && <p className="hint">Keine zugänglichen aktiven Projekte gefunden.</p>}
        </section>

        <section className="card">
          <h2>2 · KI-Endpunkt & Modell</h2>
          <label>Endpunkt
            <select value={endpoint.id} disabled={busy} onChange={event => selectEndpoint(event.target.value)}>
              {endpoints.map(item => <option key={item.id} value={item.id}>{item.baseUrl ? (item.name === endpointHost(item.baseUrl) ? item.name : `${item.name} · ${endpointHost(item.baseUrl)}`) : 'OpenAI · api.openai.com'}</option>)}
            </select>
          </label>
          {endpoint.baseUrl ? (
            <label>Modell
              <select value={model} disabled={busy} onChange={event => setModel(event.target.value)}>
                {endpoint.models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
          ) : (
            <label>Modell
              <input list="models" value={model} disabled={busy} onChange={event => setModel(event.target.value)} />
              <datalist id="models">{OPENAI.models.map(item => <option key={item.id} value={item.id} />)}</datalist>
            </label>
          )}
          {modelDef && endpoint.baseUrl && <p className="hint">
            Werkzeugaufrufe: {modelDef.toolCalling ? 'ja' : 'nein (reiner Chat)'} · Vision: {modelDef.vision ? 'ja' : 'nein'}
            {modelDef.maxInputTokens ? ` · Kontext ${modelDef.maxInputTokens.toLocaleString('de-DE')} Tokens` : ''}
            {modelDef.maxOutputTokens ? ` · Antwort max. ${modelDef.maxOutputTokens.toLocaleString('de-DE')} Tokens` : ''}
          </p>}
          <label>API-Schlüssel
            <input type="password" autoComplete="off" spellCheck={false} value={apiKey} disabled={busy}
              onChange={event => { const value = event.target.value.trim(); setKeys(current => ({ ...current, [endpoint.id]: value })); }} placeholder={endpoint.baseUrl ? 'Schlüssel für diesen Endpunkt' : 'sk-…'} />
          </label>
          <p className="hint">Nur im Arbeitsspeicher dieses Tabs, nie gespeichert; Neuladen löscht ihn. Er geht ausschließlich an {destination}. Mindestens 10 Zeichen.</p>
          {endpoint.baseUrl && <div className="row">
            <button type="button" disabled={busy || endpoint.models.length < 2} onClick={removeModel}>Modell entfernen</button>
            <button type="button" className="stop" disabled={busy} onClick={removeEndpoint}>Endpunkt entfernen</button>
          </div>}
          <details className="endpoint-editor">
            <summary>Eigenen Endpunkt hinzufügen oder importieren</summary>
          <p className="hint">OpenAI-kompatible Chat-Completions-Endpunkte, z. B. <code>https://host/api/v1</code> (HTTPS; lokal auch HTTP). Definitionen ohne Schlüssel werden im Browser dieses Rechners gespeichert (localStorage, höchstens {MAX_ENDPOINTS}), Schlüssel nie.</p>
          <form className="endpoint-form" onSubmit={addEndpoint}>
            <label>Endpunkt-URL
              <input type="url" required placeholder="https://host/api/v1" value={endpointForm.url} spellCheck={false}
                onChange={event => setEndpointForm({ ...endpointForm, url: event.target.value })} />
            </label>
            <label>Anzeigename (optional)
              <input value={endpointForm.name} maxLength={100} onChange={event => setEndpointForm({ ...endpointForm, name: event.target.value })} />
            </label>
            <label>Modell-ID
              <input required value={endpointForm.modelId} maxLength={100} spellCheck={false} placeholder="z. B. mein-modell"
                onChange={event => setEndpointForm({ ...endpointForm, modelId: event.target.value })} />
            </label>
            <label>Modellname (optional)
              <input value={endpointForm.modelName} maxLength={100} onChange={event => setEndpointForm({ ...endpointForm, modelName: event.target.value })} />
            </label>
            <label className="check">
              <input type="checkbox" checked={endpointForm.toolCalling} onChange={event => setEndpointForm({ ...endpointForm, toolCalling: event.target.checked })} />
              <span>Modell unterstützt Werkzeugaufrufe (Voraussetzung für Overleaf-Zugriff; sonst reiner Chat)</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={endpointForm.vision} onChange={event => setEndpointForm({ ...endpointForm, vision: event.target.checked })} />
              <span>Modell unterstützt Bilder (nur Information, Bilder werden derzeit nicht gesendet)</span>
            </label>
            <label>Max. Eingabe-Tokens (optional)
              <input type="number" min={1000} max={10000000} value={endpointForm.maxInput} onChange={event => setEndpointForm({ ...endpointForm, maxInput: event.target.value })} />
            </label>
            <label>Max. Ausgabe-Tokens (optional)
              <input type="number" min={1} max={1000000} value={endpointForm.maxOutput} onChange={event => setEndpointForm({ ...endpointForm, maxOutput: event.target.value })} />
            </label>
            <button type="submit" className="primary" disabled={busy}>Endpunkt / Modell speichern</button>
          </form>
          <details className="import">
            <summary>JSON importieren (VS-Code-Format)</summary>
            <p className="hint">Array mit Einträgen <code>name</code>, <code>apiType: "chat-completions"</code> und <code>models</code> (<code>id</code>, <code>name</code>, <code>url</code>, <code>toolCalling</code>, <code>vision</code>, <code>maxInputTokens</code>, <code>maxOutputTokens</code>). Ein enthaltenes <code>apiKey</code> wird ignoriert. Modelle ohne <code>"toolCalling": true</code> laufen als reiner Chat.</p>
            <textarea aria-label="Endpunkt-JSON" rows={8} spellCheck={false} value={importText} onChange={event => setImportText(event.target.value)} />
            <button type="button" disabled={busy || !importText.trim()} onClick={importEndpoints}>Importieren</button>
          </details>
          </details>
          {endpointNote && <p className={`hint${endpointNote.ok ? '' : ' warn'}`} role="status">{endpointNote.text}</p>}
        </section>

        <section className="card">
          <h2>3 · Freigaben</h2>
          <label className="check">
            <input type="checkbox" checked={privacyAck} onChange={event => setPrivacyAck(event.target.checked)} />
            <span>Ich weiß, dass Chat und gelesene Dokumentinhalte an {destination} übermittelt werden.</span>
          </label>
          <label className="check master">
            <input type="checkbox" checked={fullAccess} disabled={!scope || connection !== 'ready' || scopeLocked} onChange={event => setFullAccess(event.target.checked)} />
            <span><strong>Alle Freigaben erteilen</strong> – Schreiben, Projekte erstellen, Projektverwaltung, destruktive Aktionen und Kommentare bleiben bis zum Wechsel von Instanz oder Projekt erlaubt, auch nach jeder Nachricht.</span>
          </label>
          <h3 className="sub">Bis zum Wechsel von Instanz oder Projekt</h3>
          <label className="check danger">
            <input type="checkbox" checked={grant.writes} disabled={mutationsDisabled || fullAccess} onChange={event => setAllowWrites(event.target.checked)} />
            <span><strong>Schreiben:</strong> Die KI darf bestehende Textdateien in diesem Projekt ändern, Dateien und Ordner anlegen, umbenennen, verschieben, Anhänge hochladen und Einstellungen ändern. Auch nachverfolgt, wenn das Protokoll es unterstützt.</span>
          </label>
          <h3 className="sub">Nur für die nächste Nachricht</h3>
          <label className="check danger">
            <input type="checkbox" checked={grant.create} disabled={!scope || connection !== 'ready' || scopeLocked || fullAccess}
              onChange={event => setAllowCreateProjects(event.target.checked)} />
            <span><strong>Projekt erstellen:</strong> maximal einen Versuch zum Erstellen, Kopieren oder ZIP-Import auf dieser Instanz (auch bei Fehler verbraucht).</span>
          </label>
          <label className="check danger">
            <input type="checkbox" checked={grant.manage} disabled={mutationsDisabled || fullAccess}
              onChange={event => setAllowManageProjects(event.target.checked)} />
            <span><strong>Projektverwaltung:</strong> Die KI darf dieses Projekt verwalten (umbenennen, archivieren, wiederherstellen). Papierkorb und Löschen zusätzlich mit der destruktiven Freigabe.</span>
          </label>
          <label className="check danger">
            <input type="checkbox" checked={grant.destructive} disabled={mutationsDisabled || fullAccess}
              onChange={event => setAllowDestructive(event.target.checked)} />
            <span><strong>Destruktiv:</strong> Destruktive Aktionen in diesem Projekt erlauben (Dateien löschen, Uploads überschreiben, Papierkorb, endgültig löschen). Zusätzlich Schreiben bzw. Projektverwaltung nötig.</span>
          </label>
          <label className="check danger">
            <input type="checkbox" checked={grant.comments} disabled={mutationsDisabled || fullAccess}
              onChange={event => setAllowComments(event.target.checked)} />
            <span><strong>Kommentare:</strong> hinzufügen, beantworten, auflösen oder öffnen (separate Kommentarfreigabe).</span>
          </label>
          <h3 className="sub">Sicherheitsnetz</h3>
          <label className="check">
            <input type="checkbox" checked={confirmChanges} disabled={busy} onChange={event => setConfirmChanges(event.target.checked)} />
            <span>Textänderungen und destruktive Aktionen einzeln mit Diff bestätigen (empfohlen). Ohne diese Option führt die KI freigegebene Änderungen direkt aus.</span>
          </label>
          <details className="notes">
            <summary>Hinweise zu Freigaben und Grenzen</summary>
            <p className="hint">Exakte Bestätigungen im Auftrag angeben: confirmName = aktueller Projektname für Archivieren, Papierkorb und Löschen; confirmPath = vollständiger projekt-relativer Pfad für Entitätslöschung und Upload-Überschreiben. Endgültiges Projektlöschen nur aus dem Papierkorb.</p>
            <p className="hint">Erstellen/Kopieren/Import, Projektverwaltung, destruktive Aktionen und Kommentare werden nach jeder Nachricht zurückgesetzt, auch bei Fehler/Abbruch, außer bei „Alle Freigaben erteilen“. Neue Projekte selbst auswählen und neu verbinden.</p>
            <p className="hint warn">Experimenteller Connector über private Web-API und Projekt-Socket, keine nachgewiesene vollständige Kompatibilität. ShareJS und History-OT werden unterstützt; nachverfolgte Änderungen werden nach dem Schreiben geprüft und sonst als Teilergebnis gemeldet, kein stiller Wechsel von tracked zu untracked. Legacy-Aliasse nutzen denselben dokumentgebundenen Connector. Ergebnisse in Overleaf prüfen, keine blinden Wiederholungen.</p>
          </details>
          <details className="capabilities">
            <summary>Werkzeugkatalog · 24 kanonische + 3 Erweiterungen</summary>
            <p className="hint">Angebotener Funktionsumfang, nicht live nachgewiesen. Verfügbarkeit hängt von Freigaben, Anhängen, Instanz und Protokoll ab. Kompilieren/Stoppen nur im ausgewählten, verbundenen Projekt; kann Compile-Kontingent verbrauchen. Statische Prüfung und Vorschau schreiben nicht und ersetzen keine Kompilierung.</p>
            {TOOL_GROUPS.map(group => <section key={group.title}>
              <h3>{group.title}</h3>
              <ul>{group.tools.map(tool => <li key={tool}><code>{tool}</code> · {TOOL_LABELS[tool]}</li>)}</ul>
            </section>)}
          </details>
        </section>
      </aside>

      <main className="chat" id="panel-chat" role="tabpanel" aria-labelledby="tab-chat" hidden={view !== 'chat'}>
        {(missing.length > 0 || endpoint.baseUrl) && <div className="chat-notice">
          {missing.length > 0 && <p className="hint warn">Noch nicht bereit – in den Einstellungen fehlt: {missing.join(', ')}.</p>}
          {endpoint.baseUrl && modelDef && !modelDef.toolCalling && <p className="hint warn">Dieses Modell ist ohne Werkzeugaufrufe konfiguriert: reiner Chat, kein Zugriff auf Overleaf.</p>}
          {missing.length > 0 && <button type="button" onClick={() => setView('settings')}>Einstellungen öffnen</button>}
        </div>}
        <div className="messages" aria-live="polite">
          {messages.length === 0 && (
            <div className="empty">
              <h2>Deine Projekte, ein Chat.</h2>
              <p>„Zeige mir alle Projekte.“ Oder mit Erstellfreigabe: „Erstelle ein leeres Projekt namens Test.“</p>
              <p className="hint">Projektübergreifendes Lesen auf derselben Instanz; Änderungen und Kompilierung nur im ausgewählten Projekt. Erstellen, Kopieren oder ZIP-Import separat freigeben. Dateien, Kommentare und nachverfolgte Änderungen sind protokollabhängig und experimentell. Details im Werkzeugkatalog.</p>
            </div>
          )}
          {messages.map((entry, index) => (
            <article key={index} className={`bubble ${entry.role}${entry.local ? ' local' : ''}`}>
              <div className="content">{entry.content}</div>
              {!!entry.attachments?.length && <ul className="attachment-list" aria-label="Gesendete Anhang-Metadaten">
                {entry.attachments.map(item => <li key={item.id}>{item.name} · ID: {item.id} (nur diese Nachricht)</li>)}
              </ul>}
              {!!entry.downloads?.length && <div className="downloads" aria-label="Downloads dieser Antwort">
                <p className="hint">Nur im Arbeitsspeicher. Speichern ausschließlich per Klick; Dateien vor dem Öffnen prüfen.</p>
                {entry.downloads.map((download, i) => <button type="button" key={i}
                  aria-label={`Download ${download.name}`} onClick={() => {
                    try { downloadFile(download); } catch { setError('Download konnte nicht bereitgestellt werden.'); }
                  }}>Download: {download.name}</button>)}
              </div>}
              {!!entry.proposals?.length && <div className="proposals" aria-label="Änderungsvorschläge">
                <p className="hint">Noch nicht ausgeführt. Jede Änderung einzeln prüfen; Revision und Bestätigungen werden beim Übernehmen erneut geprüft.</p>
                {(() => {
                  const pending = entry.proposals.filter(proposal => !decisions[proposal.id]);
                  const destructive = pending.filter(proposal => proposal.destructive).length;
                  return pending.length > 1 && <div className="row bulk">
                    <button type="button" className="primary" disabled={busy || scopeLocked} onClick={() => void decideAll(entry, 'apply')}>
                      Alle übernehmen ({pending.length}{destructive ? `, davon ${destructive} destruktiv` : ''})</button>
                    <button type="button" disabled={busy || scopeLocked} onClick={() => void decideAll(entry, 'discard')}>Alle verwerfen ({pending.length})</button>
                  </div>;
                })()}
                {entry.proposals.map(proposal => {
                  const decision = decisions[proposal.id];
                  return <section key={proposal.id} className={`proposal${proposal.destructive ? ' destructive' : ''}`} aria-label={`Vorschlag: ${proposal.title}`}>
                    <h3>{proposal.destructive ? 'Destruktiv: ' : ''}{proposal.title}</h3>
                    <p className="hint"><code>{proposal.target}</code> · gültig bis {new Date(proposal.expiresAt).toLocaleTimeString()}</p>
                    {proposal.diff && <pre className="diff">{proposal.diff}</pre>}
                    {proposal.truncated && <p className="hint">Vorschau gekürzt.</p>}
                    {decision?.message && <p className={`hint${decision.status === 'failed' ? ' warn' : ''}`} role="status">{decision.message}</p>}
                    {!decision && <div className="row">
                      <button type="button" className={proposal.destructive ? 'stop' : 'primary'} disabled={busy || scopeLocked}
                        onClick={() => void decide(proposal, 'apply')}>Übernehmen</button>
                      <button type="button" disabled={busy || scopeLocked} onClick={() => void decide(proposal, 'discard')}>Verwerfen</button>
                    </div>}
                  </section>;
                })}
              </div>}
              {entry.activity && entry.activity.length > 0 && (
                <ul className="activity">
                  {entry.activity.map((item, i) => (
                    <li key={i} className={item.ok ? 'ok' : 'fail'}>{TOOL_LABELS[item.tool] ?? item.tool}{item.ok ? '' : ' – fehlgeschlagen'}</li>
                  ))}
                </ul>
              )}
            </article>
          ))}
          {busy && <article className="bubble assistant pending"><span className="typing"><i /><i /><i /></span></article>}
          <div ref={endRef} />
        </div>

        <form className="composer" onSubmit={event => void send(event)}>
          <div className="composer-fields">
          <label className="attachment-picker">Dateien anhängen (max. 3 × 512 KiB; gesamt 1,5 MiB)
            <input ref={attachmentRef} type="file" multiple aria-label="Dateien anhängen" disabled={scopeLocked || attachmentBusy}
              onChange={event => void pickAttachments(Array.from(event.target.files ?? []))} />
          </label>
          {attachmentBusy && <p className="hint" role="status">Anhänge werden lokal gelesen …</p>}
          {!!attachments.length && <ul className="attachment-list" aria-label="Ausgewählte Anhänge">
            {attachments.map(item => <li key={item.id}><span>{item.name} · ID: {item.id}</span>
              <button type="button" disabled={busy} aria-label={`Anhang ${item.name} entfernen`}
                onClick={() => setAttachments(current => current.filter(attachment => attachment.id !== item.id))}>Entfernen</button></li>)}
          </ul>}
          <p className="hint">Im Auftrag Dateiname oder Anhang-ID nennen, z. B. „Lade Anhang [ID] als figures/bild.png hoch“. Nur ID/Name gehen als Metadaten ans Modell, keine Anhangbytes. Upload/ZIP-Import über den lokalen Server; nichts wird dauerhaft gespeichert. Anhänge werden nach Senden (auch Fehler/Abbruch) und Scope-Wechsel entfernt.</p>
          <textarea aria-label="Nachricht" value={input} maxLength={MAX_MESSAGE} rows={3} onKeyDown={onKeyDown}
            onChange={event => setInput(event.target.value)}
            placeholder={missing.length ? `Zuerst: ${missing.join(', ')}` : 'Nachricht … (Enter senden, Umschalt+Enter Zeilenumbruch)'} />
          </div>
          {busy
            ? <button type="button" className="stop" onClick={() => abortRef.current?.abort()}>Abbrechen</button>
            : <button type="submit" className="primary" disabled={!canSend}>Senden</button>}
        </form>
      </main>
    </div>
  );
}
