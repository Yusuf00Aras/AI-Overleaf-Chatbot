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
  list_projects: 'Projects listed', create_project: 'Project created',
  auth_status: 'Login checked', clone_project: 'Project copied', import_project_zip: 'ZIP imported',
  manage_project: 'Project managed', update_project_settings: 'Settings changed',
  get_project_tree: 'Project tree read', read_file: 'File read', write_file: 'Text file changed',
  create_file: 'Text file created', manage_entity: 'File/folder managed', upload_file: 'Attachment uploaded',
  download_file: 'Download provided', get_sections: 'Sections listed',
  get_section_content: 'Section read', write_section: 'Section changed',
  compile_project: 'Compilation processed', stop_compile: 'Compilation stopped',
  list_comments: 'Comments read', reply_to_comment: 'Comment replied to',
  add_comment: 'Comment added', set_comment_status: 'Comment status changed',
  monitor_project_history: 'History queried', validate_latex: 'Statically checked (no compile)',
  preview_edit: 'Edit preview (no write)', describe_capabilities: 'Capabilities described',
  read_document: 'Read', write_document: 'Written', compile_document: 'Compilation requested',
};
const MAX_MESSAGE = 30_000;
const MAX_ATTACHMENT_BYTES = 512 * 1024;
const TOOL_GROUPS = [
  { title: 'Login & projects', tools: ['auth_status', 'list_projects', 'create_project', 'clone_project', 'import_project_zip', 'manage_project', 'update_project_settings'] },
  { title: 'Files & sections', tools: ['get_project_tree', 'read_file', 'write_file', 'create_file', 'manage_entity', 'upload_file', 'download_file', 'get_sections', 'get_section_content', 'write_section'] },
  { title: 'Compilation, comments & history', tools: ['compile_project', 'stop_compile', 'list_comments', 'reply_to_comment', 'add_comment', 'set_comment_status', 'monitor_project_history'] },
  { title: '3 local extensions', tools: ['validate_latex', 'preview_edit', 'describe_capabilities'] },
  { title: 'Legacy aliases', tools: ['read_document', 'write_document', 'compile_document'] },
];

function readAttachment(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Attachment could not be read.'));
    reader.onabort = () => reject(new Error('Reading the attachment was aborted.'));
    reader.onload = () => typeof reader.result === 'string' && reader.result.includes(',')
      ? resolve(reader.result.slice(reader.result.indexOf(',') + 1))
      : reject(new Error('Attachment could not be encoded.'));
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
      setEndpointNote({ ok: true, text: `Model “${added.name}” saved and selected. Enter the API key below.` });
    } catch (err) { setEndpointNote({ ok: false, text: (err as Error).message }); }
  }

  function importEndpoints() {
    try {
      const incoming = parseEndpoints(importText);
      applyEndpoints(incoming);
      setImportText('');
      setEndpointNote({ ok: true, text: `Imported ${incoming.length} endpoint(s) with ${incoming.reduce((total, item) => total + item.models.length, 0)} model(s). Any included API keys were ignored.` });
    } catch (err) { setEndpointNote({ ok: false, text: (err as Error).message }); }
  }

  function removeEndpoint() {
    if (!endpoint.baseUrl) return;
    setCustom(current => current.filter(item => item.id !== endpoint.id));
    setKeys(current => { const { [endpoint.id]: _removed, ...rest } = current; return rest; });
    selectEndpoint(OPENAI.id);
    setEndpointNote({ ok: true, text: 'Endpoint removed.' });
  }

  function removeModel() {
    if (!endpoint.baseUrl || endpoint.models.length < 2) return;
    const rest = endpoint.models.filter(item => item.id !== model);
    setCustom(current => current.map(item => item.id === endpoint.id ? { ...item, models: rest } : item));
    setModel(rest[0]!.id);
    setEndpointNote({ ok: true, text: 'Model removed.' });
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
      setError('At most 3 attachments, 512 KiB each and 1.5 MiB in total.');
      return;
    }
    if (files.some(file => !file.name.trim() || file.name.length > 150 || /[/\\\x00-\x1f\x7f-\x9f]/.test(file.name) || ['.', '..'].includes(file.name))) {
      setError('Invalid attachment name (at most 150 characters, no paths or control characters).');
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
    setStatusText('Opening browser …');
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
        ? { status: 'applied', message: `Applied${details ? ` (${details})` : ''}. Have the file re-read before making further changes.` }
        : { status: 'discarded', message: 'Discarded. Nothing changed.' } }));
    } catch (err) {
      if (request !== requestRef.current) return;
      setDecisions(current => ({ ...current, [proposal.id]: { status: 'failed', message: `Not applied: ${(err as Error).message} Proposal used up; do not retry blindly.` } }));
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
      setMessages(current => [...current, { role: 'assistant', content: result.reply || 'Done.', activity: result.activity, downloads: result.downloads, proposals: result.proposals }]);
    } catch (err) {
      if (controller.signal.aborted) {
        setMessages(current => [...current, { role: 'assistant', local: true,
          content: 'Cancelled. Changes that were already made remain in place – check the document in the Overleaf browser.' }]);
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
    !scope && 'valid instance / project selection',
    scope && connection !== 'ready' && 'check connection',
    apiKey.length < 10 && 'API key (Settings)',
    !modelOk && 'model',
    !privacyAck && 'privacy notice (Settings)',
  ].filter(Boolean);

  return (
    <div className="layout">
      <nav className="topbar" aria-label="Main navigation">
        <div className="brand">
          <h1>Overleaf Chat Studio</h1>
          <span className="badge">experimental</span>
        </div>
        <div className="tabs" role="tablist" aria-label="Sections">
          <button type="button" role="tab" id="tab-chat" aria-selected={view === 'chat'} aria-controls="panel-chat"
            onClick={() => setView('chat')}>Chat</button>
          <button type="button" role="tab" id="tab-settings" aria-selected={view === 'settings'} aria-controls="panel-settings"
            onClick={() => setView('settings')}>Settings</button>
        </div>
        <ul className="topbar-status" aria-label="Current selection">
          <li className={`chip chip-${connection}`}>{connection === 'ready' ? 'Connected' : 'Not connected'}</li>
          <li className="chip">{projectId ? 'Project selected' : 'No project'}</li>
          <li className="chip">{destination} · {model || '–'}</li>
        </ul>
      </nav>

      {error && <div className="error" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="Close">×</button></div>}

      <aside className="settings" id="panel-settings" role="tabpanel" aria-labelledby="tab-settings" hidden={view !== 'settings'}>
        <ol className="steps" aria-label="Setup">
          <li className={connection === 'ready' ? 'done' : ''}><span className="mark" aria-hidden="true" />{connection === 'ready' ? 'Overleaf connected' : 'Connect Overleaf'}</li>
          <li className={apiKey.length >= 10 && modelOk ? 'done' : ''}><span className="mark" aria-hidden="true" />{apiKey.length >= 10 && modelOk ? `API key for ${destination} set` : 'Enter API key'}</li>
          <li className={privacyAck ? 'done' : ''}><span className="mark" aria-hidden="true" />{privacyAck ? 'Privacy acknowledged' : 'Acknowledge privacy'}</li>
          <li className={grantCount ? 'done' : 'optional'}><span className="mark" aria-hidden="true" />{grantCount ? `${grantCount} permission(s) active` : 'Permissions optional – read-only without them'}</li>
        </ol>
        <section className="card">
          <h2>1 · Overleaf</h2>
          <h3 className="sub">Instance</h3>
          <div className="segmented" role="radiogroup" aria-label="Instance">
            <button type="button" role="radio" aria-checked={instance === 'hosted'} disabled={scopeLocked}
              onClick={() => changeScope(() => setInstance('hosted'), true)}>overleaf.com</button>
            <button type="button" role="radio" aria-checked={instance === 'self'} disabled={scopeLocked}
              onClick={() => changeScope(() => setInstance('self'), true)}>Self-hosted</button>
          </div>
          {instance === 'self' && (
            <label>Base URL
              <input type="url" placeholder="https://overleaf.example.org" value={customUrl} disabled={scopeLocked}
                onChange={event => { const value = event.target.value; changeScope(() => setCustomUrl(value), true); }} />
            </label>
          )}
          <h3 className="sub">Project</h3>
          <label>Project link or ID (optional)
            <input placeholder={`${baseUrl || HOSTED_URL}/project/…`} value={projectInput} disabled={scopeLocked} spellCheck={false}
              onChange={event => { const value = event.target.value; changeScope(() => setProjectInput(value)); }} />
          </label>
          {projectInput && !projectId && <p className="hint warn">No valid project ID recognized.</p>}
          <p className="hint">Without a project: read-only and project list. Changes only in the selected project.</p>
          <h3 className="sub">Connection</h3>
          <div className="row">
            <button type="button" className="primary" disabled={!scope || scopeLocked} onClick={() => void connect()}>
              {connection === 'none' || connection === 'busy' ? 'Open browser' : 'Reconnect'}
            </button>
            <button type="button" disabled={connection === 'none' || scopeLocked} onClick={() => void checkStatus()}>
              {statusBusy ? 'Checking …' : 'Check connection'}
            </button>
          </div>
          <p className={`status status-${connection}`} aria-live="polite">
            <span className="dot" />{statusText || 'Not connected.'}
          </p>
          <p className="hint">Log in in the separately opened Chromium; the integrated VS Code browser is not used.</p>
          <button type="button" disabled={connection !== 'ready' || scopeLocked} onClick={() => void loadProjects()}>
            {catalogBusy ? 'Loading projects …' : 'Load project list'}
          </button>
          {catalogLoaded && (
            <label>Select project ({projects.length})
              <select value={projectId ?? ''} disabled={scopeLocked}
                onChange={event => { const value = event.target.value; changeScope(() => setProjectInput(value)); }}>
                <option value="">All projects · read / create only</option>
                {projectId && !projects.some(project => project.projectId === projectId) && <option value={projectId}>Manually selected project</option>}
                {projects.map(project => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}
              </select>
            </label>
          )}
          {catalogLoaded && !projects.length && <p className="hint">No accessible active projects found.</p>}
        </section>

        <section className="card">
          <h2>2 · AI endpoint & model</h2>
          <label>Endpoint
            <select value={endpoint.id} disabled={busy} onChange={event => selectEndpoint(event.target.value)}>
              {endpoints.map(item => <option key={item.id} value={item.id}>{item.baseUrl ? (item.name === endpointHost(item.baseUrl) ? item.name : `${item.name} · ${endpointHost(item.baseUrl)}`) : 'OpenAI · api.openai.com'}</option>)}
            </select>
          </label>
          {endpoint.baseUrl ? (
            <label>Model
              <select value={model} disabled={busy} onChange={event => setModel(event.target.value)}>
                {endpoint.models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
          ) : (
            <label>Model
              <input list="models" value={model} disabled={busy} onChange={event => setModel(event.target.value)} />
              <datalist id="models">{OPENAI.models.map(item => <option key={item.id} value={item.id} />)}</datalist>
            </label>
          )}
          {modelDef && endpoint.baseUrl && <p className="hint">
            Tool calls: {modelDef.toolCalling ? 'yes' : 'no (chat only)'} · Vision: {modelDef.vision ? 'yes' : 'no'}
            {modelDef.maxInputTokens ? ` · Context ${modelDef.maxInputTokens.toLocaleString('en-US')} tokens` : ''}
            {modelDef.maxOutputTokens ? ` · Reply max. ${modelDef.maxOutputTokens.toLocaleString('en-US')} tokens` : ''}
          </p>}
          <label>API key
            <input type="password" autoComplete="off" spellCheck={false} value={apiKey} disabled={busy}
              onChange={event => { const value = event.target.value.trim(); setKeys(current => ({ ...current, [endpoint.id]: value })); }} placeholder={endpoint.baseUrl ? 'Key for this endpoint' : 'sk-…'} />
          </label>
          <p className="hint">Held only in this tab's memory, never stored; reloading clears it. It is sent only to {destination}. At least 10 characters.</p>
          {endpoint.baseUrl && <div className="row">
            <button type="button" disabled={busy || endpoint.models.length < 2} onClick={removeModel}>Remove model</button>
            <button type="button" className="stop" disabled={busy} onClick={removeEndpoint}>Remove endpoint</button>
          </div>}
          <details className="endpoint-editor">
            <summary>Add or import a custom endpoint</summary>
          <p className="hint">OpenAI-compatible chat-completions endpoints, e.g. <code>https://host/api/v1</code> (HTTPS; HTTP is also allowed locally). Definitions without keys are stored in this computer's browser (localStorage, at most {MAX_ENDPOINTS}); keys never are.</p>
          <form className="endpoint-form" onSubmit={addEndpoint}>
            <label>Endpoint URL
              <input type="url" required placeholder="https://host/api/v1" value={endpointForm.url} spellCheck={false}
                onChange={event => setEndpointForm({ ...endpointForm, url: event.target.value })} />
            </label>
            <label>Display name (optional)
              <input value={endpointForm.name} maxLength={100} onChange={event => setEndpointForm({ ...endpointForm, name: event.target.value })} />
            </label>
            <label>Model ID
              <input required value={endpointForm.modelId} maxLength={100} spellCheck={false} placeholder="e.g. my-model"
                onChange={event => setEndpointForm({ ...endpointForm, modelId: event.target.value })} />
            </label>
            <label>Model name (optional)
              <input value={endpointForm.modelName} maxLength={100} onChange={event => setEndpointForm({ ...endpointForm, modelName: event.target.value })} />
            </label>
            <label className="check">
              <input type="checkbox" checked={endpointForm.toolCalling} onChange={event => setEndpointForm({ ...endpointForm, toolCalling: event.target.checked })} />
              <span>Model supports tool calls (required for Overleaf access; otherwise chat only)</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={endpointForm.vision} onChange={event => setEndpointForm({ ...endpointForm, vision: event.target.checked })} />
              <span>Model supports images (informational only; images are currently not sent)</span>
            </label>
            <label>Max. input tokens (optional)
              <input type="number" min={1000} max={10000000} value={endpointForm.maxInput} onChange={event => setEndpointForm({ ...endpointForm, maxInput: event.target.value })} />
            </label>
            <label>Max. output tokens (optional)
              <input type="number" min={1} max={1000000} value={endpointForm.maxOutput} onChange={event => setEndpointForm({ ...endpointForm, maxOutput: event.target.value })} />
            </label>
            <button type="submit" className="primary" disabled={busy}>Save endpoint / model</button>
          </form>
          <details className="import">
            <summary>Import JSON (VS Code format)</summary>
            <p className="hint">Array of entries with <code>name</code>, <code>apiType: "chat-completions"</code> and <code>models</code> (<code>id</code>, <code>name</code>, <code>url</code>, <code>toolCalling</code>, <code>vision</code>, <code>maxInputTokens</code>, <code>maxOutputTokens</code>). An included <code>apiKey</code> is ignored. Models without <code>"toolCalling": true</code> run as chat only.</p>
            <textarea aria-label="Endpoint JSON" rows={8} spellCheck={false} value={importText} onChange={event => setImportText(event.target.value)} />
            <button type="button" disabled={busy || !importText.trim()} onClick={importEndpoints}>Import</button>
          </details>
          </details>
          {endpointNote && <p className={`hint${endpointNote.ok ? '' : ' warn'}`} role="status">{endpointNote.text}</p>}
        </section>

        <section className="card">
          <h2>3 · Permissions</h2>
          <label className="check">
            <input type="checkbox" checked={privacyAck} onChange={event => setPrivacyAck(event.target.checked)} />
            <span>I understand that the chat and any document content that is read are sent to {destination}.</span>
          </label>
          <label className="check master">
            <input type="checkbox" checked={fullAccess} disabled={!scope || connection !== 'ready' || scopeLocked} onChange={event => setFullAccess(event.target.checked)} />
            <span><strong>Grant all permissions</strong> – writing, creating projects, project management, destructive actions and comments stay allowed until the instance or project changes, even after every message.</span>
          </label>
          <h3 className="sub">Until the instance or project changes</h3>
          <label className="check danger">
            <input type="checkbox" checked={grant.writes} disabled={mutationsDisabled || fullAccess} onChange={event => setAllowWrites(event.target.checked)} />
            <span><strong>Write:</strong> The AI may change existing text files in this project, create, rename and move files and folders, upload attachments and change settings. Also tracked, if the protocol supports it.</span>
          </label>
          <h3 className="sub">For the next message only</h3>
          <label className="check danger">
            <input type="checkbox" checked={grant.create} disabled={!scope || connection !== 'ready' || scopeLocked || fullAccess}
              onChange={event => setAllowCreateProjects(event.target.checked)} />
            <span><strong>Create project:</strong> at most one attempt to create, copy or import a ZIP on this instance (used up even on failure).</span>
          </label>
          <label className="check danger">
            <input type="checkbox" checked={grant.manage} disabled={mutationsDisabled || fullAccess}
              onChange={event => setAllowManageProjects(event.target.checked)} />
            <span><strong>Project management:</strong> The AI may manage this project (rename, archive, restore). Trash and delete additionally require the destructive permission.</span>
          </label>
          <label className="check danger">
            <input type="checkbox" checked={grant.destructive} disabled={mutationsDisabled || fullAccess}
              onChange={event => setAllowDestructive(event.target.checked)} />
            <span><strong>Destructive:</strong> Allow destructive actions in this project (delete files, overwrite uploads, trash, delete permanently). Write or project management permission is additionally required.</span>
          </label>
          <label className="check danger">
            <input type="checkbox" checked={grant.comments} disabled={mutationsDisabled || fullAccess}
              onChange={event => setAllowComments(event.target.checked)} />
            <span><strong>Comments:</strong> add, reply to, resolve or reopen (separate comment permission).</span>
          </label>
          <h3 className="sub">Safety net</h3>
          <label className="check">
            <input type="checkbox" checked={confirmChanges} disabled={busy} onChange={event => setConfirmChanges(event.target.checked)} />
            <span>Confirm each change with a diff for text changes and destructive actions (recommended). Without this option the AI runs permitted changes directly.</span>
          </label>
          <details className="notes">
            <summary>Notes on permissions and limits</summary>
            <p className="hint">State exact confirmations in the request: confirmName = current project name for archiving, trash and delete; confirmPath = full project-relative path for entity deletion and upload overwrite. Permanent project deletion only from the trash.</p>
            <p className="hint">Create/copy/import, project management, destructive actions and comments are reset after every message, also on error/cancellation, except with “Grant all permissions”. Select new projects yourself and reconnect.</p>
            <p className="hint warn">Experimental connector via the private web API and project socket, no proven full compatibility. ShareJS and history OT are supported; tracked changes are verified after writing and otherwise reported as a partial result, with no silent switch from tracked to untracked. Legacy aliases use the same document-bound connector. Check results in Overleaf, no blind retries.</p>
          </details>
          <details className="capabilities">
            <summary>Tool catalog · 24 canonical + 3 extensions</summary>
            <p className="hint">Offered functionality, not verified live. Availability depends on permissions, attachments, instance and protocol. Compile/stop only in the selected, connected project; may consume compile quota. Static checks and preview do not write and do not replace compilation.</p>
            {TOOL_GROUPS.map(group => <section key={group.title}>
              <h3>{group.title}</h3>
              <ul>{group.tools.map(tool => <li key={tool}><code>{tool}</code> · {TOOL_LABELS[tool]}</li>)}</ul>
            </section>)}
          </details>
        </section>
      </aside>

      <main className="chat" id="panel-chat" role="tabpanel" aria-labelledby="tab-chat" hidden={view !== 'chat'}>
        {(missing.length > 0 || endpoint.baseUrl) && <div className="chat-notice">
          {missing.length > 0 && <p className="hint warn">Not ready yet – missing in Settings: {missing.join(', ')}.</p>}
          {endpoint.baseUrl && modelDef && !modelDef.toolCalling && <p className="hint warn">This model is configured without tool calls: chat only, no access to Overleaf.</p>}
          {missing.length > 0 && <button type="button" onClick={() => setView('settings')}>Open Settings</button>}
        </div>}
        <div className="messages" aria-live="polite">
          {messages.length === 0 && (
            <div className="empty">
              <h2>Your projects, one chat.</h2>
              <p>“Show me all projects.” Or, with the create permission: “Create an empty project named Test.”</p>
              <p className="hint">Cross-project reading on the same instance; changes and compilation only in the selected project. Grant create, copy or ZIP import permission separately. Files, comments and tracked changes depend on the protocol and are experimental. Details in the tool catalog.</p>
            </div>
          )}
          {messages.map((entry, index) => (
            <article key={index} className={`bubble ${entry.role}${entry.local ? ' local' : ''}`}>
              <div className="content">{entry.content}</div>
              {!!entry.attachments?.length && <ul className="attachment-list" aria-label="Sent attachment metadata">
                {entry.attachments.map(item => <li key={item.id}>{item.name} · ID: {item.id} (this message only)</li>)}
              </ul>}
              {!!entry.downloads?.length && <div className="downloads" aria-label="Downloads of this reply">
                <p className="hint">In memory only. Save only by clicking; check files before opening them.</p>
                {entry.downloads.map((download, i) => <button type="button" key={i}
                  aria-label={`Download ${download.name}`} onClick={() => {
                    try { downloadFile(download); } catch { setError('Download could not be provided.'); }
                  }}>Download: {download.name}</button>)}
              </div>}
              {!!entry.proposals?.length && <div className="proposals" aria-label="Change proposals">
                <p className="hint">Not executed yet. Review each change individually; revision and confirmations are checked again on apply.</p>
                {(() => {
                  const pending = entry.proposals.filter(proposal => !decisions[proposal.id]);
                  const destructive = pending.filter(proposal => proposal.destructive).length;
                  return pending.length > 1 && <div className="row bulk">
                    <button type="button" className="primary" disabled={busy || scopeLocked} onClick={() => void decideAll(entry, 'apply')}>
                      Apply all ({pending.length}{destructive ? `, ${destructive} destructive` : ''})</button>
                    <button type="button" disabled={busy || scopeLocked} onClick={() => void decideAll(entry, 'discard')}>Discard all ({pending.length})</button>
                  </div>;
                })()}
                {entry.proposals.map(proposal => {
                  const decision = decisions[proposal.id];
                  return <section key={proposal.id} className={`proposal${proposal.destructive ? ' destructive' : ''}`} aria-label={`Proposal: ${proposal.title}`}>
                    <h3>{proposal.destructive ? 'Destructive: ' : ''}{proposal.title}</h3>
                    <p className="hint"><code>{proposal.target}</code> · valid until {new Date(proposal.expiresAt).toLocaleTimeString()}</p>
                    {proposal.diff && <pre className="diff">{proposal.diff}</pre>}
                    {proposal.truncated && <p className="hint">Preview truncated.</p>}
                    {decision?.message && <p className={`hint${decision.status === 'failed' ? ' warn' : ''}`} role="status">{decision.message}</p>}
                    {!decision && <div className="row">
                      <button type="button" className={proposal.destructive ? 'stop' : 'primary'} disabled={busy || scopeLocked}
                        onClick={() => void decide(proposal, 'apply')}>Apply</button>
                      <button type="button" disabled={busy || scopeLocked} onClick={() => void decide(proposal, 'discard')}>Discard</button>
                    </div>}
                  </section>;
                })}
              </div>}
              {entry.activity && entry.activity.length > 0 && (
                <ul className="activity">
                  {entry.activity.map((item, i) => (
                    <li key={i} className={item.ok ? 'ok' : 'fail'}>{TOOL_LABELS[item.tool] ?? item.tool}{item.ok ? '' : ' – failed'}</li>
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
          <label className="attachment-picker">Attach files (max. 3 × 512 KiB; 1.5 MiB total)
            <input ref={attachmentRef} type="file" multiple aria-label="Attach files" disabled={scopeLocked || attachmentBusy}
              onChange={event => void pickAttachments(Array.from(event.target.files ?? []))} />
          </label>
          {attachmentBusy && <p className="hint" role="status">Attachments are being read locally …</p>}
          {!!attachments.length && <ul className="attachment-list" aria-label="Selected attachments">
            {attachments.map(item => <li key={item.id}><span>{item.name} · ID: {item.id}</span>
              <button type="button" disabled={busy} aria-label={`Remove attachment ${item.name}`}
                onClick={() => setAttachments(current => current.filter(attachment => attachment.id !== item.id))}>Remove</button></li>)}
          </ul>}
          <p className="hint">In the request, name the file or attachment ID, e.g. “Upload attachment [ID] as figures/image.png”. Only the ID/name is sent to the model as metadata, never the attachment bytes. Upload/ZIP import goes through the local server; nothing is stored permanently. Attachments are removed after sending (including on error/cancellation) and on scope change.</p>
          <textarea aria-label="Message" value={input} maxLength={MAX_MESSAGE} rows={3} onKeyDown={onKeyDown}
            onChange={event => setInput(event.target.value)}
            placeholder={missing.length ? `First: ${missing.join(', ')}` : 'Message … (Enter to send, Shift+Enter for a new line)'} />
          </div>
          {busy
            ? <button type="button" className="stop" onClick={() => abortRef.current?.abort()}>Cancel</button>
            : <button type="submit" className="primary" disabled={!canSend}>Send</button>}
        </form>
      </main>
    </div>
  );
}
