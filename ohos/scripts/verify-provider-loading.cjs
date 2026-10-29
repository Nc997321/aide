// node ohos/scripts/verify-provider-loading.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function main() {
  let request = deferred();
  let calls = 0;
  let active = 'first';
  const api = {
    getProviders: () => { calls++; return request.promise; },
    getActiveProviderId: async () => active
  };
  const source = fs.readFileSync(path.join(__dirname, '../entry/src/main/ets/session/ProviderModel.ets'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/@ObservedV2|@Trace /g, '');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, { exports, api, connModel: { state: 'authed' } });
  const model = exports.providerModel;
  const first = model.refresh();
  let finished = false;
  const second = model.refresh().then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false, 'chat initialization must wait for the existing request');
  assert.equal(calls, 1, 'concurrent refreshes share a request');
  request.resolve([{ id: 'first', name: 'First' }]);
  await Promise.all([first, second]);
  assert.equal(model.activeProvider().name, 'First');
  assert.equal(model.refreshing, false);

  request = deferred();
  const oldRequest = request;
  const oldRefresh = model.refresh();
  model.resetForHost();
  active = 'new';
  request = deferred();
  const newRefresh = model.refresh();
  oldRequest.resolve([{ id: 'first' }]);
  await oldRefresh;
  assert.equal(model.refreshing, true, 'old completion must not unlock the new host request');
  assert.equal(model.providers.length, 0, 'old host data must be discarded');
  request.resolve([{ id: 'new', name: 'New' }]);
  await newRefresh;
  assert.equal(model.activeProvider().name, 'New');
  api.getProviders = async () => { throw new Error('offline'); };
  await model.refresh();
  assert.equal(model.refreshing, false, 'failure must allow retry');
  assert.equal(model.activeProvider().name, 'New', 'transient failure preserves loaded data');
  api.getProviders = async () => [{ id: 'new', name: 'Retried' }];
  await model.refresh();
  assert.equal(model.activeProvider().name, 'Retried');
  console.log('Provider loading: shared request, host isolation and retry passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
