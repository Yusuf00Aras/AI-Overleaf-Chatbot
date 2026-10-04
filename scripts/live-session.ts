import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { BrowserOverleaf } from '../server/overleaf.js';
import { instanceUrl } from '../server/policy.js';
import { describe, waitReady } from './live-common.js';

// One long-lived, RAM-only browser session: log in once, then run several checks. Nothing is written to disk.
const baseUrl = instanceUrl(process.argv[2] ?? 'https://www.overleaf.com');
const adapter = new BrowserOverleaf();
const help = 'Commands: read [projectId] | write [Studio-Livetest-projectId] | extra <Studio-Livetest-projectId> | purge | status | quit';
// Check modules are re-imported per command, so edited or new checks run without a new login.
const load = async (file: string) => import(`${pathToFileURL(`${import.meta.dirname}/${file}`).href}?t=${Date.now()}`);

async function ensureLogin() {
  if ((await adapter.status({ baseUrl })).ready) return;
  console.log('>>>   Please log in in the separate Chromium window and leave the project dashboard open (max. 15 minutes).');
  console.log(`OK    login: ${await waitReady(adapter, { baseUrl }, 15 * 60_000)}`);
}

try {
  console.log(`Live session against ${baseUrl}. ${(await adapter.connect({ baseUrl })).message}`);
  await ensureLogin();
  console.log(help);
  const lines = createInterface({ input: process.stdin });
  let busy = Promise.resolve();
  console.log('READY');
  for await (const line of lines) {
    const [command, argument] = line.trim().split(/\s+/);
    if (command === 'quit') break;
    busy = busy.then(async () => {
      try {
        await ensureLogin();
        if (command === 'read') await (await load('live-check.ts')).readCheck(adapter, baseUrl, argument);
        else if (command === 'write') await (await load('live-write-check.ts')).writeCheck(adapter, baseUrl, argument);
        else if (command === 'extra' && argument) await (await load('live-extra-check.ts')).extraCheck(adapter, baseUrl, argument);
        else if (command === 'purge') await (await load('live-purge-check.ts')).purgeCheck(adapter, baseUrl);
        else if (command === 'status') console.log(`Status: ${(await adapter.status({ baseUrl })).message}`);
        else if (command) console.log(help);
      } catch (error) { console.log(`ABORTED: ${describe(error)}`); }
      console.log('READY');
    });
    await busy;
  }
} catch (error) {
  console.log(`ABORTED: ${describe(error)}`);
} finally {
  await adapter.close();
  console.log('Session ended; login discarded.');
}
