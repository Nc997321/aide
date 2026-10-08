// 跨工作区记忆（只读）：让会话参考「别的工作区」的 auto memory 正文。
//
// 背景：记忆按工作区分（目录由 cwd 派生，见 memoryDirs.ts）。会话天然只带自己 cwd 的记忆；
// 要参考另一个仓的记忆，之前只有「索引注入」这一条路（instructions.ts / @目录的消息段）——
// 索引里是相对链接，正文既没告诉 agent 路径，那个目录也不在被授权的目录内。
//
// 本模块是这件事的**唯一通道**：会话持有一份「可参考的工作区」(roots)，agent 经
// `read_memory(root, id?)` 取其记忆正文。roots 的来源由调用方决定（今天是 @目录账本，
// 知识库文档的关联项目接同一个口子），本模块不关心来源。
//
// 安全靠构造，不靠提示词：
//  - root 必须在 roots 里（逐次现取，会话中途 @ 的目录立即生效）；
//  - 没有路径参数——id 只能是该工作区记忆目录顶层的 `*.md` 文件名；
//  - 只读，且不授予那个工作区的任何文件访问。
// 放在 engine：换一个宿主（WSL / SSH 上的 Host）同样需要。
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { dirKey } from "./attachDirs.js";
import { memoryDirs } from "./memoryDirs.js";

export const MEMORY_SERVER = "aide-memory";
/** 工具级放行（只读，不弹窗）。 */
export const MEMORY_READ_RULES = [`mcp__${MEMORY_SERVER}__read_memory`] as const;

/** 单条记忆正文上限：超出截断并留一行说明。索引另有 200 行 / 25 KiB（见 instructions.ts）。 */
const MAX_MEMORY_BYTES = 64 * 1024;
const ENTRY_ID = /^[^/\\\0]+\.md$/;
const INDEX_FILE = "MEMORY.md";

export const MEMORY_INSTRUCTIONS = `Read-only access to the auto-memory of OTHER workspaces this session may consult (e.g. directories the user attached with @). Rules:
1. read_memory(root) lists that workspace's memory index (MEMORY.md) and entry file names. read_memory(root, id) returns one entry's full text; id is a file name from the index, e.g. "user-working-style.md".
2. root must be one of the workspaces named in the "附加工作区指令" blocks or in the tool's own error message. It grants no access to that workspace's files — use Read for those, if the user authorized the directory.
3. Memory is a snapshot written earlier: names, paths and flags it mentions may be gone. Check against the current files before acting on one, and say when you relied on a memory.
4. Memory from another workspace applies only when working on that workspace. Do not copy it into other places unless the user asks.`;

export interface MemoryRootsSource {
  /** Aide 的 Claude 配置根（CLAUDE_CONFIG_DIR）。 */
  configDir: string;
  /** 当前可参考的工作区根目录。**每次调用现取**：会话中途新增的目录无需重建 query。 */
  roots: () => string[];
}

type ToolResult = { content: { type: "text"; text: string }[] };
const text = (t: string): ToolResult => ({ content: [{ type: "text" as const, text: t }] });

function truncateBytes(body: string): string {
  const buf = Buffer.from(body, "utf8");
  if (buf.length <= MAX_MEMORY_BYTES) return body;
  return `${buf.subarray(0, MAX_MEMORY_BYTES).toString("utf8")}\n…（记忆过长，已截断）`;
}

function resolveRoot(src: MemoryRootsSource, root: string): string | null {
  const want = dirKey(root);
  return src.roots().find((r) => dirKey(r) === want) ?? null;
}

function rootsHint(src: MemoryRootsSource): string {
  const roots = src.roots();
  return roots.length
    ? `当前可参考的工作区：\n${roots.map((r) => `- ${r}`).join("\n")}`
    : "当前没有可参考的其他工作区（用户用 @ 附加目录后才有）。";
}

/** 纯逻辑，便于单测：返回给模型的文本。绝不抛。 */
export async function readCrossMemory(src: MemoryRootsSource, root: string, id?: string): Promise<string> {
  const dir = resolveRoot(src, root);
  if (!dir) return `没有参考这个工作区的授权：${root}\n${rootsHint(src)}`;

  const memDirs = memoryDirs(src.configDir, dir);
  if (memDirs.length === 0) return `${dir} 还没有记忆。`;

  if (id === undefined) return listMemory(dir, memDirs);

  if (!ENTRY_ID.test(id) || id === "." || id === "..") {
    return `id 必须是记忆目录里的 .md 文件名（取自索引），收到：${id}`;
  }
  for (const m of memDirs) {
    const file = join(m, id);
    try {
      if (!(await stat(file)).isFile()) continue;
      const body = truncateBytes(await readFile(file, "utf8"));
      return `[${dir} 的记忆：${id}]\n${body}`;
    } catch {
      // 这个目录里没有，试下一个（同一工作区可能因编码版本分裂成多个 projects 目录）
    }
  }
  return `${dir} 的记忆里没有 ${id}。不带 id 调用可以看到现有条目。`;
}

async function listMemory(dir: string, memDirs: string[]): Promise<string> {
  let index = "";
  const names = new Set<string>();
  for (const m of memDirs) {
    try {
      for (const f of await readdir(m)) if (f.endsWith(".md") && f !== INDEX_FILE) names.add(f);
      if (!index) index = await readFile(join(m, INDEX_FILE), "utf8").catch(() => "");
    } catch {
      /* 目录读不了 = 当作没有 */
    }
  }
  const files = [...names].sort();
  return [
    `[${dir} 的记忆索引]`,
    index.trim() || "（没有 MEMORY.md 索引）",
    "",
    `条目文件（${files.length}）：`,
    files.length ? files.map((f) => `- ${f}`).join("\n") : "（无）",
  ].join("\n");
}

/** 注册条件：受限模式（!trusted）不挂；其余恒挂——工具列表跨会话稳定，
 *  中途 @ 目录后立即可用（query 全会话只 spawn 一次，事后挂不上）。 */
export function crossMemoryMcpRegistration(
  src: MemoryRootsSource,
  trusted = true,
): Record<string, unknown> | null {
  if (!trusted || !src.configDir) return null;
  const server = createSdkMcpServer({
    name: MEMORY_SERVER,
    version: "1.0.0",
    instructions: MEMORY_INSTRUCTIONS,
    tools: [
      tool(
        "read_memory",
        "Read the auto-memory of another workspace this session may consult. Without id: that workspace's memory index and entry file names. With id: one entry's full text.",
        {
          root: z.string().describe("The workspace directory, exactly as named in its 附加工作区指令 block"),
          id: z.string().optional().describe("Entry file name from the index, e.g. feedback-testing.md. Omit to list."),
        },
        async (args) => text(await readCrossMemory(src, args.root, args.id)),
      ),
    ],
  });
  return { [MEMORY_SERVER]: server };
}
