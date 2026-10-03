export interface Scope { baseUrl: string; projectId?: string }
export interface ProjectInfo { projectId: string; name: string; url: string }
export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface ToolActivity { tool: string; ok: boolean }
export interface Attachment { id: string; name: string; dataBase64: string }
export interface Download { name: string; mimeType: string; dataBase64: string }
export interface Proposal { id: string; tool: string; title: string; target: string; destructive: boolean; diff?: string; truncated?: boolean; expiresAt: string }
export interface ChatResponse { reply: string; activity: ToolActivity[]; downloads?: Download[]; proposals?: Proposal[] }
export interface DecisionResponse { status: 'applied' | 'discarded'; result?: Record<string, unknown> }

let token: Promise<string> | undefined;

function sessionToken(): Promise<string> {
  token ??= fetch('/api/session', { cache: 'no-store' })
    .then(async response => {
      if (!response.ok) throw new Error('Lokaler Server nicht erreichbar oder Anfrage abgelehnt.');
      return ((await response.json()) as { token: string }).token;
    })
    .catch(error => { token = undefined; throw error; });
  return token;
}

export async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, {
      method: 'POST', signal, cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': await sessionToken() },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('Lokaler Server nicht erreichbar.');
  }
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    if (response.status === 403) token = undefined;
    throw new Error(data.error ?? `Fehler ${response.status}.`);
  }
  return data;
}
