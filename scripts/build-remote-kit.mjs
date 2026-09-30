// 远程套件构建：aide-host（linux musl 静态二进制，按架构）+ sidecar bundle（runtime.js）
// → src-tauri/remote-kit/{aide-host-linux-x64, aide-host-linux-arm64, runtime.js}，随安装包分发（tauri.conf.json resources），桌面连接 WSL / SSH
// 目标机时上传（见 src-tauri/src/remote_workspace/install.rs）。
//
// 用法：node scripts/build-remote-kit.mjs [--debug] [--optional]
//   --optional：构建失败只警告不退出（dev 启动链用：没有交叉编译条件的机器照样能跑桌面，
//   只是连不了远程工作区；release 不带它——安装包缺套件必须当场失败）。
//
// 交叉编译策略（host 是纯 Rust、无 C 依赖，musl 目标可静态链接）：
//   - Linux 宿主：x86_64 原生 `cargo build --target x86_64-unknown-linux-musl`；
//     aarch64 需要 cargo-zigbuild（没有就跳过并提示）。
//   - Windows / macOS 宿主：有 cargo-zigbuild 就用它编两个架构；否则 Windows 上若有
//     WSL，把 x86_64 的构建委托给 WSL 里的 cargo（与 Linux 宿主同一命令）。
//   缺哪个架构只影响连接该架构的目标机——install.rs 会报「本机缺少远程套件」，不静默。
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(root, "src-tauri");
const kitDir = join(tauriDir, "remote-kit");
const profile = process.argv.includes("--debug") ? "debug" : "release";
const profileArgs = profile === "release" ? ["--release"] : [];
const optional = process.argv.includes("--optional");

const TARGETS = [
  { triple: "x86_64-unknown-linux-musl", dir: "linux-x64" },
  { triple: "aarch64-unknown-linux-musl", dir: "linux-arm64" },
];

function has(cmd, args = ["--version"]) {
  return spawnSync(cmd, args, { stdio: "ignore", shell: process.platform === "win32" }).status === 0;
}

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
}

function ensureTarget(triple) {
  try {
    run("rustup", ["target", "add", triple]);
  } catch {
    /* rustup 不在也可能已装好目标，交给后面的 cargo 报错 */
  }
}

function output(triple) {
  return join(tauriDir, "target", triple, profile, "aide-host");
}

/** Windows：把 x86_64 musl 构建委托给 WSL 里的 cargo。 */
function buildViaWsl(triple) {
  if (process.platform !== "win32" || !has("wsl.exe", ["--status"])) return false;
  const wslPath = execFileSync("wsl.exe", ["wslpath", "-a", tauriDir.replace(/\\/g, "/")])
    .toString()
    .trim();
  // 脚本走 **stdin**（`bash -ls`），不上命令行：`run()` 在 Windows 上开 shell，cmd.exe 会把
  // 拼起来的命令行按 `&&` 拆开——bash 只收到 `set`（打出一屏变量），cmd 自己去跑 `[`。
  // 走 stdin 就没有任何一层引号/转义要对付。
  const script = [
    "set -e",
    'if [ -f "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env"; fi',
    `rustup target add ${triple} >/dev/null 2>&1 || true`,
    `cd '${wslPath}'`,
    `cargo build ${profileArgs.join(" ")} -p aide-host --target ${triple}`,
    "",
  ].join("\n");
  console.log(`$ wsl.exe -e bash -ls  <<< cargo build -p aide-host --target ${triple}`);
  execFileSync("wsl.exe", ["-e", "bash", "-ls"], { input: script, stdio: ["pipe", "inherit", "inherit"] });
  return true;
}

const zig = has("cargo", ["zigbuild", "--help"]);
const built = [];
for (const { triple, dir } of TARGETS) {
  const native = process.platform === "linux" && process.arch === "x64" && triple.startsWith("x86_64");
  try {
    if (native) {
      ensureTarget(triple);
      run("cargo", ["build", ...profileArgs, "-p", "aide-host", "--target", triple], { cwd: tauriDir });
    } else if (zig) {
      ensureTarget(triple);
      run("cargo", ["zigbuild", ...profileArgs, "-p", "aide-host", "--target", triple], { cwd: tauriDir });
    } else if (triple.startsWith("x86_64") && buildViaWsl(triple)) {
      // 已在 WSL 内构建
    } else {
      console.warn(`⚠ 跳过 ${triple}：需要 cargo-zigbuild（\`cargo install cargo-zigbuild\` + zig）`);
      continue;
    }
    const out = output(triple);
    if (!existsSync(out)) throw new Error(`构建产物不存在：${out}`);
    // 平铺 + 架构后缀：tauri resources 的 glob 会拍平目录，子目录同名文件会互相覆盖
    const dest = join(kitDir, `aide-host-${dir}`);
    mkdirSync(kitDir, { recursive: true });
    copyFileSync(out, dest);
    try {
      chmodSync(dest, 0o755);
    } catch {
      /* Windows 文件系统无执行位：上传时 install.rs 会 chmod +x */
    }
    built.push(dir);
  } catch (e) {
    console.warn(`⚠ ${triple} 构建失败：${e.message}`);
  }
}

// sidecar bundle：平台无关 JS，目标机用 node 跑（install.rs 保证 node 存在）
const runtime = join(root, "agent-sidecar", "dist", "runtime.js");
// 总是重打：runtime.js 与桌面同版本才有意义（桌面按内容哈希判定目标机是否要重装）
run("npm", ["--prefix", join(root, "agent-sidecar"), "run", "build"]);
mkdirSync(kitDir, { recursive: true });
copyFileSync(runtime, join(kitDir, "runtime.js"));

if (!built.includes("linux-x64")) {
  console.error("✗ linux-x64 aide-host 未构建成功——远程工作区（WSL / 绝大多数服务器）将不可用");
  process.exit(optional ? 0 : 1);
}
console.log(`✓ remote-kit → ${kitDir}（${built.join(", ")} + runtime.js）`);
