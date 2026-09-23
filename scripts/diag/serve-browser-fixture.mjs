// 内置浏览器 recorder 夹具服务（跨平台，纯 node，无 shell）。
// 用法：node scripts/diag/serve-browser-fixture.mjs [port]     默认 8780
//
// 为什么不是一个内联 one-liner：本夹具要四个端点——其中一个**永不回包**（验 pending），
// 一个约 300KB（验响应体闸门）。静态一行命令服务不了这些。
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = Number(process.argv[2] ?? 8780);
const PAGE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "docs",
  "testing",
  "browser-recorder-fixture.html",
);

// 每个响应都**显式写 `content-length`**：recorder 的体积闸门读的正是这个头，缺了它 node 会退回
// `Transfer-Encoding: chunked`，闸门看不到尺寸——夹具于是测不出它本该测的那条路（判据 4 会假绿）。
const json = (res, code, obj) => {
  const payload = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
};

createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://127.0.0.1");
  if (pathname === "/api/ok") return json(res, 200, { ok: true, rows: [1, 2, 3] });
  if (pathname === "/api/fail")
    return json(res, 500, { error: "No enum constant com.demo.EQUIPMENT_MAINTENANCE_TASK_AUDIT" });
  // 永不回包：不 end、不 writeHead —— 客户端停在 pending，正是要验的形态
  if (pathname === "/api/hang") return;
  if (pathname === "/api/big") {
    const pad = "x".repeat(300 * 1024);
    const payload = JSON.stringify({ ok: true, pad });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      // 300KB 档必须带 content-length，否则闸门看不到尺寸（见 json() 的注释）——这条是判据 4 的**前提**。
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
    });
    return res.end(payload);
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(readFileSync(PAGE));
}).listen(PORT, "127.0.0.1", () => console.log(`fixture → http://127.0.0.1:${PORT}/`));
