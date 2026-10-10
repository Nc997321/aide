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
      for (const fn of listeners.get(msg.event) || []) {
        try { fn(msg.payload); } catch (err) { console.error(err); }
      }
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

  window.aide = {
    call,
    on,
    host: { info: () => call("host.info") },
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
    },
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
  window.addEventListener("error", (e) => report(`${e.message} (${e.filename || "?"}:${e.lineno || 0})`));
  window.addEventListener("unhandledrejection", (e) => report(`unhandled rejection: ${describe(e.reason)}`));
  const consoleError = console.error.bind(console);
  console.error = (...args) => { consoleError(...args); report(args.map(describe).join(" ")); };

  call("theme.get").then(applyTheme, () => {});
})();
