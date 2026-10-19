import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/utilities/account-config.ts', import.meta.url), 'utf8');
const { loadAccountConfig, saveAccountConfig, validateAccountConfig, ACCOUNT_CONFIG_KEY } = await import(
  `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64')}`
);
const config = { custom_groups: { Example: ['lights', 'weather'] }, default_collapsed: ['Example'], hidden_items: ['map'] };
function server() {
  const records = new Map();
  const calls = [];
  const connect = (authenticatedUser) => ({
    async sendMessagePromise(message) {
      calls.push(message);
      assert.equal(message.key, ACCOUNT_CONFIG_KEY);
      assert.equal('user_id' in message, false);
      if (message.type === 'frontend/set_user_data') records.set(authenticatedUser, structuredClone(message.value));
      else return { value: structuredClone(records.get(authenticatedUser) ?? null) };
    },
  });
  return { records, calls, connect };
}

test('opt-in migration is copied, persists across fresh desktop/mobile connections, and isolates accounts', async () => {
  const { connect, records } = server();
  assert.deepEqual(await loadAccountConfig(connect('a')), { status: 'absent' });
  const original = structuredClone(config);
  await saveAccountConfig(connect('a'), original);
  original.hidden_items.push('another');
  for (const device of ['fresh desktop', 'mobile', 'reload']) {
    assert.deepEqual(await loadAccountConfig(connect('a')), { status: 'ready', config }, device);
  }
  assert.deepEqual(await loadAccountConfig(connect('b')), { status: 'absent' });
  assert.equal(records.has('b'), false);
  const result = await loadAccountConfig(connect('a'));
  result.config.custom_groups.Example.reverse();
  assert.deepEqual((await loadAccountConfig(connect('a'))).config, config);
});

test('central replacement and removal only affect the authenticated account', async () => {
  const { connect } = server();
  await saveAccountConfig(connect('a'), config);
  await saveAccountConfig(connect('b'), { hidden_items: ['weather'] });
  await saveAccountConfig(connect('a'), { custom_groups: { Updated: ['lights'] } });
  assert.deepEqual((await loadAccountConfig(connect('a'))).config, { custom_groups: { Updated: ['lights'] } });
  await saveAccountConfig(connect('a'), null);
  assert.deepEqual(await loadAccountConfig(connect('a')), { status: 'absent' });
  assert.deepEqual((await loadAccountConfig(connect('b'))).config, { hidden_items: ['weather'] });
});

test('malformed records and network failures do not become absent or trigger writes', async () => {
  for (const value of [undefined, {}, { version: 2, config }, { version: 1, config: null },
    { version: 1, config: { custom_groups: { Bad: 'lights' } } },
    { version: 1, config: { hidden_items: [7] } }, { version: 1, config: { visibility_templates: { groups: [] } } }]) {
    let count = 0;
    assert.deepEqual(await loadAccountConfig({ sendMessagePromise: async () => { count++; return { value }; } }), { status: 'unavailable' });
    assert.equal(count, 1);
  }
  assert.deepEqual(await loadAccountConfig({ sendMessagePromise: async () => { throw Error('offline'); } }), { status: 'unavailable' });
});

test('invalid input never reaches server; failed writes reject', async () => {
  let writes = 0;
  await assert.rejects(saveAccountConfig({ sendMessagePromise: async () => { writes++; } }, { bottom_items: false }));
  assert.equal(writes, 0);
  await assert.rejects(saveAccountConfig({ sendMessagePromise: async () => { throw Error('offline'); } }, config));
  assert.throws(() => validateAccountConfig([]));
});

test('server loader is independent of browser file flags and storage (including unavailable localStorage)', async () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('must not access browser cache'); } });
  const { connect } = server();
  await saveAccountConfig(connect('a'), config);
  assert.deepEqual((await loadAccountConfig(connect('a'))).config, config);
  delete globalThis.localStorage;
});
