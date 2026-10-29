import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, Packer, Paragraph } from "docx";
import { prepareInputDocuments } from "./inputDocuments.js";
let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });
describe("用户文档输入预处理", () => {
  it("直接解析 DOCX 并广播可显示的正文，不需要模型读取工具", async () => {
    dir = await mkdtemp(join(tmpdir(), "aide-input-doc-"));
    const path = join(dir, "attachment.docx");
    const data = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("附件里的正文")] }] }));
    await writeFile(path, data);
    const cmd = { cmd: "send" as const, session_id: "input-doc-test", prompt: "帮我总结", session_profile: "chat" as const,
      input_documents: [path, path], display: [{ type: "mention" as const, path, content: "待解析" }] };
    const prepared = await prepareInputDocuments(cmd);
    expect(prepared.prompt).toContain("附件里的正文");
    expect(prepared.prompt.match(/用户提供的文档/g)).toHaveLength(1);
    expect(prepared.display?.[0]).toMatchObject({ type: "mention", content: expect.stringContaining("附件里的正文") });
    expect(prepared.input_documents).toBeUndefined();
    expect(cmd.display[0].content).toBe("待解析");
  });
  it("损坏文档和超量附件明确报错，不能把空内容当成已读取", async () => {
    dir = await mkdtemp(join(tmpdir(), "aide-input-doc-"));
    const path = join(dir, "bad.pdf");
    await writeFile(path, "not a pdf");
    await expect(prepareInputDocuments({ cmd: "send", session_id: "input-doc-test", prompt: "hi", input_documents: [path] })).rejects.toThrow("附件解析失败");
    await expect(prepareInputDocuments({ cmd: "send", session_id: "input-doc-test", prompt: "hi", input_documents: Array.from({ length: 9 }, (_, i) => `${i}.pdf`) })).rejects.toThrow("最多添加 8");
  });
});
