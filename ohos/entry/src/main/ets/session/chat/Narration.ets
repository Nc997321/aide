/**
 * 旁白：把一次工具调用说成一句人话（「正在读 a.ts…」「修改了 ChatPage.ets」），
 * 时间线不再露工具名（Bash / mcp__aide-browser__browser_act …）。
 *
 * 移植自 packages/aide-sdk/src/utils/narration.ts 的**单次调用**部分（说法逐条对齐）。
 * 手机端时间线节奏不变：非写盘工具仍是瞬态行、做完即消失，Edit/Write 仍是常驻行，
 * 所以不移植桌面的「相邻同类合成一句」。桌面改说法时这里同步。
 */

/** 一段文字。tone：'' 普通 / obj 对象 / mono 等宽对象 / err 失败 / meta 次要。 */
export class NarrSeg {
  text: string = '';
  tone: string = '';

  constructor(text: string, tone: string) {
    this.text = text;
    this.tone = tone;
  }
}

export class Narration {
  segs: NarrSeg[] = [];
  /** 有失败（不含被拒）。 */
  error: boolean = false;
  /** 被拒：'' 未拒 / user 你拒绝的 / policy 命中权限规则。 */
  denied: string = '';
}

/** 人工拒绝 / 规则拒绝的外框首句（同 SDK toolDenial.ts，写入方 sidecar permissions.ts）。 */
const DENY_USER_PREFIX: string = "The user doesn't want to proceed with this tool use.";
const DENY_POLICY_PREFIX: string = 'Permission for this tool use was denied.';

function denialKind(result: string): string {
  const s: string = result.trimStart();
  if (s.startsWith(DENY_USER_PREFIX)) {
    return 'user';
  }
  if (s.startsWith(DENY_POLICY_PREFIX)) {
    return 'policy';
  }
  return '';
}

// ── 小工具 ──

function field(input: Record<string, Object>, key: string): string {
  const v: Object | undefined = input[key];
  return typeof v === 'string' ? v as string : '';
}

function numField(input: Record<string, Object>, key: string): number | undefined {
  const v: Object | undefined = input[key];
  return typeof v === 'number' ? v as number : undefined;
}

function arrField(input: Record<string, Object>, key: string): Object[] {
  const v: Object | undefined = input[key];
  return v instanceof Array ? v as Object[] : [];
}

function asRec(v: Object | undefined): Record<string, Object> {
  return v !== undefined && v !== null && typeof v === 'object' ? v as Record<string, Object> : {};
}

/** 截短到 max 个字符，超出加「…」。 */
function clip(s: string, max: number): string {
  const t: string = s.replace(new RegExp('\\s+', 'g'), ' ').trim();
  return t.length > max ? `${t.substring(0, max - 1)}…` : t;
}

/** 路径最后一段（兼容 / 与 \）。 */
function baseName(p: string): string {
  const parts: string[] = p.split(new RegExp('[\\\\/]')).filter((x: string) => x !== '');
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

function shortUrl(u: string): string {
  return clip(u.replace(new RegExp('^[a-z]+://', 'i'), '').replace(new RegExp('[?#].*$'), '')
    .replace(new RegExp('/$'), ''), 48);
}

function t(text: string): NarrSeg {
  return new NarrSeg(text, '');
}

function o(text: string): NarrSeg {
  return new NarrSeg(text, 'obj');
}

function mono(text: string): NarrSeg {
  return new NarrSeg(text, 'mono');
}

function quoted(text: string): NarrSeg {
  return o(`「${clip(text, 40)}」`);
}

/** 片段拼回纯文本。 */
export function narrationText(segs: NarrSeg[]): string {
  return segs.map((s: NarrSeg) => s.text).join('');
}

/** `mcp__<server>__<tool>` → [server, tool]；不是 MCP 名返回 null。 */
function splitMcp(name: string): string[] | null {
  const m: RegExpExecArray | null = new RegExp('^mcp__(.+?)__(.+)$').exec(name);
  return m !== null ? [m[1], m[2]] : null;
}

function mcpTool(name: string): string {
  const m: string[] | null = splitMcp(name);
  return m !== null ? m[1] : '';
}

// ── 单次调用 ──

/** 一次调用的「进行中」与「做完」两种说法。 */
class Parts {
  live: NarrSeg[];
  done: NarrSeg[];

  constructor(live: NarrSeg[], done: NarrSeg[]) {
    this.live = live;
    this.done = done;
  }
}

/** 带地点前缀的说法（「在内置浏览器里」「在电脑上」「在知识库里」）。 */
function placed(place: string, clause: NarrSeg[], liveClause: NarrSeg[]): Parts {
  return new Parts([t(`正在${place}`)].concat(liveClause).concat([t('…')]), [t(`在${place}`)].concat(clause));
}

/** Grep / Glob 命中数：「Found 4 files」或逐行计数；没命中 0；拿不到 -1。 */
function searchHits(result: string, usable: boolean, isError: boolean): number {
  if (!usable || isError) {
    return -1;
  }
  const head: string = result.substring(0, 120);
  if (new RegExp('^No (files|matches) found', 'i').test(head)) {
    return 0;
  }
  const m: RegExpExecArray | null = new RegExp('^Found (\\d+)', 'i').exec(head);
  if (m !== null) {
    return Number(m[1]);
  }
  const body: string = result.trim();
  return body !== '' ? body.split('\n').length : 0;
}

function countTail(n: number, unit: string): NarrSeg[] {
  if (n < 0) {
    return [];
  }
  return n === 0 ? [new NarrSeg('，没找到', 'meta')] : [t(`，找到 ${n} ${unit}`)];
}

function readRange(input: Record<string, Object>): string {
  const offset: number | undefined = numField(input, 'offset');
  const limit: number | undefined = numField(input, 'limit');
  if (offset === undefined && limit === undefined) {
    return '';
  }
  const from: number = offset !== undefined ? offset : 1;
  return limit !== undefined ? `第 ${from}–${from + limit - 1} 行` : `第 ${from} 行起`;
}

function commandLine(cmd: string): string {
  const lines: string[] = cmd.split('\n');
  let first: string = cmd;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = lines[i];
      break;
    }
  }
  return clip(first, 56);
}

function partsFor(name: string, input: Record<string, Object>, result: string, usable: boolean,
  isError: boolean, isPending: boolean): Parts {
  switch (name) {
    case 'Read':
    case 'NotebookRead': {
      const file: string = baseName(field(input, 'file_path') !== '' ? field(input, 'file_path') : field(input, 'notebook_path'));
      const range: string = readRange(input);
      return new Parts([t('正在读 '), mono(file), t('…')],
        [t('读了 '), mono(file)].concat(range !== '' ? [new NarrSeg(` ${range}`, 'meta')] : []));
    }
    case 'Glob': {
      const pattern: string = clip(field(input, 'pattern'), 40);
      return new Parts([t('正在找 '), mono(pattern), t(' 文件…')],
        [t('找了 '), mono(pattern), t(' 文件')].concat(countTail(searchHits(result, usable, isError), '个')));
    }
    case 'LS': {
      const d: string = baseName(field(input, 'path'));
      const dir: string = d !== '' ? d : '目录';
      return new Parts([t('正在看 '), mono(dir), t(' 目录…')], [t('看了 '), mono(dir), t(' 目录')]);
    }
    case 'Grep': {
      const pattern: string = field(input, 'pattern');
      return new Parts([t('正在项目里搜索'), quoted(pattern), t('…')],
        [t('在项目里搜索了'), quoted(pattern)].concat(countTail(searchHits(result, usable, isError), '处')));
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const file: string = baseName(field(input, 'file_path') !== '' ? field(input, 'file_path') : field(input, 'notebook_path'));
      const created: boolean = name === 'Write' && !isPending && new RegExp('created', 'i').test(result);
      return new Parts([t('正在修改 '), mono(file), t('…')], [t(created ? '新建了 ' : '修改了 '), mono(file)]);
    }
    case 'BashOutput':
      return new Parts([t('正在看后台命令的输出…')], [t('看了后台命令的输出')]);
    case 'KillShell':
    case 'KillBash':
      return new Parts([t('正在停止后台命令…')], [t('停止了后台命令')]);
    case 'Bash': {
      const cmd: string = commandLine(field(input, 'command'));
      const bg: boolean = input['run_in_background'] === true;
      return new Parts([t('正在运行 '), mono(cmd), t('…')], [t(bg ? '在后台启动了 ' : '运行了 '), mono(cmd)]);
    }
    case 'LSP':
      return lspParts(name, input);
    case 'WebSearch': {
      const q: string = field(input, 'query');
      return new Parts([t('正在网上搜索'), quoted(q), t('…')], [t('在网上搜索了'), quoted(q)]);
    }
    case 'WebFetch': {
      const url: string = shortUrl(field(input, 'url'));
      return new Parts([t('正在读网页 '), mono(url), t('…')], [t('读了网页 '), mono(url)]);
    }
    case 'Agent':
    case 'Task': {
      const d: string = field(input, 'description');
      return new Parts([t('助手正在'), quoted(d), t('…')], [t('派了一个助手去'), quoted(d)]);
    }
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
      return todoParts(input);
    case 'Skill': {
      const s: string = field(input, 'skill') !== '' ? field(input, 'skill') : field(input, 'name');
      return new Parts([t('正在加载'), quoted(s), t('技能…')], [t('用了'), quoted(s), t('技能')]);
    }
    case 'AskUserQuestion': {
      const qs: Object[] = arrField(input, 'questions');
      const first: string = qs.length > 0 ? field(asRec(qs[0]), 'question') : '';
      return new Parts([t('在问你：'), o(clip(first, 60))],
        [t('问了你：'), o(clip(first, 60))].concat(qs.length > 1 ? [t(` 等 ${qs.length} 个问题`)] : []));
    }
    case 'EnterPlanMode':
      return new Parts([t('正在进入计划模式…')], [t('进入了计划模式')]);
    case 'ExitPlanMode':
      return new Parts([t('在等你确认计划…')], [t('提交了计划')]);
    default:
      break;
  }
  const mcp: string[] | null = splitMcp(name);
  if (mcp === null) {
    const label: string = name === 'ToolSearch' ? '查找可用工具' : name;
    return new Parts([t('正在'), quoted(label), t('…')], [t('执行了'), quoted(label)]);
  }
  switch (mcp[0]) {
    case 'aide-browser':
      return browserParts(mcp[1], input);
    case 'aide-computer':
      return computerParts(mcp[1], input);
    case 'aide-knowledge':
      return kbParts(mcp[1], input, usable ? result : '');
    case 'aide-lsp':
      return lspParts(name, input);
    case 'aide-docs': {
      const file: string = baseName(field(input, 'file_path'));
      const write: boolean = mcp[1].endsWith('write_docx');
      return new Parts([t(write ? '正在生成 ' : '正在读 '), mono(file), t('…')], [t(write ? '生成了 ' : '读了 '), mono(file)]);
    }
    case 'aide-memory': {
      const r: string = baseName(field(input, 'root'));
      const root: string = r !== '' ? r : '另一个项目';
      return new Parts([t('正在翻 '), o(root), t(' 的记忆…')], [t('翻了一下 '), o(root), t(' 的记忆')]);
    }
    case 'aide-sessions':
      return subsessionParts(mcp[1], input);
    case 'aide-watch':
      return watchParts(mcp[1], input);
    default: {
      const server: string = mcp[0].replace(new RegExp('^app-'), '');
      const tool: string = mcp[1].replace(new RegExp('[_-]+', 'g'), ' ');
      return new Parts([t('正在用 '), o(server), t(' 执行'), quoted(tool), t('…')],
        [t('用 '), o(server), t(' 执行了'), quoted(tool)]);
    }
  }
}

function todoParts(input: Record<string, Object>): Parts {
  const todos: Object[] = arrField(input, 'todos');
  if (todos.length === 0) {
    return new Parts([t('正在更新待办…')], [t('更新了待办')]);
  }
  let done: number = 0;
  let active: string = '';
  for (let i = 0; i < todos.length; i++) {
    const x: Record<string, Object> = asRec(todos[i]);
    if (field(x, 'status') === 'completed') {
      done++;
    } else if (active === '' && field(x, 'status') === 'in_progress') {
      active = field(x, 'content');
    }
  }
  return new Parts([t('正在更新待办…')],
    [t(`更新了待办：${done}/${todos.length} 已完成`)].concat(active !== '' ? [t('，正在'), quoted(active)] : []));
}

function lspParts(name: string, input: Record<string, Object>): Parts {
  const tool: string = mcpTool(name);
  const op: string = tool !== '' ? tool : field(input, 'operation');
  const names: Object[] = arrField(input, 'names');
  let sym: string = field(input, 'name');
  if (sym === '' && names.length > 0 && typeof names[0] === 'string') {
    sym = names[0] as string;
  }
  if (sym === '' && field(input, 'file') !== '') {
    sym = baseName(field(input, 'file'));
  }
  if (sym === '') {
    sym = '符号';
  }
  if (op === 'lsp_outline' || op === 'documentSymbol') {
    const file: string = baseName(field(input, 'file') !== '' ? field(input, 'file') : field(input, 'filePath'));
    return new Parts([t('正在看 '), mono(file), t(' 的结构…')], [t('看了 '), mono(file), t(' 的结构')]);
  }
  const what: string = op === 'lsp_references' || op === 'findReferences' ? '引用'
    : op === 'lsp_implementations' || op === 'goToImplementation' ? '实现'
      : op === 'lsp_symbols' || op === 'workspaceSymbol' ? '位置' : '定义';
  return new Parts([t('正在查 '), mono(clip(sym, 32)), t(` 的${what}…`)], [t('查了 '), mono(clip(sym, 32)), t(` 的${what}`)]);
}

function kbParts(tool: string, input: Record<string, Object>, r: string): Parts {
  const p: string = '知识库里';
  switch (tool) {
    case 'search': {
      const q: string = field(input, 'query');
      const m: RegExpExecArray | null = r !== '' ? new RegExp('\\((\\d+)\\):').exec(r.substring(0, 200)) : null;
      const none: boolean = r !== '' && r.startsWith('No match');
      const tail: NarrSeg[] = none ? [new NarrSeg('，没找到', 'meta')] : m !== null ? [t(`，找到 ${m[1]} 篇`)] : [];
      return placed(p, [t('搜索了'), quoted(q)].concat(tail), [t('搜索'), quoted(q)]);
    }
    case 'read_document': {
      const m: RegExpExecArray | null = r !== '' ? new RegExp('^# (.+)$', 'm').exec(r.substring(0, 300)) : null;
      return placed(p, [t('读了'), m !== null ? o(`《${clip(m[1], 30)}》`) : t('一篇文档')], [t('读文档')]);
    }
    case 'list_spaces':
      return placed(p, [t('看了有哪些知识空间')], [t('看有哪些知识空间')]);
    case 'list_documents':
      return placed(p, [t('看了一个空间里的文档列表')], [t('看文档列表')]);
    case 'create_document': {
      const title: NarrSeg = o(`《${clip(field(input, 'title'), 30)}》`);
      return placed(p, [t('新建了'), title], [t('新建'), title]);
    }
    case 'create_folder':
      return placed(p, [t('新建了文件夹'), quoted(field(input, 'title'))], [t('新建文件夹')]);
    case 'move_document':
      return placed(p, [t('移动了一篇文档')], [t('移动文档')]);
    case 'append_document':
      return placed(p, [t('在一篇文档末尾追加了内容')], [t('追加内容')]);
    case 'update_document':
      return placed(p, [t('改写了一篇文档')], [t('改写文档')]);
    case 'ingest_file': {
      const f: string = baseName(field(input, 'filePath'));
      return placed(p, [t('导入了 '), mono(f)], [t('导入 '), mono(f)]);
    }
    case 'delete_document':
      return placed(p, [t('删除了一篇文档')], [t('删除文档')]);
    case 'edit_selection':
      return placed(p, [t('改了你圈选的那段')], [t('改你圈选的那段')]);
    default: {
      const label: string = tool.replace(new RegExp('_', 'g'), ' ');
      return placed(p, [t('执行了'), quoted(label)], [t('执行'), quoted(label)]);
    }
  }
}

function browserParts(tool: string, input: Record<string, Object>): Parts {
  const p: string = '内置浏览器里';
  const target: string = field(input, 'text') !== '' ? field(input, 'text') : field(input, 'selector');
  switch (tool) {
    case 'browser_tab': {
      const action: string = field(input, 'action');
      const url: string = shortUrl(field(input, 'url'));
      if (action === 'open') {
        return placed(p, [t('打开了 '), mono(url)], [t('打开 '), mono(url)]);
      }
      if (action === 'navigate') {
        return placed(p, [t('转到了 '), mono(url)], [t('转到 '), mono(url)]);
      }
      if (action === 'back') {
        return placed(p, [t('后退了一页')], [t('后退')]);
      }
      if (action === 'forward') {
        return placed(p, [t('前进了一页')], [t('前进')]);
      }
      if (action === 'close') {
        return placed(p, [t('关掉了一个标签页')], [t('关标签页')]);
      }
      return placed(p, [t('把页面切到了前台')], [t('切换页面')]);
    }
    case 'browser_act': {
      const action: string = field(input, 'action');
      if (action === 'fill') {
        return placed(p, [t('在'), quoted(target), t('里填了 '), o(clip(field(input, 'value'), 24))],
          [t('在'), quoted(target), t('里填写')]);
      }
      if (action === 'press') {
        const keys: string[] = [];
        const mods: Object[] = arrField(input, 'modifiers');
        for (let i = 0; i < mods.length; i++) {
          const m: string = typeof mods[i] === 'string' ? mods[i] as string : '';
          if (m !== '') {
            keys.push(m.charAt(0).toUpperCase() + m.substring(1));
          }
        }
        if (field(input, 'key') !== '') {
          keys.push(field(input, 'key'));
        }
        const key: string = keys.join('+');
        return placed(p, [t('按了 '), mono(key)], [t('按 '), mono(key)]);
      }
      if (action === 'hover') {
        return placed(p, [t('把鼠标移到了'), quoted(target), t('上')], [t('把鼠标移到'), quoted(target), t('上')]);
      }
      return placed(p, [t('点击了'), quoted(target)], [t('点击'), quoted(target)]);
    }
    case 'browser_read':
      return placed(p, [t('查看了页面内容')], [t('查看页面')]);
    case 'browser_tabs':
      return placed(p, [t('看了开着哪些页面')], [t('看开着哪些页面')]);
    case 'browser_wait':
      return placed(p, [t('等页面就绪')], [t('等页面就绪')]);
    case 'browser_screenshot':
      return placed(p, [t('截了一张图')], [t('截图')]);
    case 'browser_eval':
      return placed(p, [t('在页面里执行了一段脚本')], [t('在页面里执行脚本')]);
    case 'browser_network':
      return placed(p, [t('看了网络请求')], [t('看网络请求')]);
    case 'browser_console':
      return placed(p, [t('看了控制台')], [t('看控制台')]);
    default: {
      const label: string = tool.replace(new RegExp('_', 'g'), ' ');
      return placed(p, [t('执行了'), quoted(label)], [t('执行'), quoted(label)]);
    }
  }
}

function computerParts(tool: string, input: Record<string, Object>): Parts {
  const p: string = '电脑上';
  switch (tool) {
    case 'computer_act': {
      const c: string = clip(field(input, 'intent'), 48);
      const intent: string = c !== '' ? c : '做了一步操作';
      return placed(p, [o(intent)], [o(intent)]);
    }
    case 'computer_window': {
      const action: string = field(input, 'action');
      if (action === 'launch') {
        const app: string = field(input, 'app');
        return placed(p, [t('打开了 '), o(app)], [t('打开 '), o(app)]);
      }
      const verb: string = action === 'focus' ? '切换了窗口'
        : action === 'minimize' ? '最小化了窗口'
          : action === 'maximize' ? '最大化了窗口'
            : action === 'restore' ? '还原了窗口'
              : action === 'close' ? '关掉了一个窗口' : '调整了窗口';
      return placed(p, [t(verb)], [t(verb.replace('了', ''))]);
    }
    case 'computer_read':
      return placed(p, [t('看了窗口内容')], [t('看窗口')]);
    case 'computer_windows':
      return placed(p, [t('看了开着哪些窗口')], [t('看开着哪些窗口')]);
    case 'computer_wait':
      return placed(p, [t('等界面就绪')], [t('等界面就绪')]);
    default: {
      const label: string = tool.replace(new RegExp('_', 'g'), ' ');
      return placed(p, [t('执行了'), quoted(label)], [t('执行'), quoted(label)]);
    }
  }
}

function subsessionParts(tool: string, input: Record<string, Object>): Parts {
  if (tool === 'session_spawn') {
    let title: string = field(input, 'title');
    if (title === '') {
      title = commandLine(field(input, 'task'));
    }
    return new Parts([t('正在开子会话'), quoted(title), t('…')], [t('开了一个子会话'), quoted(title)]);
  }
  if (tool === 'session_message') {
    return new Parts([t('正在给子会话追加指令…')], [t('给子会话追加了指令：'), o(clip(field(input, 'text'), 40))]);
  }
  return new Parts([t('正在看子会话…')], [t('看了子会话的进展')]);
}

function watchParts(tool: string, input: Record<string, Object>): Parts {
  if (tool === 'watch_start') {
    const e: number | undefined = numField(input, 'every_seconds');
    const every: number = e !== undefined ? e : 0;
    const freq: string = every >= 60 ? `，每 ${Math.round(every / 60)} 分钟看一次` : every > 0 ? `，每 ${every} 秒看一次` : '';
    const title: NarrSeg = quoted(field(input, 'title'));
    return new Parts([t('正在开始值守'), title, t('…')], [t('开始值守'), title, t(freq)]);
  }
  if (tool === 'watch_stop') {
    return new Parts([t('正在停止值守…')], [t('停止了值守')]);
  }
  return new Parts([t('正在看值守列表…')], [t('看了值守列表')]);
}

/** 失败的尾巴：命令带退出码，其余「，没成功」。 */
function failureTail(name: string, result: string): NarrSeg[] {
  if (name === 'Bash') {
    const m: RegExpExecArray | null = new RegExp('exit code (\\d+)', 'i').exec(result);
    return [new NarrSeg(m !== null ? `，失败（退出码 ${m[1]}）` : '，失败', 'err')];
  }
  return [new NarrSeg('，没成功', 'err')];
}

/** 被拒：「想运行 rm -rf dist」——进行中说法去掉「正在」与「…」，换成「想」。 */
function deniedSegs(p: Parts): NarrSeg[] {
  const segs: NarrSeg[] = p.live.map((s: NarrSeg) => new NarrSeg(s.text, s.tone));
  if (segs.length > 0) {
    segs[0].text = segs[0].text.replace(new RegExp('^(助手)?正在'), '想');
    const last: NarrSeg = segs[segs.length - 1];
    last.text = last.text.replace(new RegExp('…$'), '');
  }
  return segs.filter((s: NarrSeg) => s.text !== '');
}

/** 一次工具调用 → 一句旁白（进行中 / 做完 / 失败 / 被拒）。 */
export function narrateCall(name: string, input: Object, result: string, isError: boolean,
  isPending: boolean): Narration {
  const n: Narration = new Narration();
  const denied: string = isPending ? '' : denialKind(result);
  const usable: boolean = !isPending && denied === '';
  const p: Parts = partsFor(name, asRec(input), result, usable, isError, isPending);
  if (isPending) {
    n.segs = p.live;
  } else if (denied !== '') {
    n.segs = deniedSegs(p);
    n.denied = denied;
  } else {
    n.error = isError;
    n.segs = isError ? p.done.concat(failureTail(name, result)) : p.done;
  }
  return n;
}
