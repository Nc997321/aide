#!/usr/bin/env node
//! 工作区目录迁移：把一个项目目录搬到新位置，并让 Aide 的「记忆 / 会话 / 设置」跟着走。
//!
//! 为什么需要它：Aide 里**工作区身份 = 工作目录路径的纯函数**。路径一变，所有按 key
//! 落盘的派生数据全部找不到家，而且**失败模式是静默的**——key 对不上时 claude.exe 不
//! 报错，直接开一个空白会话（实测）。用户的体感是「记忆全没了」。
//!
//! 脚本必须在 **Aide 关闭时**运行，三条理由：
//!   1. `~/.aide/claude/sessions/<pid>.json` 的 cwd 字段是 claude.exe 写的，本脚本改不了；
//!   2. `state.json` 由 app 持有，开着跑会被它整份覆盖回去；
//!   3. claude.exe 正在写 `projects/` 时不能搬动那些目录。
//!
//! ── 关键机制（决定了下面的代码为什么这么写）────────────────────────────────
//!
//! **同一条路径会算出三种 key**，必须逐段用对应变换，用错就是静默失效：
//!   A. `pathToKey`（`: \ /` → `-`，**保留点号**）——state.json 的 `registeredWorkspaces[].key`
//!      / `workspace` / `hiddenWorkspaces` / `lsp_workspaces` / `workspace_jdks`；
//!      `recent.json` 的 `ws_key` 与 `files` 的 map 键；observatory 的 `events.jsonl`
//!      （sidecar hook 用同规则写）；run_configs 文件名与快照文件名（走 key_to_path）。
//!   B. `trustKeyOf`（A 再点号归一）——`trustedWorkspaces`。
//!   C. `sdkDirName`（realpath 后**所有非字母数字** → `-`）——磁盘上 `projects/<名>/` 的
//!      真实目录名，由 claude.exe 决定。超过 200 字符时它会截断并掺路径哈希，**不可反推**
//!      → 本脚本硬拒绝这种路径。
//!
//! **老 key 必须从注册表读，不能重算**：`registeredWorkspaces[].key` 是冻结值（先登记者
//! 拥有该工作区），重算会在孪生名等边界上与历史不一致。
//!
//! **磁盘上同一工作区可能有两个孪生目录**（`chennong4.0` 与 `chennong4-0`），读侧靠点号
//! 归一合并（Rust `resolve_project_dirs`）。本脚本按同一语义把孪生目录**收成一个**，
//! 顺带修掉既有的分裂。
//!
//! ── 用法 ────────────────────────────────────────────────────────────────
//!   node scripts/migrate-workspace.mjs <旧目录> <新目录>          # 只打印计划（默认）
//!   node scripts/migrate-workspace.mjs <旧目录> <新目录> --apply  # 备份后执行
//!   node scripts/migrate-workspace.mjs --restore <备份目录>       # 按备份回滚
//!
//! 幂等性：执行失败会停在失败点并在报告里给出回滚命令；JSON 改写前全部已备份。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// ─────────────────────────── 路径与 key 规则 ───────────────────────────

/**
 * Aide 数据根。默认 `~/.aide`（与 Rust `our_config_dir()` 一致）；
 * `AIDE_HOME` 仅用于**测试夹具**——真实使用永远不要设它。
 */
const AIDE_DIR = process.env.AIDE_HOME ? path.resolve(process.env.AIDE_HOME) : path.join(os.homedir(), ".aide");

/**
 * 测试钩子：显式跳过「Aide 未运行」这道门。真实使用**永远不要设**——开着 Aide 跑
 * --apply 会被 app 把 state.json 覆盖回去。门默认恒开。
 */
const TEST_SKIP_RUNNING_GATE = process.env.AIDE_MIGRATE_TEST === "1";

/** A：与 Rust `workspace::path_to_key` 同规则（保留点号）。 */
const pathToKey = (p) => p.replace(/[:\\/]/g, "-");

/** B：与 Rust `workspace::trust_key_from_path` 同规则（点号归一成横杠）。 */
const trustKeyOf = (p) => pathToKey(p).replace(/\./g, "-");

/** C：与内嵌 SDK / claude.exe 同规则（realpath 后所有非 [A-Za-z0-9] → `-`）。 */
const sdkDirName = (p) => p.replace(/[^A-Za-z0-9]/g, "-");

/**
 * D：jdtls data 目录名——与 Rust `lsp::profiles::java::JavaProfile::data_dir_path`
 * 同规则（`:` `\` `/` → `_`，保留点号）。第三套编码，只此一处。
 */
const lspKeyOf = (p) => p.replace(/[:\\/]/g, "_");

/** claude.exe 在 `.claude.json` 的 `projects` 里用**正斜杠**绝对路径做键。 */
const slashPath = (p) => p.replace(/\\/g, "/");

/** claude.exe 的截断阈值；超过它目录名会掺路径哈希，无法反推。 */
const SDK_TRUNCATE_LIMIT = 200;

/**
 * 把路径规范成「claude.exe 将会看到的样子」——父目录 realpath + 原 basename。
 * 目标目录此时还不存在，所以只能 realpath 父目录（realpath 会改大小写、展开 junction，
 * 这正是 claude.exe 会做的事）。
 */
function canonicalize(p) {
  const abs = path.resolve(p);
  let parent;
  try {
    parent = fs.realpathSync.native(path.dirname(abs));
  } catch {
    parent = path.dirname(abs);
  }
  return path.join(parent, path.basename(abs));
}

/** 比较用的归一：Windows 大小写不敏感 + 容忍尾分隔符。 */
function samePath(a, b) {
  const n = (s) => path.resolve(s).replace(/[\\/]+$/, "").toLowerCase();
  return n(a) === n(b);
}

/** b 是否在 a 之内（含相等）。 */
function isInside(child, parent) {
  const c = path.resolve(child).replace(/[\\/]+$/, "").toLowerCase();
  const p = path.resolve(parent).replace(/[\\/]+$/, "").toLowerCase();
  return c === p || c.startsWith(p + path.sep) || c.startsWith(p + "/");
}

// ─────────────────────────── 小工具 ───────────────────────────

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
/** 与 app 落盘格式一致：serde_json::to_string_pretty = 2 空格缩进、无尾换行。 */
const renderJson = (v) => JSON.stringify(v, null, 2);

function listDir(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Aide 是否在运行。跨平台：Windows 走 tasklist，其余走 ps。 */
function aideProcesses() {
  const wanted = ["aide.exe", "aide-agent.exe"];
  let out = "";
  try {
    if (process.platform === "win32") {
      out = execFileSync("tasklist", ["/FO", "CSV", "/NH"], {
        encoding: "utf8",
        windowsHide: true,
      });
    } else {
      out = execFileSync("ps", ["-A", "-o", "comm="], {
        encoding: "utf8",
      });
    }
  } catch {
    return []; // 查不到就当没跑（不因为探测失败阻断）
  }
  const lower = out.toLowerCase();
  return wanted.filter((n) => lower.includes(n));
}

// ─────────────────────────── 前置校验 ───────────────────────────

/**
 * 全部前置条件。返回 `{ fatal, warn }`——fatal 非空则不生成计划。
 * 设计原则 fail closed：拿不准就拒绝并说明，绝不在信息不全时改动磁盘。
 */
function preflight(oldArg, newArg, { forApply }) {
  const fatal = [];
  const warn = [];
  let hint = "";

  const oldDir = canonicalize(oldArg);
  const newDir = canonicalize(newArg);

  const running = aideProcesses();
  if (running.length > 0) {
    const msg = `Aide 正在运行（${running.join(", ")}）。`;
    if (TEST_SKIP_RUNNING_GATE) {
      warn.push(`[测试钩子已生效] 跳过「Aide 未运行」这道门：${msg}`);
    } else if (forApply) {
      fatal.push(msg + " 必须先完全退出 Aide 再 --apply（state.json 会被 app 覆盖回去）。");
    } else {
      warn.push(msg + " dry-run 只读无妨，但 --apply 前必须关掉。");
    }
  }

  if (!fs.existsSync(oldDir)) fatal.push(`旧目录不存在：${oldDir}`);
  else if (!fs.statSync(oldDir).isDirectory()) fatal.push(`旧目录不是目录：${oldDir}`);

  if (fs.existsSync(newDir)) {
    const entries = listDir(newDir);
    if (entries.length > 0) fatal.push(`新目录已存在且非空：${newDir}`);
    else warn.push(`新目录已存在（空目录），会直接用它：${newDir}`);
  }

  if (samePath(oldDir, newDir)) fatal.push("新旧目录是同一个。");
  else if (isInside(oldDir, newDir) || isInside(newDir, oldDir)) {
    fatal.push("新旧目录存在嵌套关系（互为祖先/后代），拒绝执行。");
  }

  const root = path.parse(newDir).root;
  if (root && !fs.existsSync(root)) fatal.push(`目标盘不存在：${root}`);

  const newSdkName = sdkDirName(newDir);
  if (newSdkName.length > SDK_TRUNCATE_LIMIT) {
    fatal.push(
      `新路径编码后长度 ${newSdkName.length} > ${SDK_TRUNCATE_LIMIT}，` +
        "claude.exe 会截断并掺入路径哈希，脚本无法复现目标目录名。换一个短一些的目标路径。"
    );
  }

  // 占用预检：宁可在备份之前就拒绝，也不要等搬到一半才撞 EPERM。
  if (fs.existsSync(oldDir) && fs.statSync(oldDir).isDirectory() && dirLocked(oldDir)) {
    const locked = lockedSubdirs(oldDir);
    fatal.push(
      "旧目录当前被占用，无法 rename（Windows 文件锁）。" +
        (locked.length ? `被占用的子目录：${locked.join(", ")}` : "")
    );
    hint = LOCK_HINT(oldDir);
  }

  return { oldDir, newDir, newSdkName, fatal, warn, hint };
}

// ─────────────────────────── 计划构建 ───────────────────────────

const STATE_FILE = path.join(AIDE_DIR, "state.json");
const SETTINGS_FILE = path.join(AIDE_DIR, "settings.json");
const RECENT_FILE = path.join(AIDE_DIR, "recent.json");
const SNAPSHOTS_DIR = path.join(AIDE_DIR, "observatory", "snapshots");
const EVENTS_FILE = path.join(AIDE_DIR, "observatory", "events.jsonl");
const RUN_CONFIGS_DIR = path.join(AIDE_DIR, "run_configs");
const AUTOMATIONS_DIR = path.join(AIDE_DIR, "automations");
const SCOPES_DIR = path.join(AIDE_DIR, "scopes");
const JDTLS_DIR = path.join(AIDE_DIR, "lsp", "jdtls-workspace");
const CLAUDE_JSON = path.join(AIDE_DIR, "claude", ".claude.json");

/** 所有可能承载 `projects/<cwd 编码>/` 的 config root：全局根 + 每个 automation 作用域根。 */
function transcriptRoots() {
  const roots = [path.join(AIDE_DIR, "claude", "projects")];
  for (const kind of listDir(SCOPES_DIR)) {
    if (!kind.isDirectory()) continue;
    for (const id of listDir(path.join(SCOPES_DIR, kind.name))) {
      if (!id.isDirectory()) continue;
      roots.push(path.join(SCOPES_DIR, kind.name, id.name, "claude", "projects"));
    }
  }
  return roots;
}

const plan = {
  ts: 0,
  oldDir: "",
  newDir: "",
  oldKey: "",
  newKey: "",
  oldTrust: "",
  newTrust: "",
  newSdkName: "",
  oldKeySource: "",
  dirOps: [], // 执行用（逐文件，便于精确回滚）：moveProject|mergeFile|mkdir|rmdir|renameDir|renameFile
  dirSummary: [], // 呈现用（按目录汇总，避免上千行输出）
  jsonEdits: [], // { file, before, after, changes: [] }
  warnings: [],
  notes: [],
};

function buildPlan(pf) {
  plan.ts = Date.now();
  plan.oldDir = pf.oldDir;
  plan.newDir = pf.newDir;
  plan.newSdkName = pf.newSdkName;

  // ── 老 key：优先注册表冻结值 ──
  const stateFile = fs.existsSync(STATE_FILE) ? readJson(STATE_FILE) : {};
  const registered = Array.isArray(stateFile.registeredWorkspaces) ? stateFile.registeredWorkspaces : [];
  const entry = registered.find((w) => w && samePath(String(w.path || ""), pf.oldDir));
  if (entry && entry.key) {
    plan.oldKey = String(entry.key);
    plan.oldKeySource = "注册表（冻结值）";
  } else {
    plan.oldKey = pathToKey(pf.oldDir);
    plan.oldKeySource = "现算（该路径未在注册表中，可能是历史残留）";
    plan.warnings.push(
      `旧路径不在 registeredWorkspaces 中，key 由 path_to_key 现算为 ${plan.oldKey}。` +
        "若该工作区此前有数据，请先确认这个 key 与磁盘上的 projects/ 目录名一致。"
    );
  }
  plan.newKey = pathToKey(pf.newDir);
  plan.oldTrust = trustKeyOf(pf.oldDir);
  plan.newTrust = trustKeyOf(pf.newDir);

  if (plan.oldKey === plan.newKey) {
    pf.fatal.push("新旧路径算出的 key 相同，无需迁移。");
    return plan;
  }

  // ── 1. 项目目录本体 ──
  plan.dirOps.push({ kind: "moveProject", from: pf.oldDir, to: pf.newDir });

  // ── 2. 转录目录：点号归一匹配（含孪生），收成一个 ──
  const normOld = plan.oldKey.replace(/\./g, "-");
  const sources = [];
  for (const root of transcriptRoots()) {
    for (const e of listDir(root)) {
      if (!e.isDirectory()) continue;
      if (e.name.replace(/\./g, "-") !== normOld) continue;
      sources.push(path.join(root, e.name));
    }
  }
  const sdkTarget = (root) => path.join(root, plan.newSdkName);
  const pending = sources
    .map((src) => ({ src, to: sdkTarget(path.dirname(src)) }))
    .filter(({ src, to }) => !samePath(src, to));

  // 单源且目标不存在 → 整目录 rename（快，且回滚只需反向 rename）。
  // 多源（孪生目录）才需要逐文件合并，因为要处理同名冲突。
  const sole = pending.length === 1 && !fs.existsSync(pending[0].to);
  const claimed = new Set(); // 本批已计划占用的目标路径（见 expandMerge 的冲突判定）
  for (const { src, to } of pending) {
    if (sole) {
      plan.dirOps.push({ kind: "renameDir", from: src, to });
      plan.dirSummary.push({ from: src, to, ...treeStats(src), mode: "整目录改名" });
    } else {
      const g = expandMerge(src, to, plan.dirOps, plan.warnings, claimed);
      plan.dirSummary.push({ from: src, to, ...g, mode: "逐文件合并" });
    }
  }
  if (pending.length > 1) {
    plan.notes.push(
      `该工作区在磁盘上有 ${pending.length} 个孪生转录目录（点号形态 / 横杠形态并存），本次合并为一个。` +
        "这是既有分裂的顺带修复，读侧本来就靠点号归一合并它们。"
    );
  }

  // ── 2b. jdtls 工作区数据目录（第三套编码；丢了 = Java 索引全废、冷启动重来）──
  {
    const wantOld = lspKeyOf(pf.oldDir);
    for (const e of listDir(JDTLS_DIR)) {
      if (!e.isDirectory()) continue;
      if (e.name.replace(/\./g, "-") !== wantOld.replace(/\./g, "-")) continue;
      const from = path.join(JDTLS_DIR, e.name);
      const to = path.join(JDTLS_DIR, lspKeyOf(pf.newDir));
      if (samePath(from, to)) continue;
      plan.dirOps.push({ kind: "renameDir", from, to });
      plan.dirSummary.push({ from, to, ...treeStats(from), mode: "jdtls 工作区改名" });
    }
  }

  // ── 3. state.json ──
  if (fs.existsSync(STATE_FILE)) {
    const before = fs.readFileSync(STATE_FILE, "utf8");
    const st = JSON.parse(before);
    const changes = [];

    // 3a. 注册表：key 换新 + path 改指向（path 是身份的主人，必须一起改）
    const re = (st.registeredWorkspaces || []).find((w) => w && w.key === plan.oldKey);
    if (re) {
      const clash = (st.registeredWorkspaces || []).find((w) => w && w.key === plan.newKey && w !== re);
      if (clash) pf.fatal.push(`注册表里已存在 key=${plan.newKey} 的条目，拒绝覆盖。`);
      else {
        re.key = plan.newKey;
        re.path = pf.newDir;
        changes.push(`registeredWorkspaces: key/path → ${plan.newKey}`);
      }
    }

    // 3b. 活动工作区
    if (st.workspace === plan.oldKey) {
      st.workspace = plan.newKey;
      changes.push("workspace（活动）");
    }
    // 3c. 黑名单（点号形态）
    if (Array.isArray(st.hiddenWorkspaces) && st.hiddenWorkspaces.includes(plan.oldKey)) {
      st.hiddenWorkspaces = st.hiddenWorkspaces.map((k) => (k === plan.oldKey ? plan.newKey : k));
      changes.push("hiddenWorkspaces");
    }
    // 3d. 信任白名单（点号归一形态）
    if (Array.isArray(st.trustedWorkspaces) && st.trustedWorkspaces.includes(plan.oldTrust)) {
      st.trustedWorkspaces = [...new Set(st.trustedWorkspaces.map((k) => (k === plan.oldTrust ? plan.newTrust : k)))];
      changes.push("trustedWorkspaces");
    }
    // 3e. lsp / jdk（点号形态）
    for (const [sec, from, to] of [
      ["lsp_workspaces", plan.oldKey, plan.newKey],
      ["workspace_jdks", plan.oldKey, plan.newKey],
    ]) {
      const obj = st[sec];
      if (!obj || typeof obj !== "object" || !Object.prototype.hasOwnProperty.call(obj, from)) continue;
      if (Object.prototype.hasOwnProperty.call(obj, to)) {
        pf.fatal.push(`${sec} 里已存在 key=${to} 的条目，拒绝覆盖（人工合并后再跑）。`);
        continue;
      }
      obj[to] = obj[from];
      delete obj[from];
      changes.push(sec);
    }

    const after = renderJson(st);
    if (after !== before) plan.jsonEdits.push({ file: STATE_FILE, before, after, changes });
  } else {
    plan.warnings.push(`未找到 ${STATE_FILE}（新装或未初始化），跳过。`);
  }

  // ── 4. settings.json ──
  if (fs.existsSync(SETTINGS_FILE)) {
    const before = fs.readFileSync(SETTINGS_FILE, "utf8");
    const se = JSON.parse(before);
    const changes = [];
    const v = se.values && typeof se.values === "object" ? se.values : null;
    if (v) {
      if (v.workspace === plan.oldKey) {
        v.workspace = plan.newKey;
        changes.push("values.workspace");
      }
      // 布局快照：paneLayouts 是嵌套标签树，通用遍历任何 wsKey/wsPath 命名槽位
      const walk = (o) => {
        let n = 0;
        if (Array.isArray(o)) for (const x of o) n += walk(x);
        else if (o && typeof o === "object") {
          for (const [k, val] of Object.entries(o)) {
            if (typeof val === "string") {
              if ((k === "wsKey" || k === "ws_key") && val === plan.oldKey) {
                o[k] = plan.newKey;
                n++;
              } else if ((k === "wsPath" || k === "ws_name") && samePath(val, pf.oldDir)) {
                o[k] = pf.newDir;
                n++;
              }
            } else n += walk(val);
          }
        }
        return n;
      };
      const nTabs = walk(v);
      if (nTabs > 0) changes.push(`paneLayouts 内 ${nTabs} 处 tab 引用`);
      // jdk 提示去重：存的是**绝对路径**
      const jp = v.settings && v.settings.jdkPromptDismissed;
      if (Array.isArray(jp)) {
        let n = 0;
        v.settings.jdkPromptDismissed = jp.map((p) => {
          if (typeof p === "string" && samePath(p, pf.oldDir)) {
            n++;
            return pf.newDir;
          }
          return p;
        });
        if (n > 0) changes.push("jdkPromptDismissed");
      }
    }
    const after = renderJson(se);
    if (after !== before) plan.jsonEdits.push({ file: SETTINGS_FILE, before, after, changes });
  }

  // ── 5. recent.json（字段是 snake_case：ws_key / ws_name）──
  if (fs.existsSync(RECENT_FILE)) {
    const before = fs.readFileSync(RECENT_FILE, "utf8");
    const rc = JSON.parse(before);
    const changes = [];
    for (const s of Array.isArray(rc.sessions) ? rc.sessions : []) {
      if (s.ws_key === plan.oldKey) {
        s.ws_key = plan.newKey;
        changes.push("sessions[].ws_key");
      }
      if (typeof s.ws_name === "string" && samePath(s.ws_name, pf.oldDir)) {
        s.ws_name = pf.newDir;
        changes.push("sessions[].ws_name");
      }
    }
    if (rc.files && typeof rc.files === "object") {
      const bucket = rc.files[plan.oldKey];
      if (bucket) {
        if (rc.files[plan.newKey]) plan.warnings.push("recent.files 已有新 key 桶，两份合并（顺序：新桶在前）。");
        rc.files[plan.newKey] = [...bucket, ...(rc.files[plan.newKey] || [])];
        delete rc.files[plan.oldKey];
        changes.push("files 的 map 键");
      }
      let n = 0;
      for (const bucketList of Object.values(rc.files)) {
        for (const f of Array.isArray(bucketList) ? bucketList : []) {
          if (typeof f.path === "string" && isInside(f.path, pf.oldDir) && !samePath(f.path, pf.oldDir)) {
            f.path = path.join(pf.newDir, path.relative(pf.oldDir, f.path));
            n++;
          }
        }
      }
      if (n > 0) changes.push(`files[].path 前缀改写 ${n} 条`);
    }
    const after = renderJson(rc);
    if (after !== before) plan.jsonEdits.push({ file: RECENT_FILE, before, after, changes });
  }

  // ── 6. run_configs：文件名 + 内部 cwd ──
  const runBase = pathToKey(pf.oldDir);
  for (const e of listDir(RUN_CONFIGS_DIR)) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    const stem = e.name.slice(0, -5);
    if (stem !== runBase && stem.replace(/\./g, "-") !== runBase.replace(/\./g, "-")) continue;
    const file = path.join(RUN_CONFIGS_DIR, e.name);
    const before = fs.readFileSync(file, "utf8");
    let cfgs;
    try {
      cfgs = JSON.parse(before);
    } catch {
      plan.warnings.push(`run_configs/${e.name} 不是合法 JSON，跳过改写。`);
      continue;
    }
    const changes = [];
    let touched = 0;
    for (const c of Array.isArray(cfgs) ? cfgs : []) {
      if (typeof c.cwd === "string" && samePath(c.cwd, pf.oldDir)) {
        c.cwd = pf.newDir;
        touched++;
      } else if (typeof c.cwd === "string" && isInside(c.cwd, pf.oldDir)) {
        c.cwd = path.join(pf.newDir, path.relative(pf.oldDir, c.cwd));
        touched++;
      }
    }
    if (touched > 0) changes.push(`cwd ×${touched}`);
    plan.dirOps.push({ kind: "renameFile", from: file, to: path.join(RUN_CONFIGS_DIR, `${pathToKey(pf.newDir)}.json`) });
    const after = renderJson(cfgs);
    if (after !== before) plan.jsonEdits.push({ file, before, after, changes });
  }

  // ── 7. observatory：快照文件名 + 事件台账行内 workspace_key ──
  for (const e of listDir(SNAPSHOTS_DIR)) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    const stem = e.name.slice(0, -6);
    if (stem !== plan.oldKey && stem.replace(/\./g, "-") !== plan.oldKey.replace(/\./g, "-")) continue;
    plan.dirOps.push({
      kind: "renameFile",
      from: path.join(SNAPSHOTS_DIR, e.name),
      to: path.join(SNAPSHOTS_DIR, `${plan.newKey}.jsonl`),
    });
  }
  if (fs.existsSync(EVENTS_FILE)) {
    const before = fs.readFileSync(EVENTS_FILE, "utf8");
    let n = 0;
    const after = before
      .split("\n")
      .map((line) => {
        if (!line.trim()) return line;
        try {
          const ev = JSON.parse(line);
          let hit = false;
          for (const k of ["workspace_key", "workspaceKey"]) {
            if (ev[k] === plan.oldKey) {
              ev[k] = plan.newKey;
              hit = true;
            }
          }
          if (!hit) return line;
          n++;
          return JSON.stringify(ev);
        } catch {
          return line; // 坏行原样保留（观测数据，不动它）
        }
      })
      .join("\n");
    if (n > 0) plan.jsonEdits.push({ file: EVENTS_FILE, before, after, changes: [`events ×${n} 行`] });
  }

  // ── 8. automations：任务持有的工作区绝对路径 ──
  for (const e of listDir(AUTOMATIONS_DIR)) {
    if (!e.isDirectory()) continue;
    const file = path.join(AUTOMATIONS_DIR, e.name, "task.json");
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, "utf8");
    let t;
    try {
      t = JSON.parse(before);
    } catch {
      plan.warnings.push(`automations/${e.name}/task.json 不是合法 JSON，跳过。`);
      continue;
    }
    const changes = [];
    for (const [key, val] of [
      ["workspacePath", t.workspacePath],
      ["sessionDir", t.sessionDir],
    ]) {
      if (typeof val !== "string" || !samePath(val, pf.oldDir)) continue;
      t[key] = pf.newDir;
      changes.push(key);
    }
    const after = renderJson(t);
    if (after !== before) plan.jsonEdits.push({ file, before, after, changes });
  }

  // ── 8b. .claude.json：claude.exe 自己的「按项目」状态 ──
  // 键是**正斜杠**绝对路径，值里装着 hasTrustDialogAccepted / allowedTools / 每项目
  // MCP 审批。⚠️ 这与 Aide 的 `trustedWorkspaces` 是**两套独立的信任**——只改后者，
  // 迁移后 claude.exe 照样会重新弹信任框。
  if (fs.existsSync(CLAUDE_JSON)) {
    const before = fs.readFileSync(CLAUDE_JSON, "utf8");
    let cj = null;
    try {
      cj = JSON.parse(before);
    } catch {
      plan.warnings.push(".claude.json 不是合法 JSON，跳过（它由 claude.exe 自管）。");
    }
    if (cj && cj.projects && typeof cj.projects === "object") {
      const oldKeys = Object.keys(cj.projects).filter((k) => samePath(k.replace(/\//g, path.sep), pf.oldDir));
      if (oldKeys.length > 0) {
        const changes = [];
        const newKey = slashPath(pf.newDir);
        const merged = oldKeys.reduce((acc, k) => ({ ...acc, ...cj.projects[k] }), {});
        for (const k of oldKeys) delete cj.projects[k];
        cj.projects[newKey] = { ...(cj.projects[newKey] || {}), ...merged };
        changes.push(`projects["${newKey}"]（含 hasTrustDialogAccepted / allowedTools）`);

        // 条目内部的绝对路径（mcpContextUris / mcpServers 等），普通路径与 file:// 都认
        let n = 0;
        const rewrite = (o) => {
          if (Array.isArray(o)) o.forEach(rewrite);
          else if (o && typeof o === "object") {
            for (const [k, v] of Object.entries(o)) {
              if (typeof v !== "string") {
                rewrite(v);
                continue;
              }
              const isFileUri = v.startsWith("file:///");
              const raw = isFileUri ? v.slice("file:///".length) : v;
              const asPath = raw.replace(/\//g, path.sep);
              if (!isInside(asPath, pf.oldDir) || samePath(asPath, pf.oldDir)) continue;
              const next = slashPath(path.join(pf.newDir, path.relative(pf.oldDir, asPath)));
              o[k] = isFileUri ? `file:///${next}` : next;
              n++;
            }
          }
        };
        rewrite(cj.projects[newKey]);
        if (n > 0) changes.push(`projects 内绝对路径 ×${n}`);

        const after = renderJson(cj);
        if (after !== before) plan.jsonEdits.push({ file: CLAUDE_JSON, before, after, changes });
      }
    }
  }

  // ── 9. 收尾提醒 ──
  const staleSessions = [];
  for (const e of listDir(path.join(AIDE_DIR, "claude", "sessions"))) {
    if (!e.isFile()) continue;
    try {
      const s = readJson(path.join(AIDE_DIR, "claude", "sessions", e.name));
      if (typeof s.cwd === "string" && samePath(s.cwd, pf.oldDir)) staleSessions.push(e.name);
    } catch {
      /* 忽略坏文件 */
    }
  }
  if (staleSessions.length > 0) {
    plan.notes.push(
      `~/.aide/claude/sessions/ 下有 ${staleSessions.length} 个陈条仍带旧 cwd（pid 键、claude.exe 写的运行时残留）。` +
        "迁移后它们自然不匹配，不影响使用——本脚本不删它们。"
    );
  }
  const localSettings = path.join(pf.newDir, ".aide", "settings.local.json");
  plan.notes.push(
    `项目内 ${path.relative(pf.newDir, localSettings)} 的**安全命令白名单**里若有绝对路径 matcher，` +
      "本脚本只报告不改写（改错会动到你的安全规则）。迁移后请自行检查。"
  );
  plan.notes.push(
    "以下位置**故意不改**（是历史记录/自由文本，改了反而失真）：`log/`、`diagnostics/`、" +
      "`claude/plans/*.md`、`claude/tasks/*.json` 的 subject/description、会话标题、" +
      "`sessions/*-changes.json` 里 `prompt` 字段（那是你当时打的字，含 @引用绝对路径）。"
  );

  return plan;
}

/**
 * 把 `from` 目录的内容展开成可逐文件回滚的操作序列，合并进 `to`。
 * 冲突策略：`MEMORY.md` **绝不覆盖**（记忆本体），改名保留并点名；其余同名文件跳过并报警。
 */
function expandMerge(from, to, ops, warnings, claimed, stats = { files: 0, dirs: 0, skipped: 0 }) {
  const entries = listDir(from);
  if (entries.length === 0) {
    ops.push({ kind: "rmdir", dir: from });
    return stats;
  }
  if (!fs.existsSync(to) && entries.length > 0) ops.push({ kind: "mkdir", dir: to });
  for (const e of entries) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    // ⚠️ 冲突判定必须同时看「磁盘上已存在」与「本批前面已计划占用的目标」——
    // 目标目录在计划期还不存在，只看磁盘的话两个孪生源会把同一目标各计划一次，
    // 后者覆盖前者 = 静默丢数据（自测抓到的真 bug）。
    const taken = fs.existsSync(dst) || claimed.has(dst.toLowerCase());
    if (e.isDirectory()) {
      stats.dirs++;
      expandMerge(src, dst, ops, warnings, claimed, stats);
    } else if (taken) {
      stats.skipped++;
      if (e.name === "MEMORY.md") {
        let alt = path.join(to, `MEMORY.md.from-${path.basename(from)}`);
        for (let i = 2; fs.existsSync(alt) || claimed.has(alt.toLowerCase()); i++) {
          alt = path.join(to, `MEMORY.md.from-${path.basename(from)}-${i}`);
        }
        claimed.add(alt.toLowerCase());
        ops.push({ kind: "mergeFile", from: src, to: alt });
        warnings.push(
          `记忆冲突：${dst} 已存在，另一份保留为 ${alt}。**两份都要人工看过再合并**——脚本不替你决定记忆内容。`
        );
      } else {
        // 不覆盖、也不删来源——留在原目录里，收尾的 rmdir 会因非空而失败（正是我们要的）
        warnings.push(`同名文件已存在，保留目标；来源留在原处待人工处理：${src}`);
      }
    } else {
      claimed.add(dst.toLowerCase());
      ops.push({ kind: "mergeFile", from: src, to: dst });
      stats.files++;
    }
  }
  ops.push({ kind: "rmdir", dir: from, bestEffort: true });
  return stats;
}

// ─────────────────────────── 计划呈现 ───────────────────────────

function renderPlan(p) {
  const L = [];
  const rule = (t) => L.push("", `── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
  L.push(`旧目录  ${p.oldDir}`);
  L.push(`新目录  ${p.newDir}`);
  L.push(`老 key  ${p.oldKey}   [${p.oldKeySource}]`);
  L.push(`新 key  ${p.newKey}`);
  L.push(`新转录目录名  ${p.newSdkName}`);
  if (p.oldTrust !== p.newTrust) L.push(`信任键  ${p.oldTrust} → ${p.newTrust}`);

  const moves = p.dirOps.filter((o) => o.kind === "moveProject");
  const ren = p.dirOps.filter((o) => o.kind === "renameFile");

  rule("目录");
  for (const m of moves) L.push(`  搬移项目目录\n      ${m.from}\n   →  ${m.to}`);
  for (const g of p.dirSummary) {
    const extra = g.skipped ? `，跳过同名 ${g.skipped}` : "";
    L.push(
      `  ${g.mode}：${path.relative(AIDE_DIR, g.from)}\n` +
        `   →  ${path.relative(AIDE_DIR, g.to)}\n      （${g.files} 文件 / ${g.dirs} 子目录${extra}）`
    );
  }
  if (moves.length + p.dirSummary.length === 0) L.push("  （无）");

  rule("文件改名");
  for (const m of ren) L.push(`  ${path.relative(AIDE_DIR, m.from)}\n   →  ${path.relative(AIDE_DIR, m.to)}`);
  if (ren.length === 0) L.push("  （无）");

  rule("JSON 改写");
  for (const e of p.jsonEdits) {
    L.push(`  ${path.relative(AIDE_DIR, e.file)}`);
    for (const c of e.changes) L.push(`      · ${c}`);
  }
  if (p.jsonEdits.length === 0) L.push("  （无）");

  if (p.warnings.length) {
    rule("警告");
    for (const w of p.warnings) L.push(`  ⚠ ${w}`);
  }
  if (p.notes.length) {
    rule("说明");
    for (const n of p.notes) L.push(`  · ${n}`);
  }
  return L.join("\n");
}

// ─────────────────────────── 执行 ───────────────────────────

/** 递归统计文件数/子目录数/总字节数（跨盘拷贝的校验依据，也是计划里的规模提示）。 */
function treeStats(dir) {
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const e of listDir(d)) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) {
        dirs++;
        walk(f);
      } else if (e.isFile()) {
        files++;
        try {
          bytes += fs.statSync(f).size;
        } catch {
          /* 忽略 */
        }
      }
    }
  };
  walk(dir);
  return { files, dirs, bytes };
}

/**
 * Windows 上重命名目录被拒（EPERM/EACCES/EBUSY）几乎只有一个主因：**有进程锁着它**。
 * 要么该目录（或其某个子目录）是某进程的**工作目录**，要么有进程打开了树内文件
 * （jar / 日志 / 数据库文件）。用相对路径启动的服务尤其容易中招——命令行里看不出
 * 路径，但工作目录就在树里。
 *
 * 实测案例：两个 `java -jar target\xxx.jar` 的 Spring Boot 服务，工作目录分别在
 * `<项目>\44210-equipment` 与 `<项目>\44211-process`，整棵树因此无法 rename。
 */
const LOCK_HINT = (dir) => `这通常是 Windows 文件锁，而不是权限问题。排查：

  1) 列出可疑进程（PowerShell）：
       Get-CimInstance Win32_Process |
         Where-Object { $_.Name -match 'java|node|python|go|dotnet' } |
         ForEach-Object { "$($_.ProcessId)  $($_.Name)  $($_.CommandLine)" }

     ⚠️ 命令行里出现**相对路径**（如 -jar target\\xxx.jar）的，工作目录就在 ${dir} 树内。

  2) 另外检查：编辑器/IDE 打开了该目录、资源管理器停在里面、数据库文件被占用、
     杀软实时扫描的瞬时锁（这种隔几秒重试即可）。

  停掉占用者后直接重跑同一条 --apply 命令。**项目目录与所有 JSON 均未被改动。**`;

/**
 * 零改动占用探针：把目录 rename 到**它自己**。
 * Windows 在检查占用之后才会短路掉同路径 rename，所以被占用时直接拒（EPERM/EBUSY），
 * 自由时通过——不动任何文件、不改任何名字。（实测有效：见 LOCK_HINT 的真实案例。）
 */
function dirLocked(dir) {
  try {
    fs.renameSync(dir, dir);
    return false;
  } catch {
    return true;
  }
}

/** 根目录被占用时，逐个测子目录把锁主定位到具体模块（省得人肉二分）。 */
function lockedSubdirs(dir, limit = 12) {
  const out = [];
  for (const e of listDir(dir)) {
    if (!e.isDirectory()) continue;
    if (dirLocked(path.join(dir, e.name))) out.push(e.name);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 搬目录：同盘 rename 优先；跨盘（EXDEV）回落「拷贝 → 校验 → **才删源**」。
 * 校验通过前绝不删除源目录——这是整份脚本最重要的一条不变量。
 */
function moveProject(from, to) {
  // renameSync 不会替你建父目录——搬到 D:\projects\x 而 D:\projects 尚不存在时，
  // 不建就是 ENOENT 崩在中途。这是真实使用里一定会遇到的情形。
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
    return "rename（同盘，原子）";
  } catch (e) {
    if (e.code === "EPERM" || e.code === "EACCES" || e.code === "EBUSY") {
      const err = new Error(`rename 被拒绝（${e.code}）：${from} → ${to}`);
      err.hint = LOCK_HINT(from);
      throw err;
    }
    if (e.code !== "EXDEV") throw e;
    fs.cpSync(from, to, { recursive: true, errorOnExist: false });
    const a = treeStats(from);
    const b = treeStats(to);
    if (a.files !== b.files || a.bytes !== b.bytes) {
      throw new Error(
        `跨盘拷贝校验失败（源 ${a.files} 文件/${a.bytes} 字节，目标 ${b.files}/${b.bytes}）。` +
          "源目录**未删除**，请检查后重跑。"
      );
    }
    fs.rmSync(from, { recursive: true, force: true });
    return `拷贝+校验+删源（跨盘）${a.files} 文件 / ${a.bytes} 字节`;
  }
}

function applyPlan(p, { quiet }) {
  const log = (s) => {
    if (!quiet) console.log(s);
  };

  // 备份：所有待改文件 + 计划本身（回滚的唯一依据）
  const backupDir = path.join(AIDE_DIR, `backup-workspace-migration-${p.ts}`);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const e of p.jsonEdits) {
    const dst = path.join(backupDir, path.relative(AIDE_DIR, e.file));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, e.before);
  }
  fs.writeFileSync(
    path.join(backupDir, "plan.json"),
    renderJson({ ...p, jsonEdits: p.jsonEdits.map((e) => ({ file: e.file, changes: e.changes })) })
  );
  log(`备份 → ${backupDir}`);

  // 目录操作：先建后并、最后清理；renameFile 单独一遍（避免与被改名的源同批）
  for (const op of p.dirOps) {
    if (op.kind === "moveProject") {
      log(`搬移 ${op.from} → ${op.to} … ${moveProject(op.from, op.to)}`);
    } else if (op.kind === "mkdir") {
      fs.mkdirSync(op.dir, { recursive: true });
    } else if (op.kind === "mergeFile") {
      fs.mkdirSync(path.dirname(op.to), { recursive: true });
      fs.renameSync(op.from, op.to);
    }
  }

  // JSON 改写必须**早于**文件改名：edit 记的是改名前的路径，改完再搬内容
  // （反过来会把已搬走的文件按旧路径重新创建一份，旧内容复活）。
  for (const e of p.jsonEdits) {
    const tmp = `${e.file}.migrate.tmp`;
    fs.writeFileSync(tmp, e.after);
    fs.renameSync(tmp, e.file);
    log(`改写 ${path.relative(AIDE_DIR, e.file)}  (${e.changes.join("; ")})`);
  }

  for (const op of p.dirOps) {
    if (op.kind === "rmdir") {
      try {
        fs.rmdirSync(op.dir); // 只删空目录（非空说明有冲突文件被保留，正好留着）
      } catch {
        /* 非空或已不存在：无妨 */
      }
    }
  }
  for (const op of p.dirOps) {
    if (op.kind === "renameFile" || op.kind === "renameDir") {
      // from 可能已被 JSON 改写步骤重建（见上），以实际存在者为准
      if (fs.existsSync(op.from)) {
        fs.mkdirSync(path.dirname(op.to), { recursive: true });
        fs.renameSync(op.from, op.to);
      }
    }
  }
  return backupDir;
}

/** 回滚：JSON 从备份还原，目录反向搬回。 */
function restorePlan(backupDir) {
  const planFile = path.join(backupDir, "plan.json");
  if (!fs.existsSync(planFile)) throw new Error(`备份目录里没有 plan.json：${backupDir}`);
  const p = readJson(planFile);
  console.log(`回滚：${p.oldDir} ← ${p.newDir}`);

  // 逆序撤销：ops 的构造顺序保证「逆序执行 = 正确回滚」——
  // renameFile/renameDir 先搬回，再补回被清掉的空目录，最后才把并进去的文件挪出来，
  // 而 undo(mkdir) 排在最后（此时目录已空，可删）。
  for (const op of [...p.dirOps].reverse()) {
    switch (op.kind) {
      case "moveProject":
        if (fs.existsSync(op.to) && !fs.existsSync(op.from)) {
          moveProject(op.to, op.from);
          console.log(`  目录搬回 ${op.from}`);
        }
        break;
      case "renameFile":
      case "renameDir":
      case "mergeFile":
        if (fs.existsSync(op.to) && !fs.existsSync(op.from)) {
          fs.mkdirSync(path.dirname(op.from), { recursive: true });
          fs.renameSync(op.to, op.from);
          console.log(`  搬回 ${path.relative(AIDE_DIR, op.from)}`);
        }
        break;
      case "rmdir":
        fs.mkdirSync(op.dir, { recursive: true }); // 原来是空目录，补回来
        break;
      case "mkdir":
        try {
          fs.rmdirSync(op.dir);
        } catch {
          /* 非空：说明还有文件在里面，留着 */
        }
        break;
      default:
        break;
    }
  }
  for (const e of p.jsonEdits) {
    const src = path.join(backupDir, path.relative(AIDE_DIR, e.file));
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, e.file);
      console.log(`  还原 ${path.relative(AIDE_DIR, e.file)}`);
    }
  }
  console.log("\n回滚完成。请复核：项目目录已搬回原位，JSON 已按备份还原，转录目录逐文件搬回。");
}

/** 自检：确保旧 key / 旧路径在改写过的文件里已无残留。 */
function selfCheck(p) {
  const leftovers = [];
  const targets = [STATE_FILE, SETTINGS_FILE, RECENT_FILE, EVENTS_FILE];
  for (const f of targets) {
    if (!fs.existsSync(f)) continue;
    const txt = fs.readFileSync(f, "utf8");
    for (const probe of [p.oldKey, p.oldTrust]) {
      if (probe && probe !== p.newKey && txt.includes(`"${probe}"`)) leftovers.push(`${path.basename(f)}: ${probe}`);
    }
    if (txt.includes(`"${p.oldDir.replace(/\\/g, "\\\\")}"`)) leftovers.push(`${path.basename(f)}: ${p.oldDir}`);
  }
  return leftovers;
}

// ─────────────────────────── 入口 ───────────────────────────

function usage() {
  console.log(`工作区目录迁移（Aide 必须关闭）

  node scripts/migrate-workspace.mjs <旧目录> <新目录>            只打印计划
  node scripts/migrate-workspace.mjs <旧目录> <新目录> --apply    备份后执行
  node scripts/migrate-workspace.mjs --restore <备份目录>         按备份回滚

它做什么：
  1. 搬项目目录本体（跨盘自动走「拷贝 → 校验 → 才删源」）
  2. 把 ~/.aide/claude/projects/<旧编码>/ 及 automation 作用域下的同名目录
     改名合并到新编码（孪生目录收成一个）
  3. 逐段改写 state.json（key 有**两种形态**：注册表/lsp/jdk/黑名单保留点号，
     信任点号归一）、settings.json（布局标签树 + jdk 提示）、
     recent.json、run_configs（文件名+cwd）、observatory（快照名+事件台账）

回滚：
  每次 --apply 都会把改动前的文件与完整计划写进
  ~/.aide/backup-workspace-migration-<时间戳>/
  失败时执行 --restore <该目录> 即可还原 JSON 与目录。
`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    usage();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  if (argv[0] === "--restore") {
    const dir = argv[1];
    if (!dir) {
      console.error("--restore 需要一个备份目录参数");
      process.exit(1);
    }
    restorePlan(path.resolve(dir));
    return;
  }

  const positional = argv.filter((a) => !a.startsWith("--"));
  const forApply = argv.includes("--apply");
  if (positional.length !== 2) {
    console.error(`需要两个参数：<旧目录> <新目录>（收到 ${positional.length} 个）\n`);
    usage();
    process.exit(1);
  }

  const pf = preflight(positional[0], positional[1], { forApply });
  if (pf.fatal.length) {
    console.error("拒绝执行：");
    for (const f of pf.fatal) console.error(`  ✗ ${f}`);
    if (pf.hint) console.error(`\n${pf.hint}`);
    process.exit(1);
  }

  const p = buildPlan(pf);
  if (pf.fatal.length) {
    console.error("拒绝执行：");
    for (const f of pf.fatal) console.error(`  ✗ ${f}`);
    if (pf.hint) console.error(`\n${pf.hint}`);
    process.exit(1);
  }
  plan.warnings.push(...pf.warn);

  console.log(renderPlan(p));
  if (!forApply) {
    console.log("\n（以上为 **计划**，未改动任何数据。确认无误后加 --apply 执行。）");
    return;
  }

  console.log("\n开始执行…");
  let backupDir;
  try {
    backupDir = applyPlan(p, { quiet: false });
  } catch (e) {
    console.error(`\n✗ 执行中断：${e.message}`);
    if (e.hint) console.error(`\n${e.hint}\n`);
    console.error(
      "改动是**逐步进行**的，中断点之前的已完成、之后的未做。所有待改文件都在执行前备份过：\n" +
        `  node scripts/migrate-workspace.mjs --restore <备份目录>\n` +
        "备份目录见上面「备份 →」那一行。若你更想手工检查，备份目录里的 plan.json 记录了完整计划。"
    );
    process.exit(1);
  }

  console.log("\n── 自检 ──");
  const leftovers = selfCheck(p);
  if (leftovers.length === 0) console.log("  ✓ 旧 key / 旧路径无残留");
  else {
    console.log("  ⚠ 仍有残留（未覆盖的字段，请人工检查）：");
    for (const l of leftovers) console.log(`      ${l}`);
  }
  console.log(`\n如需回滚：node scripts/migrate-workspace.mjs --restore "${backupDir}"`);
  console.log("完成。开 Aide 后请确认：工作区在列、会话列表还在、记忆观测台能看到原记忆、信任框没有重弹、run 配置还在。");
}

main();
