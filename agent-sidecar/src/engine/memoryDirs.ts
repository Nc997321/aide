// auto memory 的目录解析（原样从 extensions/builtinHooks/memoryEvents.ts 迁来）。
//
// 为什么在 engine 侧：engine/instructions.ts 要给附加工作区注入记忆索引，而它保持
// **零 extensions 依赖**——搬过来既复用又不多拉一条 engine → extensions 的边。
// extensions 侧（memoryEvents.ts）改为 re-export，真相源始终只有这一份；两边规则
// 都必须与 Rust 侧（commands/workspace 的 path_to_key、resolve_project_dirs）一致。

import { existsSync, readdirSync } from "node:fs";
import * as path from "node:path";

/** 与 Rust 侧 workspace::path_to_key 同规则：`: \ /` → `-`。 */
export function pathToKey(p: string): string {
  return p.replace(/[:\\/]/g, "-");
}

/** memory 目录解析：dot 归一匹配（对齐 Rust resolve_project_dirs 的分裂目录合并语义）。 */
export function memoryDirs(configDir: string, cwd: string): string[] {
  const projects = path.join(configDir, "projects");
  const key = pathToKey(cwd).replace(/\./g, "-");
  let entries: string[] = [];
  try {
    entries = readdirSync(projects);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.replace(/\./g, "-") === key)
    .map((e) => path.join(projects, e, "memory"))
    .filter((d) => existsSync(d));
}
