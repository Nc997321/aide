// Offline native SDK/CLI regression: no provider credentials or model calls.
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'agent-sidecar/package.json'));
const { query, createSdkMcpServer, tool } = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href);
const { z } = require('zod');
const sdkDir = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
const exe = process.env.AIDE_CLAUDE_EXE || join(sdkDir, '..', '..', '@anthropic-ai',
  `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude');
assert(existsSync(exe), 'Native CLI unavailable; set AIDE_CLAUDE_EXE to the installed CLI path.');
const temp = await mkdtemp(join(tmpdir(), 'aide-routing-'));
let calls = 0;
let requests = 0;
let advertised = [];
let requestedTool = 'Glob';
let requestedInput = { pattern: '**/*.ts' };

function send(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function answer(res, invoke) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  send(res, 'message_start', { type: 'message_start', message: { id: `test-${requests}`, type: 'message', role: 'assistant',
    model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  const block = invoke ? { type: 'tool_use', id: 'test-glob', name: requestedTool, input: {} } : { type: 'text', text: '' };
  send(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: block });
  send(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: invoke
    ? { type: 'input_json_delta', partial_json: JSON.stringify(requestedInput) } : { type: 'text_delta', text: 'done' } });
  send(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  send(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: invoke ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
  send(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (req.url?.includes('count_tokens')) { res.end('{"input_tokens":10}'); return; }
  if (!req.url?.includes('/messages')) { res.end('{}'); return; }
  const input = JSON.parse(body);
  advertised = input.tools?.map((entry) => entry.name) ?? [];
  answer(res, requests++ === 0);
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const port = server.address().port;
const target = 'mcp__aide-search__glob';
const mcp = createSdkMcpServer({ name: 'aide-search', version: '1', tools: [
  tool('glob', 'Offline fixture', { pattern: z.string(), path: z.string().optional() }, async () => {
    calls++;
    return { content: [{ type: 'text', text: 'fixture.ts' }] };
  }),
] });
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 30000);
try {
  const baseOptions = {
    cwd: temp, pathToClaudeCodeExecutable: exe, abortController: controller,
    settingSources: [], plugins: [], skills: [], systemPrompt: 'Offline fixture. Only use the fixture tool.',
    tools: [], disallowedTools: ['Glob'], toolAliases: { Glob: target },
    allowedTools: [target], mcpServers: { 'aide-search': mcp }, maxTurns: 3,
    env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'offline-fixture', ANTHROPIC_AUTH_TOKEN: '',
      CLAUDE_CONFIG_DIR: join(temp, 'config'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', NO_PROXY: '127.0.0.1,localhost' },
  };
  const q = query({ prompt: 'offline tool routing fixture', options: baseOptions });
  for await (const message of q) {
    if (message.type === 'result' && message.is_error) throw new Error(JSON.stringify(message.errors ?? message.result));
  }
  assert.equal(calls, 1, 'legacy Glob must reach the bounded MCP implementation exactly once');
  assert(advertised.includes(target), 'bounded search must be advertised');
  assert(!advertised.includes('Glob'), 'native Glob must not be advertised');
  await checkDesktopGate(baseOptions);
  console.log('PASS: native Glob routing and desktop deny/grant behavior, with no unsolicited approval or external model call.');
} finally {
  clearTimeout(timer);
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(temp, { recursive: true, force: true });
}

async function loadModule(path) {
  const result = require('esbuild').buildSync({ entryPoints: [join(root, path)], bundle: true,
    platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}

async function checkDesktopGate(baseOptions) {
  const { ExecutionPolicy } = await loadModule('agent-sidecar/src/extensions/executionPolicy.ts');
  const { SessionPolicy } = await loadModule('agent-sidecar/src/engine/policy/sessionHook.ts');
  const capability = new ExecutionPolicy();
  const policy = new SessionPolicy({ branchState: () => ({ cwd: temp, automationConfig: undefined }),
    automationVerdict: () => 'defer', toolGuard: (name, input) => capability.denyReason(name, false, input) });
  let executed = 0;
  let prompts = 0;
  const desktop = createSdkMcpServer({ name: 'aide-computer', version: '1', tools: [
    tool('computer_read', 'Offline mock, does not read the desktop', {}, async () => {
      executed++;
      return { content: [{ type: 'text', text: 'mock' }] };
    }),
  ] });
  requestedTool = 'mcp__aide-computer__computer_read';
  requestedInput = {};
  for (const authorized of [false, true]) {
    requests = 0;
    if (authorized) capability.receive('允许你操作电脑');
    const q = query({ prompt: 'offline desktop admission fixture', options: { ...baseOptions,
      toolAliases: {}, disallowedTools: [], allowedTools: [requestedTool],
      permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
      canUseTool: async () => { prompts++; return { behavior: 'allow', updatedInput: {} }; },
      mcpServers: { 'aide-computer': desktop }, hooks: { PreToolUse: [{ matcher: '.*', hooks: [policy.makeHook(temp)] }] },
    } });
    for await (const message of q) {
      if (message.type === 'result' && message.is_error) throw new Error('Offline desktop fixture failed');
    }
    assert.equal(executed, authorized ? 1 : 0, 'desktop must execute only after a real user grant');
    assert.equal(prompts, 0, 'capability admission must never become an unsolicited approval dialog');
  }
}
