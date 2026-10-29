// node ohos/scripts/verify-workspace-loading.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

async function main() {
  let resolveDaily;
  const daily = new Promise(resolve => { resolveDaily = resolve; });
  const source = fs.readFileSync(path.join(__dirname, '../entry/src/main/ets/session/WorkspaceModel.ets'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/@ObservedV2|@Trace /g, '');
  const exports = {};
  const api = {
    listWorkspaces: async () => [{ key: 'project', name: 'Project' }],
    getActiveWorkspace: async () => null,
    dailyWorkspace: () => daily
  };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, { exports, api, connModel: { state: 'authed' }, sessionsModel: { selectWorkspace() {} } });
  const model = exports.workspaceModel;
  const first = model.refresh();
  let finished = false;
  const second = model.refresh().then(() => { finished = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(model.loaded, false, 'project selection must wait for daily identity');
  assert.equal(finished, false, 'concurrent callers must wait for all workspace identities');
  resolveDaily({ key: 'daily', path: '/daily' });
  await Promise.all([first, second]);
  assert.equal(model.loaded, true);
  assert.equal(model.selectedKey, 'daily');
  model.select('project');
  await model.refresh();
  assert.equal(model.selectedKey, 'project', 'refresh must preserve explicit project selection');
  console.log('Workspace loading: daily identity ordering and explicit project selection passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
