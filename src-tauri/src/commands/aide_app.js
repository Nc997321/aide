// Aide 应用桥（由 Aide 提供，应用页面里 <script src="/aide-app.js"></script> 引入）。
// 应用跑在沙箱 iframe 里，够不着 Aide 的任何内部接口；想做面板之外的事只能经这里发消息，
// 由 Host 按清单里申请的权限放行。
(() => {
  if (window.aide) return;
  let seq = 0;
  const pending = new Map();
  const listeners = new Map();

  window.addEventListener("message", (e) => {
    // 只认外层（Aide 主页面）发来的消息
    if (e.source !== window.parent || !e.data || e.data.aideApp !== 1) return;
    const msg = e.data;
    if (msg.event) {
      // 进程的动静：这里拿到的只是「有新的了」，换成正文再给应用
      if (msg.event.startsWith("process:")) {
        const runId = msg.event.slice("process:".length);
        if (outputs.has(runId)) pull(runId);
        return;
      }
      emit(msg.event, msg.payload);
      return;
    }
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.ok) waiter.resolve(msg.result);
    else waiter.reject(new Error(msg.error || "aide: call failed"));
  });

  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ aideApp: 1, id, method, params: params ?? {} }, "*");
    });
  }

  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  }

  // 主题：把 Aide 的 --aide-* 变量铺到本页根元素上，应用直接写 var(--aide-accent) 即可跟随主题
  function applyTheme(theme) {
    if (!theme || !theme.vars) return;
    const root = document.documentElement;
    for (const [name, value] of Object.entries(theme.vars)) root.style.setProperty(name, value);
    if (theme.colorScheme) root.style.setProperty("color-scheme", theme.colorScheme);
  }
  on("theme", applyTheme);

  // 进程的输出：Host 的事件只报「有新输出」和最新序号，正文在这里按序号取回来，再交给应用。
  // 一次只取一趟；取的途中又来了通知，取完再取。
  const outputs = new Map(); // runId -> { seen, busy, again, done }
  async function pull(runId) {
    const st = outputs.get(runId);
    if (!st || st.busy) { if (st) st.again = true; return; }
    st.busy = true;
    try {
      for (;;) {
        st.again = false;
        const got = await call("process.attach", { runId, since: st.seen });
        // 缓冲滚过去了（输出比面板取得快）：如实告诉应用中间丢了多少行
        if (got.first > st.seen + 1) emit(`process:${runId}`, { type: "gap", lost: got.first - st.seen - 1 });
        for (const line of got.lines) {
          st.seen = line.seq;
          emit(`process:${runId}`, { type: "output", data: line.text, stream: line.stream, seq: line.seq });
        }
        if (st.seen < got.head) continue;
        if (!got.running && !st.done) {
          st.done = true;
          emit(`process:${runId}`, { type: "exit", code: got.code, killed: got.killed });
          outputs.delete(runId);
          return;
        }
        if (!st.again) return;
      }
    } catch (err) {
      console.error(err);
    } finally {
      st.busy = false;
    }
  }
  function emit(event, payload) {
    for (const fn of listeners.get(event) || []) {
      try { fn(payload); } catch (err) { console.error(err); }
    }
  }
  // 开始跟一个进程的输出，从序号 `since` 之后（0 = 从缓冲里最早的开始）
  function follow(runId, since) {
    if (!outputs.has(runId)) outputs.set(runId, { seen: Number(since) || 0, busy: false, again: false, done: false });
    return pull(runId);
  }

  window.aide = {
    call,
    on,
    // → { os, source, host: "local" | "wsl" | "ssh" }
    host: { info: () => call("host.info") },
    // 面板所在的工作区（需要 workspace:read）。→ { name, root, trusted, host }；没有打开工作区 → null。
    // 用户切去另一个工作区时面板会整页重载，所以启动时取一次就够
    workspace: { info: () => call("workspace.info") },
    theme: { get: () => call("theme.get"), onChange: (fn) => on("theme", fn) },
    ui: {
      toast: (text) => call("ui.toast", { text: String(text) }),
      setBadge: (count) => call("ui.setBadge", { count: Number(count) || 0 }),
    },
    storage: {
      get: (key) => call("storage.get", { key }),
      set: (key, value) => call("storage.set", { key, value }),
      delete: (key) => call("storage.delete", { key }),
      keys: () => call("storage.keys"),
    },
    secrets: {
      get: (key) => call("secrets.get", { key }),
      set: (key, value) => call("secrets.set", { key, value: String(value) }),
      delete: (key) => call("secrets.delete", { key }),
    },
    // 由 Host 发请求（页面自己不许联网）。→ { status, statusText, headers, body, bodyBase64 }
    net: { fetch: (request) => call("net.fetch", typeof request === "string" ? { url: request } : request) },
    // 当前工作区里的文件，路径相对工作区根
    fs: {
      read: (path) => call("fs.read", { path }),
      list: (path) => call("fs.list", path ? { path } : {}),
      write: (path, text) => call("fs.write", { path, text }),
      // → { isDir, size, mtime }
      stat: (path) => call("fs.stat", { path }),
      // 按文件名找（名字相等的在前，其次名字包含；遵守 .gitignore）。→ 相对路径数组
      find: (name, opts) => call("fs.find", { name, ...(opts || {}) }).then((r) => r.files),
      // 按内容搜。opts: { mask: "*.ts", regex, caseSensitive, wholeWord, limit }
      // → { files: [{ file, matches: [{ line, column, lineText, matchStart, matchEnd }] }], total, truncated }
      search: (query, opts) => call("fs.search", { query, ...(opts || {}) }),
      // 工作区里的文件变了。fn 收到 { dirs: [相对目录…] } 或 { full: true }（说不清哪里变了，全部重读）。
      // 粒度是目录：收到后自己重新 list / read
      watch: (fn) => on("fs", fn),
    },
    // 在工作区里运行命令（需要 process 权限；工作区必须受信任）。不经 shell：command 是可执行文件，
    // args 是参数数组。进程归 Aide 管——面板关了、重载了它照跑，回来用 list + attach 续上
    process: {
      // → { runId, … }。之后用 aide.on(`process:${runId}`, fn) 收输出：
      // { type: "output", data, stream, seq } | { type: "exit", code, killed } | { type: "gap", lost }
      run: async (request) => {
        const info = await call("process.run", request);
        follow(info.runId, 0);
        return info;
      },
      kill: (runId) => call("process.kill", { runId }),
      // 本应用在当前工作区里的进程（含刚结束不久的）
      list: () => call("process.list"),
      // 面板重载后续上一个还在跑的进程：先 aide.on(`process:${runId}`, fn)，再 attach。
      // since = 上次看到的 seq（不给就从缓冲里最早的一行开始）
      attach: (runId, opts) => follow(runId, opts && opts.since),
    },
    // 在 Aide 的编辑器里打开工作区里的文件（需要 workspace:read）。line 从 1 起
    editor: { open: (path, opts) => call("editor.open", { path, line: opts && opts.line }) },
    // 本应用后端（清单里的 server）的工具
    tools: {
      list: () => call("tools.list"),
      call: (name, args) => call("tools.call", { name, arguments: args ?? {} }),
    },
    // 往用户当前会话的输入框里填一段文字（需要 composer 权限）。只填不发，发不发由用户决定
    composer: { fill: (text) => call("composer.fill", { text: String(text) }) },
    // agent 的活动（需要 session:read 权限，没有就收不到）
    session: { onEvent: (fn) => on("session", fn) },
  };

  // 界面里的报错记进应用的开发日志（.aide-dev.log），agent 读它就知道自己写的东西跑成什么样。
  // 记日志本身出错不能再触发记日志。
  const describe = (v) => {
    if (v instanceof Error) return v.stack || v.message;
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch (_) { return String(v); }
  };
  const report = (text) => { call("log.write", { level: "error", text: String(text).slice(0, 4000) }).catch(() => {}); };
  // 捕获阶段才看得到资源加载失败（脚本 / 样式 / 图片的 error 不冒泡）：引错路径、被拦的模块，
  // 否则就是一片空白、日志里什么都没有。
  window.addEventListener("error", (e) => {
    const el = e.target;
    if (el && el !== window && el.tagName) {
      report(`加载失败：<${el.tagName.toLowerCase()}> ${el.src || el.href || ""}`);
      return;
    }
    report(`${e.message} (${e.filename || "?"}:${e.lineno || 0})`);
  }, true);
  window.addEventListener("unhandledrejection", (e) => report(`unhandled rejection: ${describe(e.reason)}`));
  const consoleError = console.error.bind(console);
  console.error = (...args) => { consoleError(...args); report(args.map(describe).join(" ")); };

  call("theme.get").then(applyTheme, () => {});
})();
