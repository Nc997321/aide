# 首次安装引导（Onboarding）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 aide 加一个首启动全屏沉浸式分步引导，把"工作区 → 登录 Claude → 模型"三件事教给完全懵的新用户，全可跳过，跳过的步骤由上下文兜底接住。

**Architecture:** 全屏覆盖式 Vue 向导（`OnboardingWizard` + 4 个 step 子组件，下沉 `src/components/onboarding/`）。新增 `AppSettings.onboarded` 持久化标志做挂载门控（前后端 serde/descriptors/defaults 三层）。登录走 claude.exe OAuth 控制通道（sidecar 代理）+ API key 兜底 + 两级降级。上下文兜底改造 `useChatSession`（无凭证拦截）与 `FileTree`（空工作区引导）。

**Tech Stack:** Vue 3 + Composition API + TS、Tauri v2（Rust 后端）、Vitest 4 + @vue/test-utils 2 + jsdom、agent-sidecar（Node，Claude Agent SDK）。

**Spec:** `docs/superpowers/specs/2026-08-11-onboarding-design.md`（分支 `docs/onboarding-design-spec`，commit `3eed442`）。

## Global Constraints

- 所有颜色/尺寸/圆角/阴影用 `var(--aide-*)`，禁硬编码 hex（CLAUDE.md 主题红线）。
- 跨平台：Rust 路径用 `PathBuf`/`path.join`，不硬编码 `\\`；平台特有逻辑 `#[cfg(windows)]` 隔离（CLAUDE.md）。
- Windows：所有 `Command::new` 必须加 `CREATE_NO_WINDOW (0x08000000)`（CLAUDE.md 坑点）——Task 7 spawn `claude auth login` 必须遵守。
- 传给子进程的 `resource_dir`/`\\?\` verbatim 路径必须 `dunce::simplified()` 剥前缀（CLAUDE.md 坑点）。
- 新逻辑下沉同名子目录：`onboarding/` + `onboarding/steps/`，宿主只留门面（项目记忆）。
- 改设置默认值三层都要动：后端 `descriptors.rs` + serde `default_xxx()` + 前端 `types.ts` + `useSettings.ts` defaults 与 load 合并行（项目记忆 + spec §8.1）。
- 三角箭头字形 14px；新代码用 SVG chevron，不用字符 ▾/▸（spec §4.4）。
- 测试：`pnpm test`（root vitest 同时跑 `src/**` 与 `agent-sidecar/src/**`）；组件测试首行加 `// @vitest-environment jsdom`，`mount(... attachTo: document.body, global:{ stubs:{ Teleport }})`；composable 测试用 `vi.mock("../api", ...)`。
- 每步 commit 消息结尾 `Co-Authored-By: Claude <noreply@anthropic.com>`；在当前分支 `docs/onboarding-design-spec` 提交（已非 master）。

## File Structure

**Create:**
- `src/composables/useOnboarding.ts` — 向导状态机：`step`、`visible`、`open/openAt/advance/back/skip/skipAll/done`。
- `src/composables/useOnboarding.test.ts`
- `src/components/onboarding/OnboardingWizard.vue` — 全屏壳 + chrome（进度轨/跳过/导航）+ step 插槽。
- `src/components/onboarding/OnboardingWizard.test.ts`
- `src/components/onboarding/steps/WelcomeStep.vue` / `WorkspaceStep.vue` / `LoginStep.vue` / `ModelStep.vue`
- 各 step 对应 `*.test.ts`
- `src-tauri/src/commands/onboarding.rs` — `claude_credentials_exist`、`claude_start_login`、`claude_login_wait` 三个命令（Rust 侧）。
- `agent-sidecar/src/oauthLogin.ts` — 临时会话上发 `claude_authenticate` + 等完成；`oauthLogin.test.ts`

**Modify:**
- `src-tauri/src/settings/descriptors.rs:184` — 加 `onboarded` 描述符。
- `src-tauri/src/settings/schema_test.rs:37` — 已知键列表加 `onboarded`。
- `src/types.ts` — `AppSettings` 加 `onboarded: boolean`。
- `src/composables/useSettings.ts:6,79` — defaults + load 合并行加 `onboarded`。
- `src/App.vue` — onMounted 门控（line 714 后）+ template 挂 `<OnboardingWizard>`。
- `src/api.ts` — 加 `claudeCredentialsExist`、`claudeStartLogin`、`claudeLoginWait`。
- `src-tauri/src/lib.rs:208` — `generate_handler!` 注册新命令。
- `src/components/FileTree.vue:145-153` — 空态加"选一个工作区"按钮。
- `src/composables/useChatSession.ts:986-1003` — 无凭证发消息拦截 + 引导卡片。
- `src/components/SettingsPanel.vue` — 关于 tab 加"重新运行首次引导"按钮。
- `agent-sidecar/src/session-worker.ts` — 接入 `oauthLogin` 控制通道。
- `src-tauri/src/commands/migration.rs:86-94` — `MIGRATABLE_ENTRIES` 加 `.credentials.json`。
- `src/utils/icons.ts` — 缺则补 `folder`/`login` 字形（`key`/`model` 已有）。

---

### Task 1: `onboarded` 持久化标志（前后端三层）

**Files:**
- Modify: `src-tauri/src/settings/descriptors.rs:184`
- Modify: `src-tauri/src/settings/schema_test.rs:37`
- Modify: `src/types.ts`
- Modify: `src/composables/useSettings.ts:6,79`
- Test: `src/composables/useOnboarding.flag.test.ts`（临时，验证 settings 往返）

**Interfaces:**
- Produces: `AppSettings.onboarded: boolean`（默认 `false`），经 `api.getSettings()/setSettings({onboarded})` 往返；后端描述符 key `"onboarded"`、kind `Boolean`、scope `user`、分组 `"general"`。

- [ ] **Step 1: 写失败测试——前端 defaults 含 onboarded:false**

```ts
// src/composables/useOnboarding.flag.test.ts
import { describe, it, expect } from "vitest";
describe("onboarded flag defaults", () => {
  it("useSettings defaults.onboarded === false", async () => {
    const mod = await import("./useSettings");
    // defaults 不导出，通过 reactive 初始值验证
    expect((mod as any).settings.onboarded).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- src/composables/useOnboarding.flag.test.ts`
Expected: FAIL（`settings.onboarded` is `undefined`，不是 `false`）

- [ ] **Step 3: 后端描述符**

在 `src-tauri/src/settings/descriptors.rs:184` 这条 `user("claudeMigrationDone", ...)` 下面加一行：

```rust
        user("onboarded", json!(false), SettingValueKind::Boolean, "general"),
```

在 `src-tauri/src/settings/schema_test.rs:37` 附近的已知键列表里加 `"onboarded",`（保持该测试通过）。

- [ ] **Step 4: 前端类型 + defaults + load 合并**

`src/types.ts` 的 `AppSettings` 接口加：

```ts
  onboarded: boolean;
```

`src/composables/useSettings.ts:6` 的 `defaults` 对象加 `onboarded: false,`；`load()` 里（参考 `:79` 的 `settings.jdkPromptDismissed = s.jdkPromptDismissed ?? defaults.jdkPromptDismissed;`）加：

```ts
      settings.onboarded = s.onboarded ?? defaults.onboarded;
```

- [ ] **Step 5: 跑前后端测试确认通过**

Run: `pnpm test -- src/composables/useOnboarding.flag.test.ts` → PASS
Run: `cargo test --manifest-path src-tauri/Cargo.toml schema` → PASS（schema_test 含已知键校验）

- [ ] **Step 6: 删临时测试 + commit**

删除 `src/composables/useOnboarding.flag.test.ts`（默认值校验已由后端 schema_test 覆盖，前端 defaults 会在 Task 2 的 useOnboarding 测试里顺带覆盖）。

```bash
git add src-tauri/src/settings/descriptors.rs src-tauri/src/settings/schema_test.rs src/types.ts src/composables/useSettings.ts
git commit -m "feat(settings): 新增 AppSettings.onboarded 标志位(前后端三层)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: `useOnboarding` composable + App.vue 门控

**Files:**
- Create: `src/composables/useOnboarding.ts`
- Create: `src/composables/useOnboarding.test.ts`
- Modify: `src/App.vue:714`（onMounted 门控）+ template（挂载点）

**Interfaces:**
- Consumes: `useSettings()`（`settings.onboarded`、`update()`）、`api`（Task 6/7 的登录命令，本任务只占位 import）。
- Produces:
  - `useOnboarding()` → `{ visible: Ref<boolean>, step: Ref<Step>, open(): void, openAt(s: Step): void, advance(): void, back(): void, skip(): void, skipAll(): void, complete(): void }`
  - `Step = "welcome" | "workspace" | "login" | "model" | "done"`
  - `complete()` 调 `update({ onboarded: true })` 并 `visible.value = false`。
  - `open()` 仅当 `!settings.onboarded` 时设 `visible=true`（再入口无视此守卫，直接 open）。

- [ ] **Step 1: 写失败测试**

```ts
// src/composables/useOnboarding.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./useSettings", () => ({
  useSettings: () => ({
    settings: { onboarded: false },
    update: vi.fn(),
  }),
}));

import { useOnboarding } from "./useOnboarding";

describe("useOnboarding", () => {
  beforeEach(() => {
    const ob = useOnboarding();
    ob.visible.value = false;
    ob.step.value = "welcome";
  });

  it("open() 在未 onboarded 时显示向导、停在 welcome", () => {
    const ob = useOnboarding();
    ob.open();
    expect(ob.visible.value).toBe(true);
    expect(ob.step.value).toBe("welcome");
  });

  it("advance 顺序推进 welcome→workspace→login→model→done，done 触发 complete", () => {
    const ob = useOnboarding();
    ob.open();
    const order = ["workspace", "login", "model", "done"] as const;
    for (const expected of order) {
      ob.advance();
      expect(ob.step.value).toBe(expected);
    }
  });

  it("complete() 调 update({onboarded:true}) 并隐藏", async () => {
    const { useSettings } = await import("./useSettings");
    const update = useSettings().update as any;
    const ob = useOnboarding();
    ob.open();
    ob.complete();
    await Promise.resolve();
    expect(update).toHaveBeenCalledWith({ onboarded: true });
    expect(ob.visible.value).toBe(false);
  });

  it("skipAll() 直接 complete（跳过整个引导）", async () => {
    const { useSettings } = await import("./useSettings");
    const update = useSettings().update as any;
    const ob = useOnboarding();
    ob.open();
    ob.skipAll();
    await Promise.resolve();
    expect(update).toHaveBeenCalledWith({ onboarded: true });
    expect(ob.visible.value).toBe(false);
  });

  it("openAt('login') 直达指定步（上下文兜底用）", () => {
    const ob = useOnboarding();
    ob.openAt("login");
    expect(ob.visible.value).toBe(true);
    expect(ob.step.value).toBe("login");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- src/composables/useOnboarding.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 useOnboarding**

```ts
// src/composables/useOnboarding.ts
import { ref, type Ref } from "vue";
import { useSettings } from "./useSettings";

export type Step = "welcome" | "workspace" | "login" | "model" | "done";

const ORDER: Step[] = ["welcome", "workspace", "login", "model", "done"];

const visible = ref(false);
const step = ref<Step>("welcome");

export function useOnboarding() {
  const { settings, update } = useSettings();

  function open() {
    if (settings.onboarded) return; // 老用户不弹
    step.value = "welcome";
    visible.value = true;
  }
  function openAt(s: Step) {
    step.value = s;
    visible.value = true;
  }
  function advance() {
    const i = ORDER.indexOf(step.value);
    if (i < ORDER.length - 1) step.value = ORDER[i + 1];
    if (step.value === "done") complete();
  }
  function back() {
    const i = ORDER.indexOf(step.value);
    if (i > 0 && step.value !== "done") step.value = ORDER[i - 1];
  }
  function skip() { advance(); } // 跳过当前步 = 推进到下一步
  async function complete() {
    await update({ onboarded: true });
    visible.value = false;
  }
  function skipAll() { complete(); }

  return { visible, step, open, openAt, advance, back, skip, skipAll, complete };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- src/composables/useOnboarding.test.ts`
Expected: PASS

- [ ] **Step 5: App.vue 门控**

在 `src/App.vue:714`（`await loadProviders();` 之后、`void refreshSystemDefaultModels();` 之前）插入：

```ts
  // 首次引导：未 onboarded 时弹全屏向导（在 loadProviders 之后，登录步的 apiKeyConfigured 已就绪）
  const onboarding = useOnboarding();
  onboarding.open();
```

在 template（与 SettingsPanel 同级，App.vue 约第一层根容器内）加：

```html
    <OnboardingWizard v-if="onboarding.visible.value" />
```

并在 `<script setup>` 顶部 import：

```ts
import OnboardingWizard from "./components/onboarding/OnboardingWizard.vue";
```

> 注：本步 import 一个尚未创建的组件，TS 会报错——可临时用占位注释让 build 过，或直接进入 Task 3 创建组件后此处自然通过。**本任务的 commit 只含 useOnboarding + 测试**；App.vue 的门控改动留到 Task 3 完成后一并提交（否则 App.vue 引用不存在的组件会破坏构建）。所以本步先**只在 App.vue 里加 onboarding.open() 那一行调用 + import，但暂不挂 template**，待 Task 3 创建 OnboardingWizard 后再挂 template 并提交 App.vue 改动。

为避免破坏构建，本任务**只提交 `useOnboarding.ts` + 测试**：

```bash
git add src/composables/useOnboarding.ts src/composables/useOnboarding.test.ts
git commit -m "feat(onboarding): useOnboarding 向导状态机(open/advance/skip/complete)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 6: 跑全量测试确认无回归**

Run: `pnpm test`
Expected: PASS（useOnboarding + 既有测试全绿）

---

### Task 3: `OnboardingWizard` 全屏壳 + chrome + 状态机（stub steps）

**Files:**
- Create: `src/components/onboarding/OnboardingWizard.vue`
- Create: `src/components/onboarding/OnboardingWizard.test.ts`
- Modify: `src/App.vue`（挂 template + 提交 App.vue 改动）

**Interfaces:**
- Consumes: `useOnboarding()`（`visible`、`step`、`advance`、`back`、`skipAll`）、`useSettings`（主题已全局，无需额外）。
- Produces: `<OnboardingWizard />` 组件，根据 `step` 渲染对应 step 子组件（本任务用占位 div，Task 4-8 替换为真组件）。

- [ ] **Step 1: 写失败测试**

```ts
// src/components/onboarding/OnboardingWizard.test.ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";

vi.mock("../../composables/useOnboarding", () => {
  const { ref } = require("vue");
  const visible = ref(true);
  const step = ref("welcome");
  return {
    useOnboarding: () => ({
      visible, step,
      advance: vi.fn(() => { step.value = "workspace"; }),
      back: vi.fn(),
      skipAll: vi.fn(),
    }),
  };
});

import OnboardingWizard from "./OnboardingWizard.vue";
import { useOnboarding } from "../../composables/useOnboarding";

function mountWizard() {
  return mount(OnboardingWizard, {
    attachTo: document.body,
    global: { stubs: { Teleport: { template: "<div><slot /></div>" } } },
  });
}

describe("OnboardingWizard shell", () => {
  beforeEach(() => {
    const ob = useOnboarding() as any;
    ob.visible.value = true; ob.step.value = "welcome";
  });

  it("渲染全屏覆盖 + 4 段进度轨 + 跳过引导按钮", () => {
    const w = mountWizard();
    expect(w.find(".onboarding-overlay").exists()).toBe(true);
    expect(w.findAll(".rail .seg").length).toBe(4);
    expect(w.find(".skip-all").exists()).toBe(true);
  });

  it("welcome 步只显示「开始」、不显示「上一步」", () => {
    const w = mountWizard();
    expect(w.find(".btn-primary").text()).toContain("开始");
    expect(w.find(".btn-back").exists()).toBe(false);
  });

  it("点「跳过引导」调 skipAll", async () => {
    const ob = useOnboarding() as any;
    const w = mountWizard();
    await w.find(".skip-all").trigger("click");
    expect(ob.skipAll).toHaveBeenCalled();
  });

  it("点「开始」调 advance（推进到 workspace）", async () => {
    const ob = useOnboarding() as any;
    const w = mountWizard();
    await w.find(".btn-primary").trigger("click");
    expect(ob.advance).toHaveBeenCalled();
    expect(ob.step.value).toBe("workspace");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- src/components/onboarding/OnboardingWizard.test.ts`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现 OnboardingWizard.vue**

```vue
<!-- src/components/onboarding/OnboardingWizard.vue -->
<script setup lang="ts">
import { computed } from "vue";
import { useOnboarding, type Step } from "../../composables/useOnboarding";
import WelcomeStep from "./steps/WelcomeStep.vue";
import WorkspaceStep from "./steps/WorkspaceStep.vue";
import LoginStep from "./steps/LoginStep.vue";
import ModelStep from "./steps/ModelStep.vue";

const ob = useOnboarding();

const STEPS: { key: Step; label: string }[] = [
  { key: "welcome", label: "欢迎" },
  { key: "workspace", label: "工作区" },
  { key: "login", label: "登录" },
  { key: "model", label: "模型" },
];
const curIndex = computed(() => STEPS.findIndex(s => s.key === ob.step.value));
const isLast = computed(() => ob.step.value === "model");

const primaryText = computed(() => {
  if (ob.step.value === "welcome") return "开始";
  if (ob.step.value === "model") return "进入 aide";
  return "下一步";
});
function onPrimary() {
  if (ob.step.value === "model") ob.complete();
  else ob.advance();
}
</script>

<template>
  <Teleport to="body">
    <div class="onboarding-overlay">
      <div class="wiz-top">
        <div class="rail">
          <template v-for="(s, i) in STEPS" :key="s.key">
            <div class="seg" :class="{ done: i < curIndex, cur: i === curIndex }">
              <span class="bar"></span><span class="nm">{{ s.label }}</span>
            </div>
            <div v-if="i < STEPS.length - 1" class="seg-sep"></div>
          </template>
        </div>
        <button class="skip-all" @click="ob.skipAll()">跳过引导</button>
      </div>

      <div class="wiz-center">
        <WelcomeStep v-if="ob.step.value === 'welcome'" />
        <WorkspaceStep v-else-if="ob.step.value === 'workspace'" />
        <LoginStep v-else-if="ob.step.value === 'login'" />
        <ModelStep v-else-if="ob.step.value === 'model'" />
      </div>

      <div class="wiz-bottom">
        <button v-if="ob.step.value !== 'welcome'" class="btn btn-ghost btn-back" @click="ob.back()">← 上一步</button>
        <span class="left" v-if="ob.step.value !== 'welcome' && ob.step.value !== 'model'">不配也行，发消息时再引导</span>
        <span class="left" v-else-if="ob.step.value === 'model'">就绪</span>
        <span class="left" v-else>约 1 分钟 · 随时可跳过</span>
        <button class="btn btn-primary" @click="onPrimary">{{ primaryText }} <span v-if="!isLast">→</span></button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.onboarding-overlay {
  position: fixed; inset: 0; z-index: 1200;
  display: flex; flex-direction: column; padding: 22px 28px 24px;
  background:
    radial-gradient(420px 220px at 50% -40px, rgba(150,170,255,.20), transparent 70%),
    radial-gradient(560px 380px at 12% 8%, rgba(124,108,255,.14), transparent 65%),
    radial-gradient(520px 420px at 94% 12%, rgba(64,190,220,.10), transparent 65%),
    rgba(10,11,17,.78);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  color: var(--aide-text-primary);
}
.wiz-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.rail { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.seg { display: flex; align-items: center; gap: 7px; min-width: 0; }
.seg .bar { height: 3px; flex: 1; min-width: 18px; border-radius: 99px; background: var(--aide-surface-active); }
.seg .nm { font-size: 10px; color: var(--aide-text-muted); white-space: nowrap; }
.seg.done .bar { background: var(--aide-accent); opacity: .55; }
.seg.cur .bar { background: var(--aide-accent-gradient); box-shadow: 0 0 8px rgba(150,170,255,.5); }
.seg.cur .nm { color: var(--aide-accent); font-weight: 600; }
.seg-sep { width: 5px; height: 5px; border-radius: 50%; background: var(--aide-border); flex-shrink: 0; }
.skip-all { font-size: 11px; color: var(--aide-text-muted); background: transparent; border: 1px solid var(--aide-border); padding: 5px 11px; border-radius: 99px; cursor: pointer; transition: all .16s var(--aide-ease); }
.skip-all:hover { color: var(--aide-text-secondary); border-color: var(--aide-border-strong); background: var(--aide-surface); }
.wiz-center { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 14px; max-width: 540px; margin: 0 auto; }
.wiz-bottom { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.wiz-bottom .left { font-size: 10.5px; color: var(--aide-text-muted); }
.btn { font-family: inherit; cursor: pointer; border: none; transition: all .16s var(--aide-ease); display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
.btn-primary { padding: 13px 20px; border-radius: var(--aide-radius-md); background: var(--aide-accent-gradient); color: #eef0ff; font-size: 13.5px; font-weight: 600; box-shadow: var(--aide-accent-glow), var(--aide-highlight-inset); border: 1px solid rgba(150,170,255,.45); }
.btn-primary:hover { transform: translateY(-1px); filter: brightness(1.07); }
.btn-ghost { padding: 8px 16px; border-radius: var(--aide-radius-md); background: var(--aide-surface); border: 1px solid var(--aide-border); color: var(--aide-text-secondary); font-size: 12px; font-weight: 500; }
.btn-ghost:hover { background: var(--aide-surface-hover); color: var(--aide-text-primary); transform: translateY(-1px); }
@media (prefers-reduced-motion: reduce) { .btn, .skip-all { transition: none; } .btn-primary:hover, .btn-ghost:hover { transform: none; } }
</style>
```

> 本任务依赖 4 个 step 子组件 import。为不破坏构建，先创建 4 个**最小占位** step 组件（每个就一个 `<div class="step-stub">{{ 步名 }}</div>`），Task 4-8 逐个替换为真实内容。

创建占位（4 个文件，内容同形）：

```vue
<!-- src/components/onboarding/steps/WelcomeStep.vue -->
<template><div class="step-stub">welcome</div></template>
```
（WorkspaceStep/LoginStep/ModelStep 同理，文本换 "workspace"/"login"/"model"）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- src/components/onboarding/OnboardingWizard.test.ts`
Expected: PASS

- [ ] **Step 5: 挂到 App.vue + 提交**

在 `src/App.vue` template 加（与 SettingsPanel 同级）：

```html
    <OnboardingWizard v-if="onboarding.visible.value" />
```

确认 `<script setup>` 已 import `OnboardingWizard` 与 `useOnboarding`（Task 2 已加调用；若 Task 2 未加 import 则补）。

```bash
git add src/components/onboarding/ src/App.vue
git commit -m "feat(onboarding): OnboardingWizard 全屏壳+进度轨+导航(4 step 占位)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 6: 手动验证**

Run: `pnpm tauri dev` → 删 `~/.aide/settings.json` 的 `onboarded`（或整删该文件）→ 启动 → 应弹全屏向导，进度轨 4 段，welcome 步显"开始"，点"跳过引导"关闭向导且 settings 里 `onboarded:true`。

---

### Task 4: `WelcomeStep`（签名时刻）

**Files:**
- Modify: `src/components/onboarding/steps/WelcomeStep.vue`
- Create: `src/components/onboarding/steps/WelcomeStep.test.ts`

**Interfaces:**
- Consumes: `AppLogo`（`src/components/AppLogo.vue`）、无外部 props。
- Produces: 渲染 logo + headline + support + 三 pill。无交互（"开始"按钮在 Wizard 底部，非本组件）。

- [ ] **Step 1: 写失败测试**

```ts
// src/components/onboarding/steps/WelcomeStep.test.ts
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import WelcomeStep from "./WelcomeStep.vue";

describe("WelcomeStep", () => {
  it("渲染 headline + 三 pill", () => {
    const w = mount(WelcomeStep);
    expect(w.find(".headline").text()).toContain("用 Aide，和 Claude 并肩写代码");
    const pills = w.findAll(".pill");
    expect(pills.length).toBe(3);
    expect(pills[0].text()).toContain("选工作区");
    expect(pills[1].text()).toContain("登录 Claude");
    expect(pills[2].text()).toContain("选模型");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- src/components/onboarding/steps/WelcomeStep.test.ts`
Expected: FAIL（占位无 .headline/.pill）

- [ ] **Step 3: 实现 WelcomeStep.vue**

```vue
<!-- src/components/onboarding/steps/WelcomeStep.vue -->
<script setup lang="ts">
import AppLogo from "../../AppLogo.vue";
</script>

<template>
  <AppLogo class="logo-big" />
  <div class="eyebrow">01 / 04</div>
  <div class="headline">用 Aide，和 Claude 并肩写代码</div>
  <div class="support">aide 是一个桌面工作区——会话、文件树、代码索引都在一个窗口。三步配好，马上能开聊。</div>
  <div class="pills">
    <div class="pill"><b>1</b>选工作区</div>
    <div class="pill"><b>2</b>登录 Claude</div>
    <div class="pill"><b>3</b>选模型</div>
  </div>
</template>

<style scoped>
.logo-big { width: 56px; height: 56px; }
.headline { font-size: 24px; font-weight: 600; letter-spacing: -.015em; line-height: 1.2; color: var(--aide-text-primary); }
.support { font-size: 13px; color: var(--aide-text-secondary); line-height: 1.65; max-width: 440px; }
.pills { display: flex; gap: 8px; }
.pill { font-size: 11px; color: var(--aide-text-secondary); background: var(--aide-surface); border: 1px solid var(--aide-border-subtle); padding: 5px 11px; border-radius: 99px; display: flex; align-items: center; gap: 6px; }
.pill b { color: var(--aide-accent); font-weight: 600; }
.eyebrow { font-size: 10px; color: var(--aide-accent); font-weight: 600; letter-spacing: .14em; text-transform: uppercase; }
</style>
```

> 注：`AppLogo` 已自带尺寸/样式；56px 由其 props 或外层 class 控制，若 AppLogo 不吃外部 class 则包一层 `<div class="logo-big"><AppLogo /></div>` 并在 scoped 里给该 div 设 56px。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- src/components/onboarding/steps/WelcomeStep.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/onboarding/steps/WelcomeStep.vue src/components/onboarding/steps/WelcomeStep.test.ts
git commit -m "feat(onboarding): WelcomeStep 签名时刻(logo+价值主张+三步预览)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: `WorkspaceStep`（文件夹选择 + 拖拽 + createWorkspace + 自动跳过）

**Files:**
- Modify: `src/components/onboarding/steps/WorkspaceStep.vue`
- Create: `src/components/onboarding/steps/WorkspaceStep.test.ts`
- Consumes: `api.createWorkspace`、`@tauri-apps/plugin-dialog`（open）、`useOnboarding`（advance）。

**Interfaces:**
- Produces: 选定文件夹 → 调 `api.createWorkspace(path)` → 成功后 `advance()`。已有激活工作区时（`useWorkspaces` activeWorkspaceKey）组件 mounted 即调 `advance()` 自动跳过。

- [ ] **Step 1: 写失败测试**

```ts
// src/components/onboarding/steps/WorkspaceStep.test.ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const createWorkspace = vi.fn();
const openDialog = vi.fn();
vi.mock("../../../api", () => ({ api: { createWorkspace: (...a: any[]) => createWorkspace(...a) } }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: any[]) => openDialog(...a) }));
vi.mock("../../../composables/useWorkspaces", () => ({
  useWorkspaces: () => ({ activeWorkspaceKey: { value: null } }),
}));
vi.mock("../../../composables/useOnboarding", () => {
  const { ref } = require("vue");
  return { useOnboarding: () => ({ advance: vi.fn(), step: ref("workspace") }) };
});

import WorkspaceStep from "./WorkspaceStep.vue";

describe("WorkspaceStep", () => {
  beforeEach(() => { createWorkspace.mockReset(); openDialog.mockReset(); });

  it("点「浏览」打开目录对话框并 createWorkspace + 推进", async () => {
    openDialog.mockResolvedValue("C:/dev/myproject");
    createWorkspace.mockResolvedValue({ key: "k", path: "C:/dev/myproject", name: "myproject" });
    const { useOnboarding } = await import("../../../composables/useOnboarding");
    const advance = useOnboarding().advance as any;
    const w = mount(WorkspaceStep, { attachTo: document.body });
    await w.find(".folder-pick").trigger("click");
    await Promise.resolve();
    expect(openDialog).toHaveBeenCalled();
    expect(createWorkspace).toHaveBeenCalledWith("C:/dev/myproject");
    expect(advance).toHaveBeenCalled();
  });

  it("取消对话框不 createWorkspace、不推进", async () => {
    openDialog.mockResolvedValue(null);
    const { useOnboarding } = await import("../../../composables/useOnboarding");
    const advance = useOnboarding().advance as any;
    const w = mount(WorkspaceStep, { attachTo: document.body });
    await w.find(".folder-pick").trigger("click");
    await Promise.resolve();
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
  });
});
function mount(c: any, o: any) { const { mount: m } = require("@vue/test-utils"); return m(c, o); }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- src/components/onboarding/steps/WorkspaceStep.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 WorkspaceStep.vue**

```vue
<!-- src/components/onboarding/steps/WorkspaceStep.vue -->
<script setup lang="ts">
import { onMounted } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../../../api";
import { useOnboarding } from "../../../composables/useOnboarding";
import { useWorkspaces } from "../../../composables/useWorkspaces";

const ob = useOnboarding();
const { activeWorkspaceKey } = useWorkspaces();

// 已有激活工作区 → 自动跳过该步
onMounted(() => {
  if (activeWorkspaceKey.value) ob.advance();
});

async function pick() {
  const selected = await open({ directory: true, multiple: false });
  if (!selected) return; // 用户取消
  const path = typeof selected === "string" ? selected : (selected as any).path;
  await api.createWorkspace(path);
  ob.advance();
}
</script>

<template>
  <div class="eyebrow">02 / 04 · 工作区</div>
  <div class="headline">选一个文件夹开始</div>
  <div class="support">文件树、代码索引、运行配置都基于工作区。选一个项目文件夹——之后随时能换。</div>
  <div class="folder-pick" @click="pick">
    <span class="ic"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5Z"/></svg></span>
    <span class="txt"><span class="t">选择一个文件夹…</span><span class="s">或把文件夹拖到这里</span></span>
    <span class="br">浏览</span>
  </div>
</template>

<style scoped>
.eyebrow { font-size: 10px; color: var(--aide-accent); font-weight: 600; letter-spacing: .14em; text-transform: uppercase; }
.headline { font-size: 24px; font-weight: 600; letter-spacing: -.015em; color: var(--aide-text-primary); }
.support { font-size: 13px; color: var(--aide-text-secondary); line-height: 1.65; max-width: 440px; }
.folder-pick { width: 100%; max-width: 380px; display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-radius: var(--aide-radius-md); background: var(--aide-bg-deep); border: 1px solid var(--aide-border); box-shadow: var(--aide-highlight-inset); cursor: pointer; transition: all .16s var(--aide-ease); }
.folder-pick:hover { border-color: var(--aide-accent); box-shadow: var(--aide-highlight-inset), 0 0 0 2.5px rgba(150,170,255,.42); }
.folder-pick .ic { width: 22px; height: 22px; border-radius: 6px; background: var(--aide-surface-active); display: grid; place-items: center; color: var(--aide-accent); flex-shrink: 0; }
.folder-pick .ic svg { width: 13px; height: 13px; }
.folder-pick .txt { flex: 1; text-align: left; }
.folder-pick .txt .t { font-size: 12.5px; color: var(--aide-text-primary); font-weight: 500; }
.folder-pick .txt .s { font-size: 10.5px; color: var(--aide-text-muted); margin-top: 1px; }
.folder-pick .br { font-size: 11px; color: var(--aide-accent); font-weight: 500; }
</style>
```

> 拖拽落盘：v1 可只做点击选目录（拖拽涉及 WebView2 File.path 兜底 `api.stageDroppedFile`，复杂度高）。若要做拖拽，参考 ChatPanel 现有拖拽实现，drop 事件拿 path 后同样 `createWorkspace(path)`。本任务 v1 仅点击。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- src/components/onboarding/steps/WorkspaceStep.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/onboarding/steps/WorkspaceStep.vue src/components/onboarding/steps/WorkspaceStep.test.ts
git commit -m "feat(onboarding): WorkspaceStep 文件夹选择+createWorkspace+已有工作区自动跳过

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: `LoginStep` API key 路径 + `claude_credentials_exist` 命令 + 已登录自动跳过

**Files:**
- Create: `src-tauri/src/commands/onboarding.rs`
- Modify: `src-tauri/src/lib.rs:208`（注册命令）
- Modify: `src/api.ts`（加 `claudeCredentialsExist`）
- Modify: `src/components/onboarding/steps/LoginStep.vue`
- Create: `src/components/onboarding/steps/LoginStep.test.ts`

**Interfaces:**
- Consumes: `claude_home()`（`src-tauri/src/commands/mod.rs:206-208`）、`useProviders`（`apiKeyConfigured`）、SystemDefault `SecretMutation`（`ProviderSettings.vue:290-307` 范式）。
- Produces:
  - Rust `claude_credentials_exist() -> bool`（`~/.aide/claude/.credentials.json` 存在）。
  - 前端 `api.claudeCredentialsExist()`、`LoginStep` 渲染"用 Claude 账号登录"（本任务点击暂置灰/提示"即将支持"）+ "改用 API key"展开输入 + 保存（SecretMutation set）。已登录（credentials exist 或 apiKeyConfigured）自动跳过。

- [ ] **Step 1: 写失败测试——前端 LoginStep API key 保存 + 自动跳过**

```ts
// src/components/onboarding/steps/LoginStep.test.ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const credsExist = vi.fn();
vi.mock("../../../api", () => ({ api: { claudeCredentialsExist: () => credsExist() } }));
vi.mock("../../../composables/useProviders", () => ({
  useProviders: () => ({ systemDefault: { value: { apiKeyConfigured: false } } }),
  saveSystemDefaultApiKey: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../composables/useOnboarding", () => {
  const { ref } = require("vue");
  return { useOnboarding: () => ({ advance: vi.fn(), step: ref("login") }) };
});

import LoginStep from "./LoginStep.vue";

function mount() { const { mount: m } = require("@vue/test-utils"); return m(LoginStep, { attachTo: document.body }); }

describe("LoginStep", () => {
  beforeEach(() => credsExist.mockReset());

  it("无凭证时渲染 OAuth 主按钮 + API key 链接", async () => {
    credsExist.mockResolvedValue(false);
    const w = mount();
    await Promise.resolve();
    expect(w.find(".btn-primary").text()).toContain("用 Claude 账号登录");
    expect(w.find(".link").text()).toContain("改用 API key");
  });

  it("已有 credentials.json 时 mounted 即自动跳过", async () => {
    credsExist.mockResolvedValue(true);
    const { useOnboarding } = await import("../../../composables/useOnboarding");
    const advance = useOnboarding().advance as any;
    mount();
    await Promise.resolve();
    expect(advance).toHaveBeenCalled();
  });

  it("点 API key 链接展开输入框", async () => {
    credsExist.mockResolvedValue(false);
    const w = mount();
    await Promise.resolve();
    expect(w.find(".api-key-input").exists()).toBe(false);
    await w.find(".link").trigger("click");
    expect(w.find(".api-key-input").exists()).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- src/components/onboarding/steps/LoginStep.test.ts`
Expected: FAIL

- [ ] **Step 3: 后端命令 `claude_credentials_exist`**

```rust
// src-tauri/src/commands/onboarding.rs
use std::fs;
use crate::commands::claude_home;

#[tauri::command]
pub fn claude_credentials_exist() -> bool {
    fs::metadata(claude_home().join(".credentials.json")).map(|_| true).unwrap_or(false)
}
```

在 `src-tauri/src/lib.rs:208` 的 `generate_handler![` 列表里加 `commands::onboarding::claude_credentials_exist,`。在 `src/commands/mod.rs` 加 `pub mod onboarding;`（若不存在）。

- [ ] **Step 4: 前端 api + LoginStep**

`src/api.ts` 加：

```ts
  claudeCredentialsExist(): Promise<boolean> {
    return invoke("claude_credentials_exist");
  },
```

`src/components/onboarding/steps/LoginStep.vue`：

```vue
<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api } from "../../../api";
import { useOnboarding } from "../../../composables/useOnboarding";
import { useProviders, saveSystemDefaultApiKey } from "../../../composables/useProviders";

const ob = useOnboarding();
const { systemDefault } = useProviders();
const showApiKey = ref(false);
const apiKey = ref("");
const saving = ref(false);

onMounted(async () => {
  const credsExist = await api.claudeCredentialsExist();
  if (credsExist || systemDefault.value.apiKeyConfigured) ob.advance();
});

async function saveApiKey() {
  if (!apiKey.value) return;
  saving.value = true;
  await saveSystemDefaultApiKey(apiKey.value);
  saving.value = false;
  ob.advance();
}
</script>

<template>
  <div class="eyebrow">03 / 04 · 登录 Claude</div>
  <div class="headline">登录你的 Claude 账号</div>
  <div class="support">aide 需要凭证才能发消息、跑模型。用浏览器登录 Claude 账号最省事；没有账号也能用 API key。</div>
  <div class="login-stack">
    <button class="btn btn-primary" disabled>用 Claude 账号登录 <span class="ext">↗ 浏览器打开</span></button>
    <div class="divider">或</div>
    <span class="link" @click="showApiKey = true">改用 API key（去 console.anthropic.com 申请）</span>
    <template v-if="showApiKey">
      <input class="api-key-input" type="password" autocomplete="new-password" v-model="apiKey" placeholder="sk-ant-..." />
      <button class="btn btn-primary" :disabled="saving || !apiKey" @click="saveApiKey">保存</button>
    </template>
  </div>
</template>
```

> 注：`saveSystemDefaultApiKey` 若 `useProviders` 未导出此名，按 `ProviderSettings.vue:290-307` 的 SecretMutation set 路径实现一个薄封装（Task 实现时确认命名）。OAuth 主按钮本任务 `disabled`，Task 7 接入真实逻辑。

样式复用 spec §4.3 的 `.login-stack/.btn/.link/.divider/.api-key-input`（`.api-key-input` 同 `.text-input`：`width:100%; padding:8px 12px; background:var(--aide-bg-deep); border:1px solid var(--aide-border); border-radius:var(--aide-radius-md); color:var(--aide-text-primary); box-shadow:var(--aide-highlight-inset)`）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test -- src/components/onboarding/steps/LoginStep.test.ts`
Expected: PASS
Run: `cargo test --manifest-path src-tauri/Cargo.toml` → 编译通过

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/onboarding.rs src-tauri/src/lib.rs src/api.ts src/components/onboarding/steps/LoginStep.vue src/components/onboarding/steps/LoginStep.test.ts src/composables/useProviders.ts
git commit -m "feat(onboarding): LoginStep API key 路径+credentials-exist 检测+已登录自动跳过

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: LoginStep OAuth 路径（sidecar 控制通道 + Rust 命令 + A1 降级 + 迁移补漏）

> ⚠️ 本任务有真实不确定性：`claude_authenticate` 是未公开控制请求，首启动无现成会话。计划给出 A2→A1→API key 三级，实现时按实际探测结果落地，**降级到 API key only 是必须保证的兜底**。

**Files:**
- Create: `agent-sidecar/src/oauthLogin.ts` + `agent-sidecar/src/oauthLogin.test.ts`
- Modify: `agent-sidecar/src/session-worker.ts`（接入控制通道）
- Modify: `src-tauri/src/commands/onboarding.rs`（加 `claude_start_login`、`claude_login_wait`）
- Modify: `src-tauri/src/lib.rs:208`（注册）
- Modify: `src-tauri/src/commands/migration.rs:86-94`（MIGRATABLE_ENTRIES 加 `.credentials.json`）
- Modify: `src/api.ts`、`LoginStep.vue`

**Interfaces:**
- Produces:
  - sidecar `startOAuthLogin(): Promise<{ ok: boolean; authorizeUrl?: string; error?: string; method: "oauth"|"none" }>` — 在临时 query 会话上发 `claude_authenticate`，返回授权 URL；失败返回 `{ok:false, method:"none"}`。
  - Rust `claude_start_login() -> { authorizeUrl: Option<String>, degraded: bool }` → 调 sidecar；若 sidecar 返回 degraded=true，前端降级。
  - Rust `claude_login_wait(timeoutMs: u64) -> bool` → 轮询 credentials.json 出现。
  - A1 降级：若 A2 不可用，Rust 侧 spawn `claude.exe auth login --claudeai`（带 `CLAUDE_CONFIG_DIR` + Windows `CREATE_NO_WINDOW`），同样靠 credentials.json 出现判定。

- [ ] **Step 1: 写失败测试——sidecar oauthLogin 降级逻辑**

```ts
// agent-sidecar/src/oauthLogin.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const request = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => ({ request: (...a: any[]) => request(...a) })),
}));

import { startOAuthLogin } from "./oauthLogin";

describe("startOAuthLogin", () => {
  beforeEach(() => request.mockReset());

  it("A2 成功返回 authorizeUrl", async () => {
    request.mockResolvedValue({ manualUrl: "https://x/m", automaticUrl: "https://x/a" });
    const r = await startOAuthLogin();
    expect(r.ok).toBe(true);
    expect(r.authorizeUrl).toBe("https://x/a");
    expect(r.method).toBe("oauth");
  });

  it("A2 抛错/不支持 → 返回 ok:false, method:none（触发前端降级）", async () => {
    request.mockRejectedValue(new Error("unknown control request subtype"));
    const r = await startOAuthLogin();
    expect(r.ok).toBe(false);
    expect(r.method).toBe("none");
    expect(r.error).toContain("unknown");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- agent-sidecar/src/oauthLogin.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 sidecar oauthLogin.ts**

```ts
// agent-sidecar/src/oauthLogin.ts
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";

export type OAuthLoginResult =
  | { ok: true; method: "oauth"; authorizeUrl: string }
  | { ok: false; method: "none"; error: string };

export async function startOAuthLogin(): Promise<OAuthLoginResult> {
  try {
    // 临时会话承载控制请求：无 user message，仅发控制请求。
    // 实测若 SDK 要求首条 user message 才建会话，则此处无法 A2 → 返回 ok:false 触发 A1。
    const session: Query = query({
      pathToClaudeCodeExecutable: process.env.AIDE_CLAUDE_EXE,
      env: process.env as any,
    } as any);
    const resp: any = await (session as any).request({
      subtype: "claude_authenticate",
      loginWithClaudeAi: true,
    });
    const url = resp?.automaticUrl || resp?.manualUrl;
    if (!url) return { ok: false, method: "none", error: "no authorize url" };
    return { ok: true, method: "oauth", authorizeUrl: url };
  } catch (e: any) {
    return { ok: false, method: "none", error: String(e?.message ?? e) };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- agent-sidecar/src/oauthLogin.test.ts`
Expected: PASS

- [ ] **Step 5: Rust 命令 + A1 降级**

**实现前先读**：`src-tauri/src/commands/` 下 `set_permission_mode` 命令 + `src-tauri/src/runtime/` 侧把控制请求转发给 sidecar/claude.exe 的那段 stdio 代理逻辑，照其结构落地 `crate::runtime::start_oauth_login()`（向 sidecar 发 `claude_authenticate` 控制请求、收 `{automaticUrl}` 响应）。`claude_exe_path()` 复用 runtime 已有的 claude.exe 路径解析。

在 `src-tauri/src/commands/onboarding.rs` 加：

```rust
use std::process::Command;
use std::time::{Duration, Instant};

#[tauri::command]
pub async fn claude_start_login() -> Result<LoginStartResult, String> {
    // A2: 调 sidecar 控制通道（经 runtime 代理）——成功返回 authorizeUrl
    if let Some(url) = crate::runtime::start_oauth_login().await.ok().flatten() {
        return Ok(LoginStartResult { authorize_url: Some(url), degraded: false });
    }
    // A1: A2 不可用 → spawn claude.exe auth login（带 CLAUDE_CONFIG_DIR + CREATE_NO_WINDOW）
    let claude_exe = crate::runtime::claude_exe_path();
    let mut cmd = Command::new(claude_exe);
    cmd.args(["auth", "login", "--claudeai"])
        .env("CLAUDE_CONFIG_DIR", crate::commands::claude_home().to_string_lossy().to_string());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(LoginStartResult { authorize_url: None, degraded: true })
}

#[tauri::command]
pub async fn claude_login_wait(timeout_ms: u64) -> Result<bool, String> {
    let path = crate::commands::claude_home().join(".credentials.json");
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    while Instant::now() < deadline {
        if std::fs::metadata(&path).is_ok() { return Ok(true); }
        std::thread::sleep(Duration::from_millis(500));
    }
    Ok(false)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]   // authorize_url → authorizeUrl，对齐 api.ts
pub struct LoginStartResult { pub authorize_url: Option<String>, pub degraded: bool }
```

注册到 `lib.rs:208` 的 `generate_handler!`：`commands::onboarding::claude_start_login, commands::onboarding::claude_login_wait,`。

`src/api.ts` 加：

```ts
  claudeStartLogin(): Promise<{ authorizeUrl: string | null; degraded: boolean }> {
    return invoke("claude_start_login");
  },
  claudeLoginWait(timeoutMs: number): Promise<boolean> {
    return invoke("claude_login_wait", { timeoutMs });
  },
```

`LoginStep.vue` 接入：点 OAuth 主按钮 → `const r = await api.claudeStartLogin()` → 若 `r.authorizeUrl` 用 `@tauri-apps/plugin-shell` `open(url)` 打开浏览器 → `await api.claudeLoginWait(120000)` 轮询 credentials.json → 成功 `ob.advance()`；若 `r.degraded`（A2 失败、A1 已 spawn），同样 `claudeLoginWait` 等 credentials.json → 成功推进；`claudeLoginWait` 超时仍无凭证 → 降级为 API key only（隐藏 OAuth 按钮，显"浏览器登录暂不可用，请改用 API key"）。

- [ ] **Step 6: 迁移补漏**

`src-tauri/src/commands/migration.rs:86-94` 的 `MIGRATABLE_ENTRIES` 数组加：

```rust
        ".credentials.json",
```

若有现成迁移测试（`migration.rs` 内 `#[cfg(test)]` 或独立测试），加一条断言 `.credentials.json` 在列表里；否则加：

```rust
#[cfg(test)]
mod tests {
    use super::MIGRATABLE_ENTRIES;
    #[test]
    fn credentials_json_is_migratable() {
        assert!(MIGRATABLE_ENTRIES.iter().any(|e| *e == ".credentials.json"));
    }
}
```

- [ ] **Step 7: 跑测试 + 手动验证 OAuth**

Run: `pnpm test -- agent-sidecar/src/oauthLogin.test.ts` → PASS
Run: `cargo test --manifest-path src-tauri/Cargo.toml` → PASS

手动验证（必做，OAuth 无法单元测试全链路）：
1. 删 `~/.aide/claude/.credentials.json` + `settings.json.onboarded=false` → `pnpm tauri dev`
2. 走到登录步 → 点"用 Claude 账号登录" → 浏览器打开 → 登录 → 回到 aide → credentials.json 出现 → 自动推进到模型步。
3. 若 A2 在当前 claude.exe 版本不可用 → 观察是否走 A1（spawn `claude auth login`）→ 若 A1 也失败 → 登录步降级显示"浏览器登录暂不可用"+只剩 API key 入口。
4. 记录实际走的路径，按需调整 `startOAuthLogin` 与 Rust 降级判定。

- [ ] **Step 8: Commit**

```bash
git add agent-sidecar/src/oauthLogin.ts agent-sidecar/src/oauthLogin.test.ts agent-sidecar/src/session-worker.ts src-tauri/src/commands/onboarding.rs src-tauri/src/commands/migration.rs src-tauri/src/lib.rs src/api.ts src/components/onboarding/steps/LoginStep.vue
git commit -m "feat(onboarding): LoginStep OAuth(claude_authenticate 控制通道)+A1 降级+迁移补漏 credentials.json

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: `ModelStep`（下拉选模型 + update + hint）

**Files:**
- Modify: `src/components/onboarding/steps/ModelStep.vue`
- Create: `src/components/onboarding/steps/ModelStep.test.ts`

**Interfaces:**
- Consumes: `useSettings`（`settings.model`、`update`）、默认模型列表（`api.getDefaultModels()` 或 `refreshSystemDefaultModels` 结果）。
- Produces: 渲染当前模型 + ThemedSelect 下拉 → 改选调 `update({ model })`。

- [ ] **Step 1: 写失败测试**

```ts
// src/components/onboarding/steps/ModelStep.test.ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
const update = vi.fn();
vi.mock("../../../composables/useSettings", () => ({
  useSettings: () => ({
    settings: { model: "claude-sonnet-5" },
    update: (...a: any[]) => update(...a),
  }),
}));
vi.mock("../../../api", () => ({ api: { getDefaultModels: vi.fn().mockResolvedValue([
  { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
]) } }));
import ModelStep from "./ModelStep.vue";
function mount() { const { mount: m } = require("@vue/test-utils"); return m(ModelStep, { attachTo: document.body }); }

describe("ModelStep", () => {
  it("渲染当前模型名 + hint", async () => {
    const w = mount();
    await Promise.resolve();
    expect(w.find(".model-pick .t").text()).toContain("Claude Sonnet 5");
    expect(w.find(".model-hint").text()).toContain("供应商");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- src/components/onboarding/steps/ModelStep.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 ModelStep.vue**

```vue
<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { api } from "../../../api";
import { useSettings } from "../../../composables/useSettings";
import ThemedSelect from "../../ThemedSelect.vue";

const { settings, update } = useSettings();
const models = ref<{ value: string; label: string }[]>([]);

onMounted(async () => {
  models.value = (await api.getDefaultModels()) as any;
});

const current = computed(() => models.value.find(m => m.value === settings.model) ?? models.value[0]);

async function onChange(v: string) {
  await update({ model: v });
}
</script>

<template>
  <div class="eyebrow">04 / 04 · 模型</div>
  <div class="headline">用哪个模型？</div>
  <div class="support">已从你的供应商加载可用模型。默认这个就很好，随时能在设置里换。</div>
  <div class="model-row">
    <div class="model-pick">
      <span class="lbl"><span class="t">{{ current?.label ?? settings.model }}</span><span class="s">来自 Anthropic · 默认</span></span>
      <ThemedSelect :model-value="settings.model" :options="models" block @update:model-value="onChange" />
    </div>
    <div class="model-hint">模型来自你的供应商。在设置 → 模型里可加更多供应商、换默认模型。</div>
  </div>
</template>

<style scoped>
.eyebrow { font-size: 10px; color: var(--aide-accent); font-weight: 600; letter-spacing: .14em; text-transform: uppercase; }
.headline { font-size: 24px; font-weight: 600; letter-spacing: -.015em; color: var(--aide-text-primary); }
.support { font-size: 13px; color: var(--aide-text-secondary); line-height: 1.65; max-width: 440px; }
.model-row { width: 100%; max-width: 380px; }
.model-pick { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: var(--aide-radius-md); background: var(--aide-bg-deep); border: 1px solid var(--aide-border); box-shadow: var(--aide-highlight-inset); }
.model-pick .lbl .t { font-size: 12.5px; color: var(--aide-text-primary); font-weight: 500; }
.model-pick .lbl .s { font-size: 10.5px; color: var(--aide-text-muted); margin-top: 1px; }
.model-hint { font-size: 10.5px; color: var(--aide-text-muted); margin-top: 8px; text-align: left; }
</style>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- src/components/onboarding/steps/ModelStep.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/onboarding/steps/ModelStep.vue src/components/onboarding/steps/ModelStep.test.ts
git commit -m "feat(onboarding): ModelStep 模型下拉+update+供应商认知 hint

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: 上下文兜底——无凭证首条消息拦截 + 引导卡片

**Files:**
- Modify: `src/composables/useChatSession.ts:986-1003`（发送前拦截）
- Create: `src/composables/useChatSession.onboarding.test.ts`（补丁测试，避免动现有 listener 测试）

**Interfaces:**
- Consumes: `useProviders`（`apiKeyConfigured`）、`api.claudeCredentialsExist`、`useOnboarding.openAt("login")`。
- Produces: 发送前若 `!apiKeyConfigured && !credentialsExist` → 拦截，在聊天区插一张系统卡片 `"还没登录 Claude——发消息需要凭证"` + "去登录"按钮（按钮调 `useOnboarding().openAt("login")`）；否则正常发。

- [ ] **Step 1: 写失败测试**

```ts
// src/composables/useChatSession.onboarding.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";

const credsExist = vi.fn();
const openAt = vi.fn();
vi.mock("../api", () => ({ api: { claudeCredentialsExist: () => credsExist() } }));
vi.mock("./useProviders", () => ({
  useProviders: () => ({ systemDefault: { value: { apiKeyConfigured: false } } }),
}));
vi.mock("./useOnboarding", () => ({ useOnboarding: () => ({ openAt: (...a: any[]) => openAt(...a) }) }));

// 只测导出的 canSendOrPrompt 函数（见 Step 3）
import { canSendOrPrompt } from "./useChatSession";

describe("canSendOrPrompt 无凭证拦截", () => {
  beforeEach(() => { credsExist.mockReset(); openAt.mockReset(); });

  it("无凭证 → 返回 false（拦截）", async () => {
    credsExist.mockResolvedValue(false);
    const r = await canSendOrPrompt();
    expect(r).toBe(false);
  });

  it("有 credentials.json → 返回 true（放行）", async () => {
    credsExist.mockResolvedValue(true);
    const r = await canSendOrPrompt();
    expect(r).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- src/composables/useChatSession.onboarding.test.ts`
Expected: FAIL（`canSendOrPrompt` 未导出）

- [ ] **Step 3: 实现**

在 `src/composables/useChatSession.ts` 顶部 import + 导出 `canSendOrPrompt`，并在发送入口（`986-1003` 附近，真实发送前）调用：

```ts
import { useProviders } from "./useProviders";
import { useOnboarding } from "./useOnboarding";

export async function canSendOrPrompt(): Promise<boolean> {
  const { systemDefault } = useProviders();
  if (systemDefault.value.apiKeyConfigured) return true;
  const credsExist = await api.claudeCredentialsExist();
  if (credsExist) return true;
  // 拦截：插引导卡片 + 提示
  useOnboarding().openAt("login");
  return false;
}
```

在真实发送函数（`986-1003` 的发送路径）开头加：

```ts
  if (!(await canSendOrPrompt())) {
    // 插一张系统卡片到 messages（参考现有 system-error 卡片范式）
    messages.push({ role: "system", kind: "auth-required", text: "还没登录 Claude——发消息需要凭证", } as any);
    return;
  }
```

> 具体卡片渲染：若聊天区有现成 system-card 渲染分支，加一个 `kind: "auth-required"`；渲染时显示文案 + "去登录"按钮（`@click="useOnboarding().openAt('login')"`）。实现时按 `ChatPanel.vue` 现有 system 消息渲染分支扩展。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- src/composables/useChatSession.onboarding.test.ts`
Expected: PASS
Run: `pnpm test -- src/composables/useChatSession.listener.test.ts` → 既有测试不回归

- [ ] **Step 5: Commit**

```bash
git add src/composables/useChatSession.ts src/composables/useChatSession.onboarding.test.ts src/components/ChatPanel.vue
git commit -m "feat(onboarding): 无凭证首条消息拦截+引导卡片(不再裸 401)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: 上下文兜底——空工作区 FileTree 引导按钮 + SettingsPanel 再入口按钮

**Files:**
- Modify: `src/components/FileTree.vue:145-153`
- Modify: `src/components/SettingsPanel.vue`（关于 tab）
- Create: `src/components/FileTree.onboarding.test.ts`（若 FileTree 已有测试则补到既有文件）

**Interfaces:**
- Consumes: `useOnboarding.openAt("workspace")`、`useSettings.update({onboarded:false})` + `useOnboarding.open()`（再入口）。
- Produces: FileTree 空态加"选一个工作区"按钮；SettingsPanel 关于 tab 加"重新运行首次引导"按钮。

- [ ] **Step 1: 写失败测试——SettingsPanel 再入口按钮**

```ts
// src/components/SettingsPanel.reentry.test.ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
const update = vi.fn(); const open = vi.fn();
vi.mock("../composables/useSettings", () => ({ useSettings: () => ({ update: (...a:any[])=>update(...a), settings: { onboarded: true } }) }));
vi.mock("../composables/useOnboarding", () => ({ useOnboarding: () => ({ open: (...a:any[])=>open(...a) }) }));
import SettingsPanel from "./SettingsPanel.vue";
function mount(){ const { mount:m } = require("@vue/test-utils"); return m(SettingsPanel, { attachTo: document.body, global:{ stubs:{ Teleport:{ template:"<div><slot/></div>" } } } }); }

describe("SettingsPanel 再入口", () => {
  it("关于 tab 有「重新运行首次引导」按钮，点击 update({onboarded:false})+open()", async () => {
    const w = mount();
    // 切到关于 tab（按现有 tab 机制触发；若默认 tab 不是关于，先点关于 nav）
    const aboutNav = w.findAll(".nav-item").find(n => n.text().includes("关于"));
    if (aboutNav) await aboutNav.trigger("click");
    const btn = w.find(".rerun-onboarding");
    expect(btn.exists()).toBe(true);
    await btn.trigger("click");
    expect(update).toHaveBeenCalledWith({ onboarded: false });
    expect(open).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- src/components/SettingsPanel.reentry.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/components/FileTree.vue:145-153` 空态文案区加：

```html
    <button class="onboard-ws-btn" @click="useOnboarding().openAt('workspace')">选一个工作区</button>
```

（import `useOnboarding`；样式复用 ghost button 范式）

`src/components/SettingsPanel.vue` 关于 tab 内容区加：

```html
    <button class="rerun-onboarding" @click="rerunOnboarding">重新运行首次引导</button>
```

```ts
import { useOnboarding } from "../composables/useOnboarding";
function rerunOnboarding() {
  update({ onboarded: false });
  useOnboarding().open();
  // 关闭设置面板（复用现有 close 逻辑）
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- src/components/SettingsPanel.reentry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/FileTree.vue src/components/SettingsPanel.vue src/components/SettingsPanel.reentry.test.ts
git commit -m "feat(onboarding): 空工作区 FileTree 引导按钮+SettingsPanel 重新运行引导入口

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: 字形补齐 + 全量回归 + 验收清单核对

**Files:**
- Modify: `src/utils/icons.ts`（缺则补 `folder`/`login` 字形）
- 无新测试（字形是数据，被 Icon 组件现有测试覆盖）

**Interfaces:**
- Produces: `GLYPHS` 含 onboarding 用到的所有字形 key，`Icon` 渲染不报缺字形。

- [ ] **Step 1: 核对字形**

读 `src/utils/icons.ts` 的 `GLYPHS`，确认 `folder`、`key`、`model`、`login`（或用 `provider`）存在。缺则补 SVG path（16×16 viewBox，1.5–1.6 stroke，currentColor）。参考现有 `provider`/`key` 字形写法。

- [ ] **Step 2: 全量回归**

Run: `pnpm test` → 全绿
Run: `pnpm build`（`vue-tsc --noEmit && vite build`）→ 类型 + 构建通过
Run: `cargo test --manifest-path src-tauri/Cargo.toml` → 全绿

- [ ] **Step 3: 验收清单手动核对**（spec §11）

- [ ] 全新用户首启 → 自动弹向导，走完 4 步能发消息且文件树可用
- [ ] 任意步"跳过" → 进 app 可浏览；发消息撞缺口 → 引导卡片不裸错
- [ ] "跳过引导" → 进 app、`onboarded=true`、下次不弹
- [ ] 老用户（`onboarded=true`）首启 → 不弹
- [ ] 已有 OAuth 凭证 → 登录步自动跳过
- [ ] OAuth 降级：A2 失败试 A1，A1 失败显 API key only + 文案
- [ ] SettingsPanel 关于 tab"重新运行首次引导"→ 重弹向导
- [ ] 切主题在向导期间即时生效
- [ ] `prefers-reduced-motion` → 动效静止

- [ ] **Step 4: Commit**

```bash
git add src/utils/icons.ts
git commit -m "chore(onboarding): 补齐 onboarding 用字形+全量回归通过

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Final Verification

实现全部 11 个任务后，对照 spec §11 验收要点逐条手动核对（Task 11 Step 3 清单）。重点回归：
- 不破坏既有 `useChatSession.listener.test.ts` / `SettingsPanel.test.ts` / `ModalDialog.test.ts`。
- `pnpm build` 类型通过（OnboardingWizard import、useOnboarding 类型、api.ts 新方法签名）。
- `cargo test` 通过（schema_test 已知键含 `onboarded`、migration 含 `.credentials.json`）。
- 真实 OAuth 链路在 `pnpm tauri dev` 下手动验证一次（Task 7 Step 7）。

## Risks（实现时关注）

- **Task 7 OAuth 控制通道**：`claude_authenticate` 未公开 + 临时会话引导不确定。**兜底是 API key only，必须保证能降级**。实测后若 A2/A1 都不可用，Task 6 的 API key 路径已是完整可用登录方式，OAuth 留作后续 enhancement。
- **Task 9 聊天卡片**：`kind: "auth-required"` 卡片需在 `ChatPanel.vue` 现有 system 消息渲染分支扩展，注意不破坏既有 system-error 渲染。
- **设置分层**：Task 1 必须前后端三层同步，漏一层会导致默认值挡死（项目记忆）。