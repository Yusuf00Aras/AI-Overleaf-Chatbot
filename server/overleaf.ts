import { createHash } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { SerialQueue, UserError, scopeSchema, workspaceScopeSchema, instanceUrl, projectNameSchema, pathSchema, type Scope, type WorkspaceScope } from './policy.js';
import { FullOverleafApi } from './full-api.js';
import { playwrightProxy } from './proxy.js';

export interface DocumentRead { filePath: string; content: string; revision: string }
export interface ProjectInfo { projectId: string; name: string; url: string }
export interface OverleafAdapter {
  execute?(baseUrl: string, name: string, args: Record<string, unknown>): Promise<unknown>;
  connect(scope: WorkspaceScope): Promise<{ message: string }>;
  status(scope: WorkspaceScope): Promise<{ ready: boolean; message: string }>;
  listProjects(baseUrl: string): Promise<{ projects: ProjectInfo[] }>;
  createProject(baseUrl: string, name: string): Promise<ProjectInfo & { message: string }>;
  read(scope: Scope, filePath: string): Promise<DocumentRead>;
  write(scope: Scope, filePath: string, content: string, revision: string): Promise<DocumentRead>;
  compile(scope: Scope): Promise<{ message: string }>;
}
export const revisionOf = (text: string) => createHash('sha256').update(text).digest('hex');

/** Smallest single replacement turning `before` into `after`, never splitting UTF-16 surrogate pairs. */
export function minimalChange(before: string, after: string): { from: number; to: number; insert: string } {
  const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
  const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  if (start > 0 && isHigh(before.charCodeAt(start - 1))) start--;
  let end = 0;
  while (end < max - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
  if (end > 0 && isLow(before.charCodeAt(before.length - end))) end--;
  return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) };
}

const EDITOR = '.cm-content, .CodeMirror';
const PROJECT_TABLE = /^(Projects list|Projektliste|Liste der Projekte)$/i;
const ALL_PROJECTS = /^(All projects|Alle Projekte)$/i;
const PROJECT_COUNT = /^(?:Showing|Zeige|Es werden|Angezeigt|\d).*?(?:out of|of|von)\s+[\d.,\s]+\s+(?:projects?|Projekte(?:n)?)[.!\s]*$/i;

/** Fail closed when the visible catalog cannot prove completeness; no private API fallback. */
export function catalogProjects(baseUrl: string, links: { href: string; name: string }[], footer: string, hasNext = false): ProjectInfo[] {
  const origin = instanceUrl(baseUrl);
  const projects = new Map<string, ProjectInfo>();
  for (const link of links) {
    let url: URL;
    try { url = new URL(link.href, origin); } catch { throw new UserError('Invalid project link in the dashboard.'); }
    const match = /^\/project\/([a-f0-9]{24})\/?$/i.exec(url.pathname);
    if (!match) continue;
    if (url.origin !== origin || url.username || url.password || url.search || url.hash) throw new UserError('Project link does not unambiguously point to the connected instance.');
    const projectId = match[1]!.toLowerCase();
    const name = link.name.trim();
    if (!name) throw new UserError('Project name not recognizable in the dashboard.');
    projects.set(projectId, { projectId, name, url: `${origin}/project/${projectId}` });
  }
  const count = /(?:out of|of|von)\s+([\d.,\s]+)\s+(?:projects?|Projekte(?:n)?)/i.exec(footer);
  const total = count ? Number(count[1]!.replace(/[.,\s]/g, '')) : NaN;
  if (!Number.isSafeInteger(total) || total !== projects.size || hasNext) {
    throw new UserError('Project list incomplete or page count not recognizable (pagination/filter). Could not determine all accessible active projects.');
  }
  return [...projects.values()];
}

async function expectState(locator: Locator, message: string): Promise<void> {
  try { await locator.waitFor({ state: 'attached', timeout: 10_000 }); } catch { throw new UserError(message); }
}

/** Marks the uniquely resolved tree entry so later in-page checks can verify it is still the selected file. */
async function markTarget(entry: Locator): Promise<void> {
  await entry.evaluate(element => {
    for (const old of document.querySelectorAll('[data-olcs-target]')) old.removeAttribute('data-olcs-target');
    element.setAttribute('data-olcs-target', '1');
  });
}

/** Independent browser adapter and private web/socket connector; RAM-only auth, no external MCP server. */
export class BrowserOverleaf implements OverleafAdapter {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private dashboard?: Page;
  private scope?: WorkspaceScope;
  private queue = new SerialQueue();

  execute(input: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const baseUrl = instanceUrl(input);
    return this.queue.run(async () => {
      this.assertInstance(baseUrl);
      return new FullOverleafApi(this.context!, baseUrl).execute(name, args);
    });
  }

  connect(input: WorkspaceScope): Promise<{ message: string }> {
    const scope = workspaceScopeSchema.strict().parse(input);
    return this.queue.run(async () => {
      if (this.scope?.baseUrl !== scope.baseUrl) {
        // Explicit instance changes allocate new pages, but retain the in-memory authenticated context.
        this.page = undefined;
        this.dashboard = undefined;
      }
      this.scope = undefined;
      if (!this.browser?.isConnected()) {
        const proxy = playwrightProxy();
        try { this.browser = await chromium.launch({ headless: false, ...(proxy ? { proxy } : {}) }); }
        catch { throw new UserError('Chromium could not be started. Run "npm run browser:install" once.'); }
        // Fresh, in-memory context: cookies are lost when the browser closes.
        this.context = await this.browser.newContext(proxy ? { proxy } : {});
        this.page = undefined;
        this.dashboard = undefined;
      }
      const page = scope.projectId ? await this.editorPage() : await this.dashboardPage();
      try { await page.goto(`${scope.baseUrl}/project${scope.projectId ? `/${scope.projectId}` : ''}`, { waitUntil: 'domcontentloaded' }); }
      catch { throw new UserError('Overleaf instance not reachable. Check the base URL, network and certificate.'); }
      await page.bringToFront().catch(() => undefined);
      this.scope = scope;
      return { message: scope.projectId ? 'Browser opened. Sign in there, open the project and enable the source editor. Then check the connection.' : 'Project dashboard opened. Sign in there, then check the connection.' };
    });
  }

  status(input: WorkspaceScope): Promise<{ ready: boolean; message: string }> {
    const scope = workspaceScopeSchema.strict().parse(input);
    return this.queue.run(async () => {
      try {
        this.assertInstance(scope.baseUrl);
        if (scope.projectId) {
          const page = this.assertScope(scopeSchema.parse(scope));
          if (!await this.editorVisible(page)) throw new UserError('File tree or editor not visible. Sign in in the browser and open a text file.');
          return { ready: true, message: 'Project opened, file tree and editor visible.' };
        }
        await this.assertAuthenticated(scope.baseUrl);
        return { ready: true, message: 'Signed-in Overleaf instance ready.' };
      } catch (error) {
        return { ready: false, message: error instanceof UserError ? error.message : 'Not connected.' };
      }
    });
  }

  private async editorPage(): Promise<Page> {
    if (!this.page || this.page.isClosed()) {
      this.page = await this.context!.newPage();
      this.page.setDefaultTimeout(15_000);
    }
    return this.page;
  }

  private async dashboardPage(): Promise<Page> {
    if (!this.dashboard || this.dashboard.isClosed()) {
      this.dashboard = await this.context!.newPage();
      this.dashboard.setDefaultTimeout(15_000);
    }
    return this.dashboard;
  }

  private assertInstance(baseUrl: string): void {
    if (!this.browser?.isConnected() || !this.context || !this.scope || this.scope.baseUrl !== baseUrl) {
      throw new UserError('Instance not connected. Please connect again.');
    }
  }

  private assertOrigin(page: Page, baseUrl: string): URL {
    const url = new URL(page.url());
    if (url.origin !== baseUrl || url.username || url.password) throw new UserError('Browser is not on the connected instance.');
    return url;
  }

  private async editorVisible(page: Page): Promise<boolean> {
    return await page.locator('[role="tree"]').first().isVisible() && await page.locator(EDITOR).first().isVisible();
  }

  private async assertAuthenticated(baseUrl: string): Promise<void> {
    this.assertInstance(baseUrl);
    for (const page of [this.dashboard, this.page]) {
      if (!page || page.isClosed()) continue;
      const url = new URL(page.url());
      if (url.origin !== baseUrl) continue;
      if ((/^\/project\/?$/.test(url.pathname) && await page.getByRole('main', { name: ALL_PROJECTS }).isVisible() && await page.getByRole('table', { name: PROJECT_TABLE }).isVisible()) ||
          (/^\/project\/[a-f0-9]{24}\/?$/i.test(url.pathname) && await this.editorVisible(page))) return;
    }
    throw new UserError('Not signed in. Sign in in the browser and open the project dashboard or the editor.');
  }

  private async activeDashboard(baseUrl: string): Promise<Page> {
    await this.assertAuthenticated(baseUrl);
    const page = await this.dashboardPage();
    // Never silently recover an unexpected redirect or foreign origin by navigating it away.
    if (page.url() === 'about:blank') {
      await page.goto(`${baseUrl}/project`, { waitUntil: 'domcontentloaded' });
    }
    const url = this.assertOrigin(page, baseUrl);
    if (/^\/project\/[a-f0-9]{24}\/?$/i.test(url.pathname)) {
      await page.goto(`${baseUrl}/project`, { waitUntil: 'domcontentloaded' });
      this.assertOrigin(page, baseUrl);
    } else if (!/^\/project\/?$/.test(url.pathname)) throw new UserError('Project dashboard not open. Please reconnect at instance level.');
    const table = page.getByRole('table', { name: PROJECT_TABLE });
    await table.waitFor({ state: 'visible' });
    await page.getByRole('button', { name: ALL_PROJECTS, exact: true }).click();
    await page.getByRole('textbox', { name: /^(Search in all projects[….]*|Suche in allen Projekten[….]*|In allen Projekten suchen[….]*)$/i }).fill('');
    this.assertOrigin(page, baseUrl);
    return page;
  }

  listProjects(input: string): Promise<{ projects: ProjectInfo[] }> {
    const baseUrl = instanceUrl(input);
    return this.queue.run(async () => {
      const page = await this.activeDashboard(baseUrl);
      const links = await page.getByRole('table', { name: PROJECT_TABLE }).locator('a[href]').evaluateAll(anchors => anchors.map(anchor => ({
        href: anchor.getAttribute('href') ?? '', name: (anchor as HTMLElement).innerText,
      })));
      const footers = await page.getByText(PROJECT_COUNT).allTextContents();
      if (footers.length !== 1) throw new UserError('Project list incomplete: page count not unambiguously recognizable.');
      const next = page.getByRole('button', { name: /^(Next(?: page)?|Nächste(?: Seite)?|Weiter)$/i });
      let hasNext = false;
      for (const button of await next.all()) if (await button.isVisible() && await button.isEnabled()) hasNext = true;
      this.assertOrigin(page, baseUrl);
      return { projects: catalogProjects(baseUrl, links, footers[0]!, hasNext) };
    });
  }

  createProject(input: string, inputName: string): Promise<ProjectInfo & { message: string }> {
    const baseUrl = instanceUrl(input);
    const name = projectNameSchema.parse(inputName);
    return this.queue.run(async () => {
      const page = await this.activeDashboard(baseUrl);
      await page.getByRole('button', { name: /^(New project|Neues Projekt)$/i }).click();
      await page.getByRole('menuitem', { name: /^(Blank project|Leeres Projekt)$/i }).click();
      const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /^(New project|Neues Projekt)$/i }) });
      await dialog.getByRole('textbox', { name: /^(Project name|Projektname)$/i }).fill(name);
      const submit = dialog.getByRole('button', { name: /^(Create|Erstellen)$/i });
      await submit.waitFor({ state: 'visible' });
      if (!await submit.isEnabled()) throw new UserError('Project creation not available.');
      const pages = new Set(this.context!.pages());
      await this.assertAuthenticated(baseUrl);
      this.assertOrigin(page, baseUrl); // Immediately before the one and only submission.
      try {
        await submit.click(); // No retries: even a click timeout may have submitted.
        await page.waitForURL(url => url.origin === baseUrl && /^\/project\/[a-f0-9]{24}\/?$/i.test(url.pathname), { timeout: 15_000, waitUntil: 'domcontentloaded' });
        if (this.context!.pages().some(candidate => !pages.has(candidate))) throw new Error('Ambiguous popup');
        const url = this.assertOrigin(page, baseUrl);
        const projectId = scopeSchema.parse({ baseUrl, projectId: url.pathname.split('/')[2] }).projectId;
        // Only the catalog page navigated. Keep both the selected scope and editor untouched.
        await page.goto(`${baseUrl}/project`, { waitUntil: 'domcontentloaded' });
        this.assertOrigin(page, baseUrl);
        await page.getByRole('table', { name: PROJECT_TABLE }).waitFor({ state: 'visible' });
        return { projectId, name, url: `${baseUrl}/project/${projectId}`, message: 'Project created. Select it explicitly to edit.' };
      } catch {
        throw new UserError('Project creation not confirmed after submission (navigation/popup). Check the project list; do not retry.');
      }
    });
  }

  private assertScope(scope: Scope): Page {
    if (!this.browser?.isConnected() || !this.page || this.page.isClosed()) {
      throw new UserError('Browser window closed. Please reconnect.');
    }
    this.assertInstance(scope.baseUrl);
    const url = this.assertOrigin(this.page, scope.baseUrl);
    if (url.origin !== scope.baseUrl || url.pathname !== `/project/${scope.projectId}`) {
      throw new UserError('Please sign in in the opened browser and switch to the selected project.');
    }
    return this.page;
  }

  private async openFile(scope: Scope, filePath: string): Promise<Page> {
    scope = scopeSchema.strict().parse(scope);
    pathSchema.parse(filePath);
    await this.switchEditor(scope);
    const page = this.assertScope(scope);
    let container = page.locator('[role="tree"]').first();
    try { await container.waitFor({ state: 'visible' }); }
    catch { throw new UserError('File tree not found. Sign in in the browser and open the project.'); }
    const parts = filePath.split('/');
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index]!;
      // Direct children only (Overleaf wraps items in a plain div), exact accessible name: never pick a same-named entry in another folder.
      const entry = container.locator(':scope > [role="treeitem"], :scope > :not([role]) > [role="treeitem"]').and(page.getByRole('treeitem', { name, exact: true }));
      if (await entry.count() !== 1) {
        throw new UserError(`File or folder not found unambiguously: ${name}. Check the path; this Overleaf version may not be supported by the adapter.`);
      }
      // Single clicks only: a double click starts renaming in Overleaf.
      if (index < parts.length - 1) {
        if (await entry.getAttribute('aria-expanded') !== 'true') {
          await entry.getByText(name, { exact: true }).first().click();
          await expectState(entry.and(page.locator('[aria-expanded="true"]')), `Folder could not be opened: ${name}.`);
        }
        container = entry.locator(':scope > [role="group"], :scope > :not([role]) > [role="group"]');
        continue;
      }
      const editor = page.locator(EDITOR).first();
      if (await entry.getAttribute('aria-selected') === 'true' && await editor.isVisible()) { await markTarget(entry); return page; }
      const hadEditor = await editor.isVisible();
      if (hadEditor) await editor.evaluate(element => {
        const el = element as HTMLElement & { cmView?: { view?: { state: { doc: unknown } } }; CodeMirror?: { getDoc(): unknown } };
        (window as unknown as { __olcsDoc?: unknown }).__olcsDoc = el.CodeMirror?.getDoc() ?? el.cmView?.view?.state.doc;
      });
      await entry.getByText(name, { exact: true }).first().click();
      await expectState(entry.and(page.locator('[aria-selected="true"]')), `File could not be selected: ${name}.`);
      try {
        await editor.waitFor({ state: 'visible' });
        // The selected tree entry alone does not prove the editor has loaded the new document.
        if (hadEditor) await page.waitForFunction(selector => {
          const el = document.querySelector(selector) as (HTMLElement & { cmView?: { view?: { state: { doc: unknown } } }; CodeMirror?: { getDoc(): unknown } }) | null;
          const doc = el?.CodeMirror?.getDoc() ?? el?.cmView?.view?.state.doc;
          return doc !== undefined && doc !== (window as unknown as { __olcsDoc?: unknown }).__olcsDoc;
        }, EDITOR, { timeout: 10_000 });
      } catch { throw new UserError(`Editor did not load ${name}. Not a text file, or Overleaf version not supported.`); }
      await markTarget(entry);
    }
    return page;
  }

  private async switchEditor(scope: Scope): Promise<void> {
    await this.assertAuthenticated(scope.baseUrl);
    const page = await this.editorPage();
    if (page.url() !== 'about:blank') this.assertOrigin(page, scope.baseUrl);
    if (page.url() !== `${scope.baseUrl}/project/${scope.projectId}`) {
      await page.goto(`${scope.baseUrl}/project/${scope.projectId}`, { waitUntil: 'domcontentloaded' });
    }
    this.assertScope(scope);
  }

  private assertSelected(scope: Scope): void {
    this.assertInstance(scope.baseUrl);
    if (!this.scope?.projectId || this.scope.projectId !== scope.projectId) throw new UserError('Writing and compiling require the explicitly selected project.');
  }

  private async text(page: Page, scope: Scope): Promise<string> {
    // Reading the editor model avoids truncation by CodeMirror's virtual viewport.
    // cmView is an internal CM6 hook: deliberately fail closed when unavailable.
    const result = await page.locator(EDITOR).first().evaluate((element, identity) => {
      // Project URL and selected file are re-checked in the same synchronous step as the read.
      const target = document.querySelector('[data-olcs-target]');
      if (location.pathname.replace(/\/$/, '') !== identity.path || target?.getAttribute('aria-selected') !== 'true') return { identity: false as const };
      const editor = element as HTMLElement & {
        cmView?: { view?: { state?: { doc?: { toString(): string } } } };
        CodeMirror?: { getValue(): string };
      };
      if (editor.CodeMirror) return { text: editor.CodeMirror.getValue() };
      const doc = editor.cmView?.view?.state?.doc;
      return { text: doc ? doc.toString() : null };
    }, { path: `/project/${scope.projectId}` });
    if (result.text === undefined) throw new UserError('Project or selected file changed in the browser. Read again; no change made.');
    if (result.text === null) throw new UserError('Full editor model not accessible. Enable source mode; adjust the adapter if necessary.');
    if (result.text.length > 500_000 || Buffer.byteLength(result.text) > 512 * 1024) throw new UserError('LIMIT_EXCEEDED: Document larger than 512 KiB.');
    return result.text;
  }

  read(scope: Scope, filePath: string): Promise<DocumentRead> {
    return this.queue.run(async () => {
      const page = await this.openFile(scope, filePath);
      const content = await this.text(page, scope);
      return { filePath, content, revision: revisionOf(content) };
    });
  }

  write(scope: Scope, filePath: string, content: string, revision: string): Promise<DocumentRead> {
    return this.queue.run(async () => {
      this.assertSelected(scope);
      const page = await this.openFile(scope, filePath);
      const before = await this.text(page, scope);
      if (revisionOf(before) !== revision) throw new UserError('REVISION_CONFLICT: Document was changed. Read again and reconcile changes.');
      const change = minimalChange(before, content);
      // Check and dispatch synchronously in the browser. No await gap between identity/revision check and edit.
      // Only the changed range is replaced, so concurrent collaborator edits elsewhere are not overwritten.
      const outcome = await page.locator(EDITOR).first().evaluate((element, edit) => {
        const target = document.querySelector('[data-olcs-target]');
        if (location.pathname.replace(/\/$/, '') !== edit.path || target?.getAttribute('aria-selected') !== 'true') return 'identity';
        const editor = element as HTMLElement & {
          cmView?: { view?: { state: { doc: { toString(): string } }; dispatch(value: unknown): void } };
          CodeMirror?: { getValue(): string; replaceRange(text: string, from: unknown, to: unknown): void; posFromIndex(index: number): unknown };
        };
        const view = editor.cmView?.view;
        const cm = editor.CodeMirror;
        const current = cm ? cm.getValue() : view?.state.doc.toString();
        if (current === undefined) return 'unsupported';
        if (current !== edit.before) return 'conflict';
        if (edit.change.from === edit.change.to && !edit.change.insert) return 'ok';
        if (cm) cm.replaceRange(edit.change.insert, cm.posFromIndex(edit.change.from), cm.posFromIndex(edit.change.to));
        else view!.dispatch({ changes: edit.change });
        return 'ok';
      }, { before, change, path: `/project/${scope.projectId}` });
      if (outcome === 'identity') throw new UserError('Project or selected file changed in the browser. No change made; read again.');
      if (outcome === 'conflict') throw new UserError('REVISION_CONFLICT: Document was changed. Read again and reconcile changes.');
      if (outcome === 'unsupported') throw new UserError('Editor version not supported. No change made.');
      const observed = await this.text(page, scope);
      if (observed !== content) throw new UserError('Change not confirmed. Do not retry automatically; check the document in the browser.');
      return { filePath, content: observed, revision: revisionOf(observed) };
    });
  }

  compile(scope: Scope): Promise<{ message: string }> {
    return this.queue.run(async () => {
      this.assertSelected(scope);
      await this.switchEditor(scope);
      const page = this.assertScope(scope);
      try { await page.getByRole('button', { name: /^(Recompile|Compile|Neu kompilieren|Kompilieren)$/i }).first().click(); }
      catch { throw new UserError('Compile button not found. Compile manually in the browser.'); }
      return { message: 'Compilation requested in the Overleaf browser. Check the result and errors there.' };
    });
  }

  async close(): Promise<void> {
    await this.queue.run(async () => {
      this.scope = undefined;
      await this.browser?.close().catch(() => undefined);
    });
  }
}