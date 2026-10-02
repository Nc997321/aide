#!/usr/bin/env node
//! `migrate-workspace.mjs` 的夹具自测：在临时目录里造一份**合成 Aide 数据根**，
//! 把 dry-run → apply → 校验 → restore → 校验 全流程跑一遍。
//!
//! 为什么必须有它：apply 与 restore 是这个脚本里**唯一会破坏数据**的路径，
//! 而真实使用场景（关掉 Aide 搬真项目）恰恰最难反复演练。夹具把这个循环变成
//! 秒级、可复跑、零风险的动作。
//!
//! 夹具刻意覆盖所有会让「朴素实现」静默出错的分支：
//!   · 路径**含点号** → 同一路径算出三种 key（注册表保留点号 / 信任键点号归一 /
//!     转录目录名全变横杠），三套变换都错就会静默失效
//!   · 磁盘上**孪生转录目录**（点号形态 + 横杠形态并存）
//!   · 两边都有 `MEMORY.md` → 冲突必须保留两份、绝不覆盖
//!   · jdtls 第三套编码（`:` `\` `/` → `_`）
//!   · `.claude.json` 的 projects 用**正斜杠**路径做键
//!   · automation 作用域根下的转录目录（`scopes/<kind>/<id>/claude/projects/`）
//!
//! 用法：node scripts/migrate-workspace.selftest.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrate-workspace.mjs");

let failures = 0;
const ok = (cond, label, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n        ${detail}` : ""}`);
  }
};
const eq = (a, b, label) => ok(a === b, label, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`);

const pathToKey = (p) => p.replace(/[:\\/]/g, "-");
const trustKeyOf = (p) => pathToKey(p).replace(/\./g, "-");
const sdkDirName = (p) => p.replace(/[^A-Za-z0-9]/g, "-");
const lspKeyOf = (p) => p.replace(/[:\\/]/g, "_");
const slashPath = (p) => p.replace(/\\/g, "/");
const renderJson = (v) => JSON.stringify(v, null, 2);

/** 目录树快照：相对路径 → 内容哈希（用于 restore 后判定「真的回去了」）。 */
function snapshot(dir, base = dir, out = {}) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    const rel = path.relative(base, f);
    if (e.isDirectory()) snapshot(f, base, out);
    else if (e.isFile()) out[rel] = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  }
  return out;
}

function run(args, aideHome) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      env: { ...process.env, AIDE_HOME: aideHome, AIDE_MIGRATE_TEST: "1" },
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

// ─────────────────────────── 造夹具 ───────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aide-migrate-selftest-"));
const AIDE = path.join(TMP, "aidehome");
const OLD = path.join(TMP, "proj", "my.app"); // 带点号
const NEW = path.join(TMP, "moved", "new.app"); // 也带点号
const OTHER = path.join(TMP, "proj", "other");

const OLD_KEY = pathToKey(OLD);
const NEW_KEY = pathToKey(NEW);
const OLD_TRUST = trustKeyOf(OLD);
const NEW_TRUST = trustKeyOf(NEW);
const OLD_SDK = sdkDirName(OLD);
const NEW_SDK = sdkDirName(NEW);
const OLD_LSP = lspKeyOf(OLD);
const NEW_LSP = lspKeyOf(NEW);

const w = (p, content) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

fs.mkdirSync(OLD, { recursive: true });
fs.mkdirSync(OTHER, { recursive: true });
w(path.join(OLD, "README.md"), "hello\n");

// state.json：两套 key 形态 + 活动工作区 + 黑名单 + lsp/jdk
w(
  path.join(AIDE, "state.json"),
  renderJson({
    claudeMigrationDone: true,
    registeredWorkspacesMigrated: true,
    registeredWorkspaces: [
      { key: OLD_KEY, path: OLD, addedAt: 1 },
      { key: pathToKey(OTHER), path: OTHER, addedAt: 2 },
    ],
    workspace: OLD_KEY,
    hiddenWorkspaces: [OLD_KEY],
    trustedWorkspaces: [OLD_TRUST, "untouched-key"],
    lsp_workspaces: { [OLD_KEY]: { enabled: true, exclude_dirs: ["build"] } },
    workspace_jdks: { [OLD_KEY]: "C:\\jdk21" },
  })
);

w(
  path.join(AIDE, "settings.json"),
  renderJson({
    permissions: { rules: [] },
    schemaVersion: 1,
    values: {
      workspace: OLD_KEY,
      settings: {
        paneLayouts: {
          __global__: {
            root: { children: [{ active: 0, tabs: [{ name: "t", wsKey: OLD_KEY, wsPath: OLD }] }] },
          },
        },
        jdkPromptDismissed: [OLD, OTHER],
      },
    },
  })
);

w(
  path.join(AIDE, "recent.json"),
  renderJson({
    sessions: [{ ws_key: OLD_KEY, ws_name: OLD, session_id: "s1", name: "n", ts: 1 }],
    files: { [OLD_KEY]: [{ path: path.join(OLD, "README.md"), name: "README.md", ts: 1 }] },
  })
);

w(
  path.join(AIDE, "run_configs", `${pathToKey(OLD)}.json`),
  renderJson([{ id: "r1", name: "run", cwd: OLD, command: "ls", env: {} }])
);

w(path.join(AIDE, "observatory", "snapshots", `${OLD_KEY}.jsonl`), '{"ts":1,"files":[]}\n');
w(
  path.join(AIDE, "observatory", "events.jsonl"),
  `${JSON.stringify({ ts: 1, session_id: "s1", workspace_key: OLD_KEY, op: "read", memory_id: "a.md" })}\n`
);

// 转录：横杠形态（有内容）+ 点号形态孪生（有内容、且 MEMORY.md 冲突）
const TX = path.join(AIDE, "claude", "projects");
w(path.join(TX, OLD_SDK, "s1.jsonl"), '{"type":"user"}\n');
w(path.join(TX, OLD_SDK, "memory", "topic.md"), "topic from dash\n");
w(path.join(TX, OLD_SDK, "memory", "MEMORY.md"), "MEMORY from dash\n");
if (OLD_SDK !== OLD_KEY) {
  w(path.join(TX, OLD_KEY, "s2.jsonl"), '{"type":"user"}\n');
  w(path.join(TX, OLD_KEY, "memory", "MEMORY.md"), "MEMORY from dot\n");
}
// automation 作用域根下的转录（目录名同样是 cwd 编码）
w(path.join(AIDE, "scopes", "automation", "aut-1", "claude", "projects", OLD_SDK, "s3.jsonl"), '{"type":"user"}\n');

w(
  path.join(AIDE, "claude", ".claude.json"),
  renderJson({
    userID: "u1",
    projects: { [slashPath(OLD)]: { hasTrustDialogAccepted: true, allowedTools: ["Read"] } },
  })
);

w(path.join(AIDE, "lsp", "jdtls-workspace", OLD_LSP, "index.bin"), "jdt index\n");
w(path.join(AIDE, "automations", "aut-1", "task.json"), renderJson({ id: "aut-1", workspacePath: OLD }));

const before = snapshot(AIDE);
const beforeProject = snapshot(OLD);

console.log(`夹具：${TMP}`);
console.log(`  旧键 ${OLD_KEY}\n  新键 ${NEW_KEY}\n  旧转录目录名 ${OLD_SDK} → 新 ${NEW_SDK}\n`);

// ─────────────────────────── 1. dry-run ───────────────────────────

console.log("── 1. dry-run（只读）──");
const dry = run([OLD, NEW], AIDE);
eq(dry.code, 0, "dry-run 退出码 0");
ok(dry.stdout.includes(OLD_KEY) && dry.stdout.includes(NEW_KEY), "计划里印出新旧 key");
ok(dry.stdout.includes("未改动任何数据"), "明确声明未改动数据");
eq(JSON.stringify(snapshot(AIDE)), JSON.stringify(before), "dry-run 后夹具**零改动**");

// ─────────────────────────── 2. apply ───────────────────────────

console.log("\n── 2. apply ──");
const ap = run([OLD, NEW, "--apply"], AIDE);
eq(ap.code, 0, "apply 退出码 0");

const rd = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const st = rd(path.join(AIDE, "state.json"));

ok(fs.existsSync(path.join(NEW, "README.md")), "项目目录已搬到新位置");
ok(!fs.existsSync(OLD), "旧目录已不存在（跨盘回落路径未触发，同盘 rename）");

const reg = st.registeredWorkspaces.find((x) => x.key === NEW_KEY);
ok(!!reg, "注册表已换新 key");
eq(reg && reg.path, NEW, "注册表 path 指向新位置");
eq(st.workspace, NEW_KEY, "活动工作区已换新 key");
eq(st.hiddenWorkspaces[0], NEW_KEY, "hiddenWorkspaces（点号形态）");
ok(st.trustedWorkspaces.includes(NEW_TRUST), "trustedWorkspaces（**点号归一形态**）");
ok(!st.trustedWorkspaces.includes(OLD_TRUST), "旧信任键已移除");
ok(st.trustedWorkspaces.includes("untouched-key"), "无关条目未被误伤");
ok(st.lsp_workspaces[NEW_KEY] && st.lsp_workspaces[NEW_KEY].exclude_dirs[0] === "build", "lsp_workspaces 已换 key（值保留）");
ok(!st.lsp_workspaces[OLD_KEY], "旧 lsp key 已移除");
eq(st.workspace_jdks[NEW_KEY], "C:\\jdk21", "workspace_jdks 已换 key");

const se = rd(path.join(AIDE, "settings.json"));
eq(se.values.workspace, NEW_KEY, "values.workspace");
const tab = se.values.settings.paneLayouts.__global__.root.children[0].tabs[0];
eq(tab.wsKey, NEW_KEY, "布局 tab 的 wsKey");
eq(tab.wsPath, NEW, "布局 tab 的 wsPath");
eq(se.values.settings.jdkPromptDismissed[0], NEW, "jdkPromptDismissed（存的是**绝对路径**）");
eq(se.values.settings.jdkPromptDismissed[1], OTHER, "jdkPromptDismissed 无关项未误伤");

const rc = rd(path.join(AIDE, "recent.json"));
eq(rc.sessions[0].ws_key, NEW_KEY, "recent sessions[].ws_key");
eq(rc.sessions[0].ws_name, NEW, "recent sessions[].ws_name");
ok(rc.files[NEW_KEY] && !rc.files[OLD_KEY], "recent files 的 map 键");
eq(rc.files[NEW_KEY]?.[0]?.path, path.join(NEW, "README.md"), "recent files[].path 前缀改写");

const runCfgPath = path.join(AIDE, "run_configs", `${NEW_KEY}.json`);
ok(fs.existsSync(runCfgPath), "run_configs 文件已改名");
eq(rd(runCfgPath)[0].cwd, NEW, "run_configs 内部 cwd");
ok(!fs.existsSync(path.join(AIDE, "run_configs", `${OLD_KEY}.json`)), "旧 run_configs 文件已不存在");

ok(fs.existsSync(path.join(AIDE, "observatory", "snapshots", `${NEW_KEY}.jsonl`)), "快照已改名");
const ev = fs.readFileSync(path.join(AIDE, "observatory", "events.jsonl"), "utf8").trim();
eq(JSON.parse(ev).workspace_key, NEW_KEY, "events 行内 workspace_key");

const cj = rd(path.join(AIDE, "claude", ".claude.json"));
ok(!!cj.projects[slashPath(NEW)], ".claude.json projects 已换键（正斜杠形态）");
ok(!cj.projects[slashPath(OLD)], "旧 projects 键已移除");
eq(cj.projects[slashPath(NEW)]?.hasTrustDialogAccepted, true, "**hasTrustDialogAccepted 保留**（信任框不重弹）");
eq(cj.projects[slashPath(NEW)]?.allowedTools?.[0], "Read", "allowedTools 保留");

ok(fs.existsSync(path.join(AIDE, "lsp", "jdtls-workspace", NEW_LSP, "index.bin")), "jdtls 工作区目录已改名（第三套编码）");
ok(!fs.existsSync(path.join(AIDE, "lsp", "jdtls-workspace", OLD_LSP)), "旧 jdtls 目录已不存在");

eq(rd(path.join(AIDE, "automations", "aut-1", "task.json")).workspacePath, NEW, "automation task.json 的 workspacePath");

// 转录目录：孪生合并 + 冲突保留
const newTx = path.join(TX, NEW_SDK);
ok(fs.existsSync(newTx), "新转录目录已建立");
const txFiles = fs.readdirSync(newTx).sort();
ok(txFiles.includes("s1.jsonl"), "横杠形态的会话转录已就位");
ok(txFiles.includes("s2.jsonl"), "**点号形态孪生目录的转录已并入**（无丢失）");
ok(fs.existsSync(path.join(newTx, "memory", "topic.md")), "memory/topic.md 已就位");
ok(fs.existsSync(path.join(newTx, "memory", "MEMORY.md")), "MEMORY.md 已就位");
const memDup = fs.readdirSync(path.join(newTx, "memory")).filter((f) => f.startsWith("MEMORY.md.from-"));
eq(memDup.length, 1, "**MEMORY.md 冲突保留第二份**（绝不覆盖）");
ok(
  fs.readFileSync(path.join(newTx, "memory", "MEMORY.md"), "utf8").includes("from dash"),
  "MEMORY.md 主份内容未被覆盖"
);
ok(!fs.existsSync(path.join(TX, OLD_KEY)), "旧点号形态目录已收走");
ok(
  fs.existsSync(path.join(AIDE, "scopes", "automation", "aut-1", "claude", "projects", NEW_SDK, "s3.jsonl")),
  "automation 作用域根下的转录也已改名（易漏点）"
);

ok(ap.stdout.includes("✓ 旧 key / 旧路径无残留"), "apply 末尾自检报告无残留");

// ─────────────────────────── 3. restore ───────────────────────────

console.log("\n── 3. restore ──");
const backupDir = fs
  .readdirSync(AIDE)
  .filter((n) => n.startsWith("backup-workspace-migration-"))
  .map((n) => path.join(AIDE, n))[0];
ok(!!backupDir, "备份目录已生成");
const rs = run(["--restore", backupDir], AIDE);
eq(rs.code, 0, "restore 退出码 0");

ok(fs.existsSync(OLD), "项目目录已搬回");
ok(!fs.existsSync(NEW), "新位置已不存在");

// 逐文件比对：除了 MEMORY.md 冲突产生的那一份副件，其余应逐字节回到原样
const after = snapshot(AIDE);
const backupRel = path.relative(AIDE, backupDir);
const diffs = [];
for (const rel of Object.keys(before)) {
  if (after[rel] !== before[rel]) diffs.push(rel);
}
for (const rel of Object.keys(after)) {
  if (rel.startsWith(backupRel)) continue; // 备份目录本身是新产物
  if (!(rel in before)) diffs.push(`(多出) ${rel}`);
}
const expectKept = (rel) => rel.includes("MEMORY.md.from-");
const realDiffs = diffs.filter((d) => !expectKept(d));
ok(realDiffs.length === 0, "**逐文件比对：全部还原**（除设计上保留的 MEMORY.md 副件）", realDiffs.slice(0, 8).join("\n        "));
ok(
  JSON.stringify(snapshot(OLD)) === JSON.stringify(beforeProject),
  "项目目录内容逐字节一致"
);
ok(fs.existsSync(backupDir), "备份目录保留（供你复核后再手删）");

// ─────────────────────────── 汇总 ───────────────────────────

console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
console.log(`夹具留在：${TMP}${failures === 0 ? "（可自行删除）" : ""}`);
process.exit(failures === 0 ? 0 : 1);
