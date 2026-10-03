import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';

/** Proxy from HTTPS_PROXY/HTTP_PROXY unless NO_PROXY or loopback excludes the target host. */
export function proxyFor(target: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const url = new URL(target);
  const secure = ['https:', 'wss:'].includes(url.protocol);
  const proxy = secure ? env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy : env.HTTP_PROXY ?? env.http_proxy;
  if (!proxy) return undefined;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (['localhost', '127.0.0.1', '::1'].includes(host)) return undefined;
  const bypass = (env.NO_PROXY ?? env.no_proxy ?? '').split(',').map(entry => entry.trim().toLowerCase().replace(/^\*?\./, '')).filter(Boolean);
  return bypass.some(entry => entry === '*' || host === entry || host.endsWith(`.${entry}`)) ? undefined : proxy;
}

/** Playwright proxy option for the browser and its request context; credentials never logged. */
export function playwrightProxy(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  if (!raw) return undefined;
  const url = new URL(raw);
  const bypass = ['localhost', '127.0.0.1', '::1', ...(env.NO_PROXY ?? env.no_proxy ?? '').split(',').map(entry => entry.trim()).filter(Boolean)].join(',');
  return { server: `${url.protocol}//${url.host}`, bypass,
    ...(url.username ? { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) } : {}) };
}

/** `createConnection` for ws: HTTP CONNECT tunnel through the proxy, then TLS to the target. */
export function proxyTunnel(proxy: string) {
  const url = new URL(proxy);
  return (options: Record<string, any>, callback: (error: Error | null, socket?: Duplex) => void): undefined => {
    const target = `${options.host}:${options.port}`;
    const auth = url.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}` } : {};
    const request = (url.protocol === 'https:' ? https : http).request({ host: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT', path: target, headers: { host: target, ...auth }, agent: false });
    request.once('connect', (response, socket) => {
      if (response.statusCode !== 200) { socket.destroy(); callback(new Error('Proxy-Tunnel abgelehnt.')); return; }
      callback(null, tls.connect({ ...options, path: undefined, socket, servername: options.servername ?? (isIP(options.host) ? undefined : options.host) }));
    });
    request.once('error', () => callback(new Error('Proxy nicht erreichbar.')));
    request.end();
    return undefined;
  };
}
