import type { ChangeFile } from "../types";

/** 变更树节点：目录或文件（携带原始 ChangeFile）。 */
export type ChangeTreeNode =
  | {
      kind: "dir";
      /** 显示名：单链合并后的路径段（如 "src/composables"） */
      name: string;
      /** 目录路径（相对仓库根，正斜杠）——折叠状态的 key */
      path: string;
      children: ChangeTreeNode[];
    }
  | {
      kind: "file";
      /** 文件名（不含路径） */
      name: string;
      /** 原始变更条目（path 为仓库根相对路径，撤回/打开用原始值） */
      file: ChangeFile;
    };

interface DirNode {
  name: string;
  path: string;
  dirs: Map<string, DirNode>;
  files: ChangeFile[];
}

function fileName(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

/** 目录节点：单链目录自动合并（只有一个子目录且无直属文件 → 并成一段路径显示），
 *  有分叉才展开层级。path 取合并链末端（折叠 key 跟随最深目录）。 */
function compactDir(dir: DirNode): ChangeTreeNode {
  let cur = dir;
  let name = cur.name;
  while (cur.dirs.size === 1 && cur.files.length === 0) {
    cur = [...cur.dirs.values()][0];
    name = `${name}/${cur.name}`;
  }
  return { kind: "dir", name, path: cur.path, children: childrenOf(cur) };
}

/** 子节点列表：目录在前、文件在后，各自按名排序。 */
function childrenOf(dir: DirNode): ChangeTreeNode[] {
  const out: ChangeTreeNode[] = [];
  const dirNames = [...dir.dirs.keys()].sort((a, b) => a.localeCompare(b));
  for (const n of dirNames) out.push(compactDir(dir.dirs.get(n)!));
  const files = [...dir.files].sort((a, b) => fileName(a.path).localeCompare(fileName(b.path)));
  for (const f of files) out.push({ kind: "file", name: fileName(f.path), file: f });
  return out;
}

/** 从 git diff 文件列表（轮次 files）构建变更树：
 *  - 路径按 "/"（兼容 "\"）逐层建目录
 *  - 单链目录自动合并，窄面板省纵向空间
 *  - 排序：目录在前文件在后，各自按名排序 */
export function buildChangeTree(files: ChangeFile[]): ChangeTreeNode[] {
  const root: DirNode = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = dir.dirs.get(parts[i]);
      if (!next) {
        next = { name: parts[i], path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] };
        dir.dirs.set(parts[i], next);
      }
      dir = next;
    }
    dir.files.push(f);
  }
  return childrenOf(root);
}
