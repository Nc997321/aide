// Mock Anthropic 兼容端点：模拟"模型调用 Read 读图 → 图片请求 → 400"。
// 链路：首轮请求（无 tool_result）→ 回 tool_use Read（引导 CLI 读图）→
// CLI 回传 tool_result（含图片）→ 检测到 image → 400（同真实 SDK synthetic 400 形状）；
// 回滚后 resume 的重放请求（tool_result 已被替换为文本错误）→ 正常文本回复。
// 用法：npx tsx mock-vision-server.ts（监听 127.0.0.1:1899）
import http from "node:http";

const PORT = 1899;
const IMG = "C:/Users/<user>/Pictures/Saved Pictures/head_portrait.jpg";
let replyCount = 0;

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    if (req.method === "POST" && req.url?.startsWith("/v1/messages")) {
      let j: any = {};
      try { j = JSON.parse(body); } catch { /* ignore */ }
      const hasImage = /"type":"image"/.test(body);
      const hasToolResult = /"type":"tool_result"/.test(body);
      const hasReadTool = JSON.stringify(j.tools ?? []).includes('"name":"Read"');

      if (hasImage) {
        console.log(`[mock] #${++replyCount} 400: 请求含图片 → 拒绝`);
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "this model does not support image input (mock)" },
        }));
        return;
      }
      if (!hasToolResult && hasReadTool) {
        // 引导模型走 Read 工具（复现用户场景：模型读图片）
        console.log(`[mock] #${++replyCount} 200: 回 tool_use Read(${IMG})`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: `msg_mock_${replyCount}`,
          type: "message",
          role: "assistant",
          model: "mock-vision-lite",
          content: [{ type: "tool_use", id: `toolu_mock_${replyCount}`, name: "Read", input: { file_path: IMG } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
        }));
        return;
      }
      // 正常回复（回显最后一条文本）
      const texts: string[] = [];
      for (const m of j.messages ?? []) {
        for (const b of m.content ?? []) if (b?.type === "text") texts.push(b.text);
      }
      const last = texts.length > 0 ? texts[texts.length - 1].slice(0, 60) : "";
      console.log(`[mock] #${++replyCount} 200: 文本回复（末条用户文本: "${last}"）`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: `msg_mock_${replyCount}`,
        type: "message",
        role: "assistant",
        model: "mock-vision-lite",
        content: [{ type: "text", text: `（mock 回复 #${replyCount}）已收到：${last || "（无文本）"}` }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 10 },
      }));
    } else if (req.method === "GET" && req.url?.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mock-vision-lite", object: "model" }] }));
    } else if (req.url?.startsWith("/v1/messages/count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 1 }));
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found", url: req.url, method: req.method }));
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock] Anthropic 兼容 mock 监听 127.0.0.1:${PORT}`);
});
