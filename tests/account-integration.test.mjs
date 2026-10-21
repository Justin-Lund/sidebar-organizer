import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise real Organizer methods with DOM/network dependencies replaced at
// import boundaries. The constructor requires a running HA custom-element tree.
function organizerHarness(overrides = {}) {
  const filename = new URL('../src/sidebar-organizer.ts', import.meta.url);
  const parsed = ts.createSourceFile('organizer.ts', readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  const printer = ts.createPrinter();
  const withoutImports = parsed.statements.filter((node) => !ts.isImportDeclaration(node))
    .map((node) => printer.printNode(ts.EmitHint.Unspecified, node, parsed)).join('\n');
  const js = ts.transpileModule(withoutImports, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const writes = [];
  let legacyReads = 0;
  const context = {
    exports: {}, window: { SidebarOrganizer: {} }, structuredClone, console,
    STORAGE: { UI_CONFIG: 'config', COLLAPSE: 'collapse' },
    localStorage: { getItem: () => '{"legacy":true}' },
    sidebarUseConfigFile: () => false,
    fetchConfig: async () => { legacyReads++; return { header_title: 'Legacy' }; },
    setStorage: (...args) => writes.push(args),
    HA_STATE: { RUNNING: 'RUNNING' }, atLeastVersion: () => true,
    compareHacsTagDiff: () => {},
    loadAccountConfig: async () => ({ status: 'absent' }),
    fetchFrontendUserData: async () => ({}),
    ...overrides,
  };
  vm.runInNewContext(js, context);
  const instance = Object.create(context.exports.SidebarOrganizer.prototype);
  instance._accountConfig = { status: 'absent' };
  instance._ha = { hass: {} };
  instance._startupGeneration = 0;
  instance._accountListeners = new Set();
  return { instance, writes, legacyReads: () => legacyReads };
}

test('absent account retains the legacy loader and configuration detection', async () => {
  const { instance, legacyReads } = organizerHarness();
  assert.equal(instance._hasSidebarConfig, true);
  await instance._getConfig();
  assert.equal(legacyReads(), 1);
  assert.equal(instance._config.header_title, 'Legacy');
});

function startupHarness(overrides = {}) {
  let reloads = 0;
  const fixture = organizerHarness({ window: { SidebarOrganizer: {}, location: { reload: () => reloads++ } }, ...overrides });
  const { instance } = fixture;
  instance._ha.hass = { connection: {}, user: { id: 'a' }, config: { state: 'RUNNING', version: '2026.10.1' } };
  const notices = [];
  instance._store = { _showToast: (message) => notices.push(message) };
  instance._dialogManager = {};
  instance._watchEditLegacySidebar = async () => {};
  instance._setupConfigBtn = () => {};
  instance._checkProfileSection = async () => {};
  instance._watchScrollHideHeader = () => {};
  let applied = 0;
  instance._setupInitialConfig = () => applied++;
  instance._processSections = () => {};
  return { ...fixture, notices, applied: () => applied, reloads: () => reloads };
}

test('startup waits for panel construction and section completion before announcing readiness', async () => {
  const f = startupHarness({ loadAccountConfig: async () => ({ status: 'ready', config: {} }) });
  let finishPanels, finishSections;
  f.instance._setupInitialConfig = () => new Promise(resolve => { finishPanels = resolve; });
  f.instance._processSections = () => new Promise(resolve => { finishSections = resolve; });
  const running = f.instance.run();
  while (!finishPanels) await new Promise(resolve => setImmediate(resolve));
  assert.equal(finishSections, undefined);
  assert.notEqual(f.instance._accountLoaded, true);
  finishPanels();
  while (!finishSections) await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(f.instance._accountLoaded, true);
  finishSections();
  await running;
  assert.equal(f.instance._accountLoaded, true);
});

test('a changed identity after panel construction cannot enter section processing', async () => {
  const f = startupHarness({ loadAccountConfig: async () => ({ status: 'ready', config: {} }) });
  let finishPanels, sections = 0;
  f.instance._setupInitialConfig = () => new Promise(resolve => { finishPanels = resolve; });
  f.instance._processSections = () => { sections++; };
  const running = f.instance.run();
  while (!finishPanels) await new Promise(resolve => setImmediate(resolve));
  f.instance._ha.hass = { ...f.instance.hass, user: { id: 'another-account' } };
  finishPanels();
  await running;
  assert.equal(sections, 0);
  assert.notEqual(f.instance._accountLoaded, true);
});

// Small DOM fixture exercises the real construction/lookup methods. It rejects
// an async optional-container query instead of silently simulating its timeout.
class SidebarNode {
  constructor(tag = 'div', panel) {
    this.tag = tag; this.children = []; this.attrs = new Map(); this.style = {};
    this.classList = { values: new Set(), add: (...names) => names.forEach(n => this.classList.values.add(n)) };
    if (panel) this.href = '/' + panel;
  }
  appendChild(node) {
    if (node.tag === '#fragment') { [...node.children].forEach(child => this.appendChild(child)); return node; }
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = this; this.children.push(node); return node;
  }
  prepend(node) { this.appendChild(node); this.children.unshift(this.children.pop()); }
  insertBefore(node, next) {
    this.appendChild(node);
    if (next) { this.children.pop(); this.children.splice(this.children.indexOf(next), 0, node); }
  }
  get nextElementSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1] || null; }
  setAttribute(name, value) { this.attrs.set(name, value); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  hasAttribute(name) { return this.attrs.has(name); }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) {
    const nodes = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
    if (selector === '*') return nodes;
    if (selector === 'item') return nodes.filter(node => node.href);
    if (selector === 'bottom') return nodes.filter(node => node.classList.values.has('bottom-list'));
    if (selector === 'spacer') return nodes.filter(node => node.tag === 'spacer');
    return [];
  }
}

function panelFixture(withBottom) {
  const root = new SidebarNode('root');
  const top = root.appendChild(new SidebarNode('top'));
  root.appendChild(new SidebarNode('spacer'));
  top.appendChild(new SidebarNode('item', 'home'));
  top.appendChild(new SidebarNode('item', 'music'));
  const selectors = { SIDEBAR_BEFORE_SPACER_CONTAINER: 'top', SIDEBAR_BOTTOM_LIST_CONTAINER: 'bottom', SIDEBAR_LOADER: 'loader', SPACER: 'spacer' };
  const attributes = { DATA_PANEL: 'data-panel', NEW_ITEM: 'new', GROUP: 'group', BOTTOM: 'bottom', DEFAULT_PANEL: 'default' };
  const types = { BOTTOM_ITEMS: 'bottom_items', BOTTOM_GRID_ITEMS: 'bottom_grid_items', UNCATEGORIZED_ITEMS: 'uncategorized_items' };
  const f = organizerHarness({
    HTMLElement: SidebarNode,
    document: { createDocumentFragment: () => new SidebarNode('#fragment'), createElement: tag => new SidebarNode(tag) },
    SELECTOR: selectors, ATTRIBUTE: attributes, ELEMENT: { HA_LIST_NAV: 'nav', ITEM: 'item' }, PANEL_TYPE: types,
    CLASS: { BOTTOM_CONTAINER: 'bottom-container', BOTTOM_GRID_CONTAINER: 'grid', BOTTOM_LIST: 'bottom-list' },
    getDefaultPanelUrlPath: () => 'home', parseItemValues: item => ({ panelId: item.getAttribute('data-panel') }),
    getPromisableResult: async (read, accept) => { const result = read(); assert.ok(accept(result), 'required DOM must be ready'); return result; },
  });
  const instance = f.instance;
  instance.sideBarRoot = { querySelector: selector => selector === undefined ? root : root.querySelector(selector) };
  // _panelsList getter needs the root, while _getElements uses the raw root below.
  selectors.PANELS_LIST = 'panels';
  instance.sideBarRoot.querySelector = selector => selector === 'panels' ? root : root.querySelector(selector);
  instance._config = withBottom ? { custom_groups: {}, bottom_groups: { Footer: ['music'] } } : { custom_groups: { Main: ['music'] } };
  instance._configPanelMap = new Map(Object.entries(withBottom ? instance._config.bottom_groups : instance._config.custom_groups));
  instance._getGroupOfPanel = panel => [...instance._configPanelMap].find(([,items]) => items.includes(panel))?.[0] || null;
  let release;
  instance._getContainerItems = container => container === top && !release
    ? new Promise(resolve => { release = () => resolve(container.querySelectorAll('item')); })
    : Promise.resolve(container.querySelectorAll('item'));
  const selector = { element: Promise.resolve(root), query: name => {
    assert.equal(name, 'top', 'optional bottom must never use async polling');
    return { element: Promise.resolve(top) };
  } };
  instance._sidebar = { selector: { $: selector } };
  return { ...f, root, top, release: () => release() };
}

for (const withBottom of [false, true]) {
  test(`actual panel construction completes before lookup; bottom ${withBottom ? 'present' : 'absent'}`, async () => {
    const f = panelFixture(withBottom);
    let complete = false;
    const running = f.instance._setupPanelOrder().then(() => { complete = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(complete, false, 'outer promise must include the deferred item read');
    assert.equal(f.root.querySelector('bottom'), null);
    f.release();
    await running;
    const result = await f.instance._getElements();
    assert.equal(Boolean(result.bottomItemsContainer), withBottom);
    assert.deepEqual(Array.from(result.topItems, item => item.href), withBottom ? ['/home'] : ['/home', '/music']);
    assert.deepEqual(result.bottomItems ? Array.from(result.bottomItems, item => item.href) : null, withBottom ? ['/music'] : null);
    if (withBottom) assert.equal(result.bottomItems[0].getAttribute('group'), 'Footer');
  });
}

test('initial configuration propagates construction completion', async () => {
  const f = organizerHarness({ normalizePinnedGroups: value => value });
  f.instance._config = { custom_groups: { Life: ['bjj'] }, default_collapsed: ['Life'] };
  f.instance._accountConfig = { status: 'ready', config: f.instance._config };
  f.instance._addCustomWidthStyle = () => {};
  f.instance._addAdditionalStyles = () => {};
  let finish, complete = false;
  f.instance._setupPanelOrder = () => new Promise(resolve => { finish = resolve; });
  const pending = f.instance._setupInitialConfig().then(() => { complete = true; });
  assert.equal(complete, false);
  assert.deepEqual([...f.instance.collapsedItems], ['Life']);
  finish(); await pending;
  assert.equal(complete, true);
});

test('diagnostic script-tag lookup never blocks module evaluation and still compares when resolved', async () => {
  const source = readFileSync(new URL('../src/utilities/compare-urls.ts', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('compare.ts', source, ts.ScriptTarget.Latest, true);
  const printer = ts.createPrinter();
  const stripped = parsed.statements.filter(node => !ts.isImportDeclaration(node))
    .map(node => printer.printNode(ts.EmitHint.Unspecified, node, parsed)).join('\n');
  const js = ts.transpileModule(stripped, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  let resolve, comparisons = 0;
  const context = { exports: {}, document: { scripts: [] }, console,
    getPromisableResult: () => new Promise(done => { resolve = done; }),
    getConfigUrl: () => { comparisons++; return null; } };
  vm.runInNewContext(js, context);
  assert.equal(typeof context.exports.compareHacsTagDiff, 'function');
  assert.equal(context.exports.compareHacsTagDiff({}), undefined);
  assert.equal(comparisons, 0);
  resolve('');
  await new Promise(done => setImmediate(done));
  assert.equal(comparisons, 1);
});

test('actual startup waits for account read and ignores an older overlapping response', async () => {
  const pending = [];
  const f = startupHarness({ loadAccountConfig: () => new Promise(resolve => pending.push(resolve)) });
  let updates = 0;
  f.instance._accountListeners.add(() => updates++);
  const first = f.instance.run();
  const second = f.instance.run();
  assert.equal(f.applied(), 0);
  pending[1]({ status: 'ready', config: { header_title: 'New' } });
  await second;
  pending[0]({ status: 'ready', config: { header_title: 'Stale' } });
  await first;
  assert.equal(f.instance._config.header_title, 'New');
  assert.equal(f.applied(), 1);
  assert.equal(updates, 1);
  assert.equal(f.legacyReads(), 0);
});

test('identity switch reloads pristine DOM and rejects outstanding old-user response', async () => {
  let resolve;
  const f = startupHarness({ loadAccountConfig: () => new Promise(done => { resolve = done; }) });
  const pending = f.instance.run();
  f.instance._ha.hass = { ...f.instance.hass, connection: {}, user: { id: 'b' } };
  await f.instance.run();
  resolve({ status: 'ready', config: { header_title: 'Account A' } });
  await pending;
  assert.equal(f.reloads(), 1);
  assert.equal(f.applied(), 0);
  assert.notEqual(f.instance._accountConfig.status, 'ready');
});

test('native-read failure shows safe fallback; native conflicts are explicitly surfaced', async () => {
  const failed = startupHarness({ fetchFrontendUserData: async () => { throw Error('offline'); } });
  await failed.instance.run();
  assert.equal(failed.instance._accountConfig.status, 'unavailable');
  assert.equal(failed.applied(), 0);
  assert.equal(failed.notices.length, 1);
  const conflict = startupHarness({ loadAccountConfig: async () => ({ status: 'ready', config: {} }), fetchFrontendUserData: async () => ({ hiddenPanels: ['map'] }) });
  conflict.instance._watchEditLegacySidebar = async () => { throw Error('must preserve native editor'); };
  await conflict.instance.run();
  assert.equal(conflict.applied(), 0);
  assert.match(conflict.notices[0], /native sidebar preferences/);
});

test('migration readiness waits for a slow legacy configuration load', async () => {
  let resolve;
  const f = startupHarness({ fetchConfig: () => new Promise(done => { resolve = done; }) });
  const pending = f.instance.run();
  while (!resolve) await new Promise(done => setImmediate(done));
  assert.notEqual(f.instance._accountLoaded, true);
  resolve({ header_title: 'Migrated layout' });
  await pending;
  assert.equal(f.instance._accountLoaded, true);
  assert.equal(f.instance._config.header_title, 'Migrated layout');
});

test('cold startup waits for each authentication and HA readiness field before binding identity', async () => {
  for (const missing of ['hass', 'connection', 'user', 'state', 'version']) {
    let wait;
    let reads = 0;
    const f = startupHarness({
      getPromisableResult: predicate => new Promise(resolve => { wait = { predicate, resolve }; }),
      loadAccountConfig: async () => { reads++; return { status: 'ready', config: {} }; },
    });
    const ready = f.instance.hass;
    f.instance._ha.hass = {
      ...ready, config: { ...ready.config },
    };
    if (missing === 'hass') f.instance._ha.hass = undefined;
    if (missing === 'connection') delete f.instance.hass.connection;
    if (missing === 'user') delete f.instance.hass.user;
    if (missing === 'state') f.instance.hass.config.state = 'STARTING';
    if (missing === 'version') delete f.instance.hass.config.version;
    const pending = f.instance.run();
    assert.ok(wait, missing);
    assert.equal(Boolean(wait.predicate()), false, missing);
    assert.equal(reads, 0, missing);
    assert.equal(f.instance._startupConnection, undefined, missing);
    f.instance._ha.hass = ready;
    assert.equal(Boolean(wait.predicate()), true, missing);
    wait.resolve(true);
    await pending;
    assert.equal(reads, 1, missing);
    assert.equal(f.applied(), 1, missing);
    assert.equal(f.reloads(), 0, missing);
    assert.equal(f.instance._store.hass, ready, missing);
    assert.equal(f.instance._dialogManager.hass, ready, missing);
  }
});

test('a superseded readiness waiter cannot apply or bind an old startup', async () => {
  const waits = [];
  const f = startupHarness({
    getPromisableResult: predicate => new Promise(resolve => waits.push({ predicate, resolve })),
  });
  const ready = f.instance.hass;
  f.instance._ha.hass = undefined;
  const first = f.instance.run();
  const second = f.instance.run();
  assert.equal(waits.length, 2);
  assert.equal(Boolean(waits[0].predicate()), true, 'superseded waiter should finish');
  waits[0].resolve(true);
  await first;
  assert.equal(f.instance._startupConnection, undefined);
  assert.equal(f.applied(), 0);
  f.instance._ha.hass = ready;
  waits[1].resolve(true);
  await second;
  assert.equal(f.applied(), 1);
  assert.equal(f.reloads(), 0);
});

test('readiness timeout makes no user-data request or identity binding and offers retry', async () => {
  let reads = 0;
  const f = startupHarness({
    getPromisableResult: async () => false,
    loadAccountConfig: async () => { reads++; return { status: 'absent' }; },
    fetchFrontendUserData: async () => { reads++; return {}; },
  });
  f.instance._ha.hass = undefined;
  await f.instance.run();
  assert.equal(reads, 0);
  assert.equal(f.instance._startupConnection, undefined);
  assert.equal(f.instance._startupUser, undefined);
  assert.equal(f.instance._accountConfig.status, 'unavailable');
  assert.equal(f.applied(), 0);
  assert.match(f.notices[0], /sign-in is not ready.*Reload/i);
});

test('account loader bypasses stale file/cache; editor events and cross-tab collapse cannot overwrite it', async () => {
  const { instance, writes, legacyReads } = organizerHarness();
  const config = { custom_groups: { Group: ['lights'] }, default_collapsed: ['Group'] };
  instance._accountConfig = { status: 'ready', config };
  await instance._getConfig();
  assert.equal(legacyReads(), 0);
  assert.deepEqual(instance._config, config);
  assert.notEqual(instance._config, config);
  instance._handleNewConfig({ header_title: 'stale editor' }, false);
  instance._storageListener({ key: 'collapse', newValue: 'malformed' });
  assert.deepEqual(instance._config, config);
  assert.deepEqual(writes, []);
  instance._userHasSidebarSettings = true;
  assert.equal(instance._pluginConfigured, false, 'native account settings retain priority');
});

test('unavailable account never advertises a stale browser configuration', () => {
  const { instance } = organizerHarness();
  instance._accountConfig = { status: 'unavailable' };
  assert.equal(instance._hasSidebarConfig, false);
  assert.equal(instance._pluginConfigured, false);
});

function loadComponent(file, globals = {}) {
  const source = ts.createSourceFile(file, readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const printer = ts.createPrinter();
  const text = source.statements.filter(node => !ts.isImportDeclaration(node))
    .map(node => printer.printNode(ts.EmitHint.Unspecified, node, source)).join('\n');
  const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText;
  const context = { exports: {}, console, ...globals };
  vm.runInNewContext(js, context);
  return context.exports;
}

test('native editor remains available for conflicts and unavailable account data', async () => {
  const Handler = loadComponent('utilities/model/dialog-handler.ts').default;
  for (const [native, status, removed] of [[true, 'ready', 0], [false, 'unavailable', 0], [false, 'ready', 1]]) {
    let removals = 0;
    let alerts = 0;
    const organizer = { _accountManaged: true, _userHasSidebarSettings: native, _accountConfig: { status } };
    const handler = new Handler({ hass: {} }, organizer);
    handler._waitForSidebarDialog = async () => ({ remove: () => removals++ });
    handler._showConfigDialogEditor = async () => alerts++;
    await handler._handleEditModeAttempt();
    assert.equal(removals, removed);
    assert.equal(alerts, removed);
  }
});

test('profile blocks writes during startup and refreshes when account state resolves', async () => {
  let writes = 0;
  const { SoProfileSection } = loadComponent('components/so-profile-section.ts', {
    LitElement: class { updates = 0; connectedCallback() {} disconnectedCallback() {} requestUpdate() { this.updates++; } },
    property: () => () => {}, customElement: () => (Class) => Class, css: () => '',
    saveAccountConfig: async () => writes++,
  });
  const profile = new SoProfileSection();
  profile.organizer = { _accountLoaded: false, _accountListeners: new Set() };
  profile.connectedCallback();
  await profile._publishAccountConfig({});
  await profile._removeAccountConfig();
  profile._uploadAccountConfig();
  assert.equal(writes, 0);
  profile.organizer._accountListeners.forEach(callback => callback());
  assert.equal(profile.updates, 1);
  profile.disconnectedCallback();
  assert.equal(profile.organizer._accountListeners.size, 0);
});

test('profile injection supports general, dashboard and preferences containers without duplicates', async () => {
  const { ELEMENT, SELECTOR } = loadComponent('constants/dom.ts');
  const Handler = loadComponent('utilities/model/dialog-handler.ts', { ELEMENT, SELECTOR }).default;
  for (const [element, selector] of [
    ['ha-profile-section-general', '.content'],
    ['ha-profile-dashboard', '.container'],
    ['ha-profile-section-preferences', '.container'],
  ]) {
    const children = [];
    const section = { tagName: 'SO-PROFILE-SECTION' };
    const container = {
      querySelector: name => name === 'so-profile-section' ? children[0] : null,
      appendChild: child => children.push(child),
    };
    const resolver = {
      querySelector: name => name === element ? {
        shadowRoot: { querySelector: name => name === selector ? container : null },
      } : null,
    };
    const handler = new Handler({ hass: {} }, {});
    handler._createProfileSectionComponent = async () => section;
    await handler._injectSidebarOrganizerElement(resolver);
    await handler._injectSidebarOrganizerElement(resolver);
    assert.deepEqual(children, [section], element);
  }
  const handler = new Handler({ hass: {} }, {});
  handler._createProfileSectionComponent = async () => { throw Error('unrelated page'); };
  await handler._injectSidebarOrganizerElement({ querySelector: () => null });
});
