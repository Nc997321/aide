# Multimodal Image Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户能把截图/图片粘贴到 Chat 输入框，Claude 分析图片内容，修复当前的 `node:internal/modules/cjs/loader:1433` 崩溃。

**Architecture:** 剪贴板图片经 Rust 保存为临时 PNG → `read_file_base64` 读出 base64 → 前端显示缩略图 → `buildUserMessage()` 把图片转成 Anthropic `ImageBlockParam` 格式交给 Claude Agent SDK。关键抽象：`buildUserMessage` 在 `mapper.ts` 中是 Claude 专用实现，未来 Codex/OpenCode sidecar 只需替换这一个函数，其余层（Rust、Vue、useChatSession）零改动。

**Tech Stack:** Rust (`base64 = "0.22"`), TypeScript (Claude Agent SDK `MessageParam`), Vue 3 Composition API

## Global Constraints

- `ImageAttachment { data: string; mediaType: string }` — 全链路 provider-agnostic 共用类型，不含任何 SDK 专属字段
- Rust `send_message` 命令新增参数 `images: Option<Vec<serde_json::Value>>`，透传 JSON 不做任何转换
- `buildUserMessage` 仅在 `agent-sidecar/src/mapper.ts` 中感知 Claude SDK 格式 — 这是唯一需要修改以支持新 AI provider 的地方
- Windows `CREATE_NO_WINDOW`：本次无新增 `Command::new()`，不适用
- `base64 = "0.22"` — 新增 Rust crate
- 前端 `previewUrl` 用 `data:image/png;base64,...` 格式，不用 Blob URL（无需清理）
- `resolvePastePayload` 返回类型改为 `PasteResolution { text: string; imagePaths: string[] }`，破坏性变更，需同步更新测试和调用处

---

### Task 1: Rust `read_file_base64` 命令

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/commands/filesystem.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/api.ts`

**Interfaces:**
- Produces: `read_file_base64(path: String) -> Result<String, String>` — 文件字节编码为 base64 字符串（不含 `data:` 前缀）
- Produces: `api.readFileBase64(path: string): Promise<string>`

- [ ] **Step 1: 在 `src-tauri/Cargo.toml` 的 `[dependencies]` 末尾加 `base64`**

```toml
base64 = "0.22"
```

- [ ] **Step 2: 在 `src-tauri/src/commands/filesystem.rs` 末尾写失败测试**

在文件最末尾追加（保留现有代码不动）：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    #[test]
    fn test_read_file_base64_roundtrip() {
        let dir = std::env::temp_dir().join("aide_test_b64");
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("test.png");
        let bytes: &[u8] = &[137, 80, 78, 71, 13, 10, 26, 10]; // PNG magic bytes
        fs::write(&path, bytes).unwrap();

        let result = read_file_base64(path.to_string_lossy().to_string()).unwrap();
        use base64::Engine;
        let decoded = base64::engine::general_purpose::STANDARD.decode(&result).unwrap();
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn test_read_file_base64_missing_file() {
        let result = read_file_base64("/nonexistent/path/img.png".to_string());
        assert!(result.is_err());
    }
}
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd src-tauri && cargo test filesystem::tests
```

Expected: `error[E0425]: cannot find function 'read_file_base64'`

- [ ] **Step 4: 在 `src-tauri/src/commands/filesystem.rs` 中加入命令实现**

在 `read_file_content` 函数之后、`read_file_binary` 之前插入：

```rust
#[tauri::command]
pub fn read_file_base64(path: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}
```

在文件顶部 `use std::fs;` 已存在；需要确认是否有 `use base64;` — 不需要，直接通过完整路径引用即可。

- [ ] **Step 5: 运行测试确认通过**

```bash
cd src-tauri && cargo test filesystem::tests
```

Expected: `test filesystem::tests::test_read_file_base64_roundtrip ... ok`  
Expected: `test filesystem::tests::test_read_file_base64_missing_file ... ok`

- [ ] **Step 6: 在 `src-tauri/src/lib.rs` 的 `generate_handler!` 中注册命令**

找到 `commands::filesystem::read_file_binary,` 这一行，在其后插入：

```rust
commands::filesystem::read_file_base64,
```

- [ ] **Step 7: 在 `src/api.ts` 中加入前端封装**

找到 `readFileContent` 方法，在其后插入：

```typescript
readFileBase64(path: string): Promise<string> {
  return invoke<string>("read_file_base64", { path });
},
```

- [ ] **Step 8: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/commands/filesystem.rs src-tauri/src/lib.rs src/api.ts
git commit -m "feat(image): add read_file_base64 Tauri command"
```

---

### Task 2: Sidecar — `ImageAttachment` 类型 + `buildUserMessage` 抽象

**Files:**
- Modify: `agent-sidecar/src/types.ts`
- Modify: `agent-sidecar/src/mapper.ts`
- Modify: `agent-sidecar/src/index.ts`

**Interfaces:**
- Consumes: `ImageAttachment { data: string; mediaType: string }` — 来自 Rust `send` 命令的 `images` 字段
- Produces: `buildUserMessage(prompt: string, images: ImageAttachment[]): MessageParam` — 将 provider-agnostic 数据转成 Anthropic SDK 的 `MessageParam`

- [ ] **Step 1: 更新 `agent-sidecar/src/types.ts`**

在文件末尾追加，并更新 `SidecarCommand` 的 `send` 分支：

```typescript
// Provider-agnostic image attachment — same shape used by all future AI providers
export interface ImageAttachment {
  data: string;       // base64-encoded bytes, no data: prefix
  mediaType: string;  // "image/png" | "image/jpeg" | "image/gif" | "image/webp"
}

// 替换原有的 send 分支：
// | { cmd: "send"; prompt: string; session_id?: string; cwd?: string }
// 改为：
// | { cmd: "send"; prompt: string; images?: ImageAttachment[]; session_id?: string; cwd?: string }
```

完整更新后的 `SidecarCommand`：

```typescript
export type SidecarCommand =
  | { cmd: "send"; prompt: string; images?: ImageAttachment[]; session_id?: string; cwd?: string }
  | { cmd: "permission_response"; id: string; approved: boolean }
  | { cmd: "interrupt" };
```

- [ ] **Step 2: 在 `agent-sidecar/src/mapper.ts` 中添加 `buildUserMessage`**

在文件顶部添加 import，在 `mapSdkMessage` 函数之前添加 `buildUserMessage`：

```typescript
import type { MessageParam } from "@anthropic-ai/sdk/resources";
import type { ImageAttachment } from "./types.js";
```

```typescript
/**
 * Build a Claude-SDK MessageParam from a prompt + optional image attachments.
 *
 * This is the ONLY place in the codebase that knows about Anthropic's
 * ImageBlockParam format. To add a new AI provider, create a new sidecar
 * with its own buildUserMessage — the Rust layer and Vue frontend are
 * provider-agnostic.
 */
export function buildUserMessage(
  prompt: string,
  images: ImageAttachment[],
): MessageParam {
  if (images.length === 0) {
    return { role: "user", content: prompt };
  }
  const blocks: Array<Record<string, unknown>> = images.map((img) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: img.mediaType,
      data: img.data,
    },
  }));
  if (prompt) {
    blocks.push({ type: "text", text: prompt });
  }
  return { role: "user", content: blocks as any };
}
```

- [ ] **Step 3: 更新 `agent-sidecar/src/index.ts` 使用 `buildUserMessage`**

在顶部 import 块中添加：

```typescript
import { mapSdkMessage, buildUserMessage } from "./mapper.js";
```

找到：

```typescript
queue.push({
  type: "user",
  message: { role: "user", content: cmd.prompt },
  parent_tool_use_id: null,
} as any);
```

替换为：

```typescript
queue.push({
  type: "user",
  message: buildUserMessage(cmd.prompt, cmd.images ?? []),
  parent_tool_use_id: null,
} as any);
```

- [ ] **Step 4: 重新编译 sidecar**

```bash
cd agent-sidecar && npm run build
```

Expected: 无 TypeScript 错误，`dist/sidecar.js` 更新时间戳刷新。

- [ ] **Step 5: Commit**

```bash
git add agent-sidecar/src/types.ts agent-sidecar/src/mapper.ts agent-sidecar/src/index.ts agent-sidecar/dist/sidecar.js
git commit -m "feat(image): add buildUserMessage abstraction in sidecar mapper"
```

---

### Task 3: 前端类型 + Rust `send_message` + `useChatSession` + `App.vue`

**Files:**
- Modify: `src/types/chat.ts`
- Modify: `src-tauri/src/commands/chat.rs`
- Modify: `src/composables/useChatSession.ts`
- Modify: `src/App.vue`

**Interfaces:**
- Consumes: `ImageAttachment` from Task 2 (provider-agnostic, identical shape)
- Produces:
  - `ImageBlock { type: "image"; data: string; mediaType: string }` — 消息历史中显示图片
  - `useChatSession.sendMessage(prompt: string, images?: ImageAttachment[], resumeId?: string)`
  - Rust `send_message` 新增参数 `images: Option<Vec<serde_json::Value>>`

- [ ] **Step 1: 更新 `src/types/chat.ts`**

在 `ToolCallBlock` 之后插入 `ImageBlock`，更新 `ContentBlock`：

```typescript
export interface ImageBlock {
  type: "image";
  data: string;      // base64
  mediaType: string; // "image/png" | ...
}

export type ContentBlock = TextBlock | ToolCallBlock | ImageBlock;
```

`ChatMessage` 不需要改（`blocks: ContentBlock[]` 已经包含新类型）。

- [ ] **Step 2: 更新 `src-tauri/src/commands/chat.rs` 中的 `send_message`**

函数签名添加 `images` 参数，body 中拼入 JSON：

```rust
#[tauri::command]
pub async fn send_message(
    session_id: String,
    prompt: String,
    images: Option<Vec<serde_json::Value>>,
    resume_id: Option<String>,
    sidecar_mgr: State<'_, SidecarManager>,
    workspace_state: State<'_, WorkspaceState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // ... 现有的 spawn 逻辑不变 ...

    let cwd = project_root_for_commands(&workspace_state)
        .to_string_lossy()
        .to_string();
    let mut cmd = json!({
        "cmd": "send",
        "prompt": prompt,
        "cwd": cwd,
    });
    if let Some(imgs) = images {
        if !imgs.is_empty() {
            cmd["images"] = json!(imgs);
        }
    }
    if let Some(rid) = resume_id {
        cmd["session_id"] = json!(rid);
    }
    sidecar_mgr.send(&session_id, &cmd).await
}
```

注意：`// ... 现有的 spawn 逻辑不变 ...` 指函数开头的 `if !sidecar_mgr.has_session` 代码块，原样保留。

- [ ] **Step 3: 更新 `src/composables/useChatSession.ts` 的 `sendMessage`**

首先在文件顶部 import 中添加 `ImageBlock`：

```typescript
import type {
  ChatMessage,
  PermissionRequest,
  TextBlock,
  ToolCallBlock,
  ImageBlock,
} from "../types/chat";
```

在文件顶部（import 之后）定义共用类型，避免重复：

```typescript
export interface ImageAttachment {
  data: string;
  mediaType: string;
}
```

更新 `sendMessage` 签名和 user message 构建：

```typescript
async function sendMessage(
  prompt: string,
  images?: ImageAttachment[],
  resumeId?: string,
) {
  const sid = sessionId.value;
  if (!sid) return;

  await ensureGlobalListener();

  isBusy.value = true;
  setSessionState(sid, "running");

  // 构建消息历史块（图片在前，文字在后）
  const blocks: (ImageBlock | TextBlock)[] = [
    ...(images ?? []).map((img): ImageBlock => ({
      type: "image",
      data: img.data,
      mediaType: img.mediaType,
    })),
    ...(prompt ? [{ type: "text" as const, text: prompt }] : []),
  ];
  messages.value.push({
    id: crypto.randomUUID(),
    role: "user",
    blocks,
    timestamp: Date.now(),
  });
  currentAssistantMsg = null;

  registerHandlers(sid);
  const resolvedResumeId = resumeId ?? sdkSessionMap.get(sid);
  await invoke("send_message", {
    sessionId: sid,
    prompt,
    images: images?.length ? images : null,
    resumeId: resolvedResumeId,
  });
}
```

- [ ] **Step 4: 更新 `src/App.vue` 中 `@send` 事件处理**

找到：

```typescript
@send="(prompt: string) => sendMessage(prompt)"
```

替换为：

```typescript
@send="(prompt: string, images?: ImageAttachment[]) => sendMessage(prompt, images)"
```

若 `App.vue` 顶部没有 import `ImageAttachment`，在 script 块中补充：

```typescript
import type { ImageAttachment } from "@/composables/useChatSession";
```

- [ ] **Step 5: TypeScript 检查**

```bash
cd c:/Users/<user>/IdeaProjects/aide && npx tsc --noEmit 2>&1 | grep -v "ui/index.ts"
```

Expected: 无输出（仅 `ui/index.ts` 的已知 TS2614 错误允许出现）。

- [ ] **Step 6: Commit**

```bash
git add src/types/chat.ts src-tauri/src/commands/chat.rs src/composables/useChatSession.ts src/App.vue
git commit -m "feat(image): wire ImageAttachment through Rust, useChatSession, and App.vue"
```

---

### Task 4: 前端 paste 重构 + ChatPanel 图片输入 + ChatMessage 渲染

**Files:**
- Modify: `src/utils/paste.ts`
- Modify: `src/utils/paste.test.ts`
- Modify: `src/components/ChatPanel.vue`
- Modify: `src/components/ChatMessage.vue`

**Interfaces:**
- Consumes: `api.readFileBase64(path): Promise<string>` (Task 1)
- Consumes: `ImageAttachment` from `useChatSession` (Task 3)
- Consumes: `emit("send", prompt, images?)` — App.vue 层已更新 (Task 3)
- Produces: `PasteResolution { text: string; imagePaths: string[] }` — paste.ts 新返回类型

- [ ] **Step 1: 重写 `src/utils/paste.ts`**

完整替换文件内容（保留 `ClipboardEntry` import）：

```typescript
import type { ClipboardEntry } from "../composables/useFileClipboard";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".tiff"]);

function isImagePath(path: string): boolean {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot !== -1 && IMAGE_EXTENSIONS.has(lower.slice(dot));
}

export interface PasteResolution {
  text: string;        // @file references or plain text to insert in textarea
  imagePaths: string[]; // paths of image files to convert to attachments
}

/**
 * Resolve clipboard paste into text payload (@path refs / plain text)
 * and image paths (to be base64-encoded and sent as image attachments).
 *
 * Priority: OS files > clipboard image > in-app file-tree copy > plain text.
 * Image files from OS clipboard go to imagePaths, not @path text.
 */
export function resolvePastePayload(
  files: string[],
  img: string | null,
  entry: ClipboardEntry | null,
  text: string,
): PasteResolution {
  if (files.length > 0) {
    const textFiles = files.filter((f) => !isImagePath(f));
    const imageFiles = files.filter(isImagePath);
    return {
      text: textFiles.length > 0 ? textFiles.map((p) => `@${p}`).join(" ") + " " : "",
      imagePaths: imageFiles,
    };
  }
  if (img) {
    return { text: "", imagePaths: [img] };
  }
  if (entry && entry.op === "copy") {
    return { text: `@${entry.path} `, imagePaths: [] };
  }
  return { text, imagePaths: [] };
}
```

- [ ] **Step 2: 更新 `src/utils/paste.test.ts`**

完整替换文件内容：

```typescript
import { describe, it, expect } from "vitest";
import { resolvePastePayload } from "./paste";
import type { ClipboardEntry } from "../composables/useFileClipboard";

describe("resolvePastePayload", () => {
  it("splits OS files: text files become @path, image files become imagePaths", () => {
    const r = resolvePastePayload(["C:\\a.png", "C:\\b.ts"], null, null, "x");
    expect(r.text).toBe("@C:\\b.ts ");
    expect(r.imagePaths).toEqual(["C:\\a.png"]);
  });

  it("all OS files are images: text is empty, all go to imagePaths", () => {
    const r = resolvePastePayload(["C:\\a.png", "C:\\b.jpg"], null, null, "x");
    expect(r.text).toBe("");
    expect(r.imagePaths).toEqual(["C:\\a.png", "C:\\b.jpg"]);
  });

  it("all OS files are text: imagePaths is empty", () => {
    const r = resolvePastePayload(["C:\\a.ts", "C:\\b.rs"], null, null, "x");
    expect(r.text).toBe("@C:\\a.ts @C:\\b.rs ");
    expect(r.imagePaths).toEqual([]);
  });

  it("clipboard image goes to imagePaths, text is empty", () => {
    const r = resolvePastePayload([], "/tmp/aide-clipboard/img-1.png", null, "x");
    expect(r.text).toBe("");
    expect(r.imagePaths).toEqual(["/tmp/aide-clipboard/img-1.png"]);
  });

  it("in-app copy entry becomes @path text, no imagePaths", () => {
    const entry: ClipboardEntry = { op: "copy", path: "/proj/f.ts" };
    const r = resolvePastePayload([], null, entry, "x");
    expect(r.text).toBe("@/proj/f.ts ");
    expect(r.imagePaths).toEqual([]);
  });

  it("in-app cut entry is ignored, falls through to plain text", () => {
    const entry: ClipboardEntry = { op: "cut", path: "/proj/f.ts" };
    const r = resolvePastePayload([], null, entry, "fallback");
    expect(r.text).toBe("fallback");
    expect(r.imagePaths).toEqual([]);
  });

  it("plain text fallback", () => {
    const r = resolvePastePayload([], null, null, "hello\nworld");
    expect(r.text).toBe("hello\nworld");
    expect(r.imagePaths).toEqual([]);
  });

  it("empty everything returns empty resolution", () => {
    const r = resolvePastePayload([], null, null, "");
    expect(r.text).toBe("");
    expect(r.imagePaths).toEqual([]);
  });
});
```

- [ ] **Step 3: 运行 paste 测试**

```bash
cd c:/Users/<user>/IdeaProjects/aide && npx vitest run src/utils/paste.test.ts
```

Expected: `8 passed`

- [ ] **Step 4: 更新 `src/components/ChatPanel.vue` — script 部分**

在 `<script setup lang="ts">` 的 import 块中添加：

```typescript
import type { ImageAttachment } from "@/composables/useChatSession";
```

在 `const filteredSkills = ...` 之后、`const scrollEl = ...` 之前，添加 `pendingImages` 状态：

```typescript
const pendingImages = ref<Array<ImageAttachment & { previewUrl: string }>>([]);
```

在 `watch(inputText, ...)` 之后追加：

```typescript
// 切换会话时清空待发图片
watch(() => props.sessionId, () => { pendingImages.value = []; });
```

更新 `emit` 类型定义：

```typescript
const emit = defineEmits<{
  send: [prompt: string, images?: ImageAttachment[]];
  interrupt: [];
}>();
```

更新 `handlePaste` 函数（完整替换）：

```typescript
async function handlePaste(e: ClipboardEvent) {
  e.preventDefault();
  const plainText = e.clipboardData?.getData("text/plain") ?? "";
  try {
    const [files, img] = await Promise.all([
      api.clipboardReadFiles(),
      api.clipboardReadImage(),
    ]);
    const { text, imagePaths } = resolvePastePayload(files, img, peekFileClipboard(), plainText);
    if (text) insertAtCursor(text);
    for (const imgPath of imagePaths) {
      try {
        const data = await api.readFileBase64(imgPath);
        const mediaType = imgPath.toLowerCase().endsWith(".png") ? "image/png"
          : imgPath.toLowerCase().endsWith(".gif") ? "image/gif"
          : imgPath.toLowerCase().endsWith(".webp") ? "image/webp"
          : "image/jpeg";
        pendingImages.value.push({
          data,
          mediaType,
          previewUrl: `data:${mediaType};base64,${data}`,
        });
      } catch { /* 静默失败 */ }
    }
  } catch {
    if (plainText) insertAtCursor(plainText);
  }
}
```

更新 `handleSend` 函数（完整替换）：

```typescript
async function handleSend() {
  const text = inputText.value.trim();
  const hasImages = pendingImages.value.length > 0;
  if ((!text && !hasImages) || isBusyVal.value || !props.sessionId) return;

  let finalPrompt = text;
  const slashMatch = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (slashMatch) {
    const skillName = slashMatch[1];
    const userText = (slashMatch[2] ?? "").trim();
    const skill = skillList.value.find((s) => s.name === skillName);
    if (skill) {
      try {
        const content = await api.readFileContent(skill.filePath);
        finalPrompt = userText ? `${content}\n\n---\n\n${userText}` : content;
      } catch { /* 读取失败则原样发送 */ }
    }
  }

  const images = pendingImages.value.map(({ data, mediaType }) => ({ data, mediaType }));
  inputText.value = "";
  pendingImages.value = [];
  emit("send", finalPrompt, images.length ? images : undefined);
}
```

- [ ] **Step 5: 更新 `ChatPanel.vue` — template 部分**

在 `.chat-input-area` 的 `<!-- Slash command dropdown -->` 之前插入图片预览条：

```html
<!-- Image attachment strip -->
<div v-if="pendingImages.length" class="image-attachment-strip">
  <div
    v-for="(img, i) in pendingImages"
    :key="i"
    class="image-thumb"
  >
    <img :src="img.previewUrl" class="image-thumb-img" alt="附图" />
    <button class="image-thumb-remove" @click="pendingImages.splice(i, 1)">×</button>
  </div>
</div>
```

更新发送按钮的 `:disabled` 条件：

```html
:disabled="isBusyVal || !sessionId || (!inputText.trim() && !pendingImages.length)"
```

- [ ] **Step 6: 在 `ChatPanel.vue` `<style scoped>` 末尾追加图片预览样式**

```css
.image-attachment-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 0 6px;
}

.image-thumb {
  position: relative;
  width: 56px;
  height: 56px;
  border-radius: var(--aide-radius-sm);
  overflow: hidden;
  border: 1px solid var(--aide-border);
  flex-shrink: 0;
}

.image-thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.image-thumb-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  color: white;
  border: none;
  cursor: pointer;
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  line-height: 1;
}

.image-thumb-remove:hover {
  background: var(--aide-danger);
}
```

- [ ] **Step 7: 更新 `src/components/ChatMessage.vue` 渲染 `ImageBlock`**

在 `<template v-for="(block, i) in message.blocks" :key="i">` 的 `ToolCallBlock` 之后添加图片渲染：

```html
<img
  v-else-if="block.type === 'image'"
  :src="`data:${(block as any).mediaType};base64,${(block as any).data}`"
  class="msg-image"
  alt="附图"
/>
```

在 `<style scoped>` 末尾追加：

```css
.msg-image {
  max-width: 100%;
  max-height: 300px;
  border-radius: var(--aide-radius-sm);
  display: block;
  margin: 4px 0;
  cursor: pointer;
}
```

- [ ] **Step 8: TypeScript 检查**

```bash
cd c:/Users/<user>/IdeaProjects/aide && npx tsc --noEmit 2>&1 | grep -v "ui/index.ts"
```

Expected: 无新增错误。

- [ ] **Step 9: 运行全量测试**

```bash
cd src-tauri && cargo test && cd .. && npx vitest run
```

Expected: 全部通过（Rust 20+2 新增，Vitest 8 个 paste 测试）。

- [ ] **Step 10: Commit**

```bash
git add src/utils/paste.ts src/utils/paste.test.ts src/components/ChatPanel.vue src/components/ChatMessage.vue
git commit -m "feat(image): multimodal image paste in chat — thumbnail preview + Claude vision"
```

---

## 验证步骤（人工）

1. 截图/复制图片 → 粘贴到输入框 → 输入框上方出现缩略图，×按钮可删除
2. 发送（含图片）→ 消息气泡里显示图片缩略图 + 文字
3. Claude 回复分析图片内容（不再报 `node:internal/modules/cjs/loader` 错误）
4. 从文件管理器复制 `.ts` 文件粘贴 → `@path` 正常插入
5. 从文件管理器复制 `.png` 文件粘贴 → 图片附件，不再有 `@path`
