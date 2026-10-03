/** User-defined OpenAI-compatible (chat-completions) endpoints. API keys are never part of these definitions. */
export interface ModelDef { id: string; name: string; toolCalling: boolean; vision: boolean; maxInputTokens?: number; maxOutputTokens?: number }
export interface Endpoint { id: string; name: string; baseUrl: string; models: ModelDef[] }

export const OPENAI: Endpoint = {
  id: 'openai', name: 'OpenAI', baseUrl: '',
  models: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini'].map(id => ({ id, name: id, toolCalling: true, vision: false })),
};

export const MAX_ENDPOINTS = 20;
export const MAX_MODELS = 50;
const STORAGE_KEY = 'studio.endpoints.v1';
const URL_ERROR = 'Eine HTTPS-Basis-URL ohne Zugangsdaten, Query oder Fragment ist erforderlich (lokal auch HTTP; keine Link-Local-Adressen).';

/** Mirrors the server rule, which stays authoritative. */
export function endpointUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error(URL_ERROR); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash ||
    /^169\.254\./.test(url.hostname) || /^\[fe[89ab]/i.test(url.hostname)) throw new Error(URL_ERROR);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export const endpointHost = (baseUrl: string) => { try { return new URL(baseUrl).host; } catch { return baseUrl; } };

const count = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim() && value.trim().length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : undefined;

export function toModel(raw: Record<string, unknown>): ModelDef {
  const id = text(raw.id, 100);
  if (!id) throw new Error('Modell-ID fehlt oder ist ungültig (höchstens 100 Zeichen).');
  const maxInputTokens = count(raw.maxInputTokens, 1000, 10_000_000), maxOutputTokens = count(raw.maxOutputTokens, 1, 1_000_000);
  return { id, name: text(raw.name, 100) ?? id, toolCalling: raw.toolCalling === true, vision: raw.vision === true,
    ...(maxInputTokens ? { maxInputTokens } : {}), ...(maxOutputTokens ? { maxOutputTokens } : {}) };
}

export function mergeEndpoints(existing: Endpoint[], incoming: Endpoint[]): Endpoint[] {
  const result = existing.map(endpoint => ({ ...endpoint, models: [...endpoint.models] }));
  for (const item of incoming) {
    const target = result.find(endpoint => endpoint.baseUrl === item.baseUrl);
    if (!target) { result.push({ ...item, models: [...item.models] }); continue; }
    if (item.name !== endpointHost(item.baseUrl)) target.name = item.name;
    for (const model of item.models) {
      const at = target.models.findIndex(known => known.id === model.id);
      if (at >= 0) target.models[at] = model; else target.models.push(model);
    }
  }
  if (result.length > MAX_ENDPOINTS || result.some(endpoint => endpoint.models.length > MAX_MODELS)) throw new Error(`Höchstens ${MAX_ENDPOINTS} Endpunkte mit je ${MAX_MODELS} Modellen.`);
  return result;
}

/**
 * Accepts the VS Code "customendpoint" provider format (array or single object). `apiKey` is deliberately never read.
 * Models without `"toolCalling": true` run as plain chat without Overleaf tools.
 */
export function parseEndpoints(source: string): Endpoint[] {
  let data: unknown;
  try { data = JSON.parse(source); } catch { throw new Error('Kein gültiges JSON.'); }
  const entries = Array.isArray(data) ? data : [data];
  if (!entries.length || entries.length > MAX_ENDPOINTS) throw new Error(`Zwischen 1 und ${MAX_ENDPOINTS} Einträge erwartet.`);
  let result: Endpoint[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Jeder Eintrag muss ein Objekt sein.');
    const record = entry as Record<string, unknown>;
    const rawName = text(record.name, 300);
    const label = rawName ?? 'Eintrag';
    if (record.apiType !== undefined && record.apiType !== 'chat-completions') throw new Error(`„${label}“: apiType „${String(record.apiType)}“ wird nicht unterstützt (nur chat-completions).`);
    if (!Array.isArray(record.models) || !record.models.length) throw new Error(`„${label}“: Mindestens ein Modell erforderlich.`);
    const fallbackUrl = text(record.url, 300) ?? text(record.baseUrl, 300) ?? (/^https?:\/\//i.test(label) ? label : undefined);
    const groups = new Map<string, ModelDef[]>();
    for (const rawModel of record.models) {
      if (!rawModel || typeof rawModel !== 'object') throw new Error(`„${label}“: Ungültiger Modelleintrag.`);
      const model = rawModel as Record<string, unknown>;
      const url = text(model.url, 300) ?? fallbackUrl;
      if (!url) throw new Error(`„${label}“: Keine URL angegeben.`);
      const base = endpointUrl(url);
      groups.set(base, [...(groups.get(base) ?? []), toModel(model)]);
    }
    const named = rawName && !/^https?:\/\//i.test(rawName) ? rawName : undefined;
    result = mergeEndpoints(result, [...groups].map(([baseUrl, models]) => ({ id: `custom:${baseUrl}`, name: named ?? endpointHost(baseUrl), baseUrl, models })));
  }
  return result;
}

export function serializeEndpoints(endpoints: Endpoint[]): string {
  return JSON.stringify(endpoints.map(endpoint => ({ name: endpoint.name, vendor: 'customendpoint', apiType: 'chat-completions', url: endpoint.baseUrl, models: endpoint.models })));
}

export function loadEndpoints(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Endpoint[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    return raw ? parseEndpoints(raw) : [];
  } catch { return []; }
}

export function saveEndpoints(endpoints: Endpoint[], storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = globalThis.localStorage) {
  try {
    if (endpoints.length) storage?.setItem(STORAGE_KEY, serializeEndpoints(endpoints)); else storage?.removeItem(STORAGE_KEY);
  } catch { /* Storage may be disabled; endpoints then last for this tab only. */ }
}
