/**
 * `file-tree-changed` 事件的相关性裁决（纯函数，Node 环境可测）。
 *
 * 后端 payload 是受影响父目录的集合（空数组 = 全量刷新）。文件树只展示
 * 「已展开目录」范围内的路径——watcher 是递归的，不可见区域（如未展开的
 * node_modules）里的事件与当前视图无关，必须忽略，否则 npm install 风暴
 * 会退化成每两秒一轮全树重载。
 *
 * 裁决按树可见性推导（目录 D 的内容何时可见）：
 * - D = root → 全量刷新（root 直属子节点整体替换）。
 * - D ∈ 已展开 → D 的子列表正展示着，刷新 D 本身。
 * - D 未展开但 parent(D) ∈ 已展开 → D 自己（或 D 下新出现的条目）要从
 *   parent 的重新列目录里冒出来，刷新 parent。
 * - 其余（改动落在完全折叠的区域）→ 忽略：用户展开该目录时会重新
 *   loadChildren，数据自然新鲜；对不可见区域的刷新纯属浪费。
 *
 * 归一化与 revealFile 同源：路径分隔符统一按 root 的风格，Windows 大小写
 * 不敏感——比较前先小写化（lowercase 只做比较键；返回值用 expandedDirs 里
 * 的原始路径，保证与树节点 path 逐字节一致，findNode 靠全等匹配）。
 */
export interface WatchRefreshPlan {
  /** true = 走 refreshAllExpanded（payload 空或 root 直接受影响） */
  full: boolean;
  /** 需要原地刷新的具体目录（原始大小写，可直接喂给 refreshDir） */
  dirs: string[];
}

/** 按 root 分隔符归一路径并小写化（比较键） */
function norm(path: string, sep: string): string {
  return path.replace(/[\\/]/g, sep).toLowerCase();
}

function parentOf(path: string, sep: string): string {
  const i = path.lastIndexOf(sep);
  return i > 0 ? path.slice(0, i) : path;
}

export function planWatchRefresh(dirs: string[], root: string, expandedDirs: string[]): WatchRefreshPlan {
  const sep = root.includes("\\") ? "\\" : "/";
  if (dirs.length === 0) return { full: true, dirs: [] };

  const normRoot = norm(root, sep);
  const normalized = expandedDirs.map((raw) => ({ raw, norm: norm(raw, sep) }));

  const plan = new Set<string>();
  for (const dir of dirs) {
    const d = norm(dir, sep);
    // 跨根噪音：watcher 重定目标前收尾的旧工作区事件
    if (!d.startsWith(normRoot)) continue;
    if (d === normRoot) return { full: true, dirs: [] };
    const self = normalized.find((e) => e.norm === d);
    if (self) {
      plan.add(self.raw);
      continue;
    }
    const parent = normalized.find((e) => e.norm === parentOf(d, sep));
    if (parent) plan.add(parent.raw);
  }
  return { full: false, dirs: [...plan] };
}