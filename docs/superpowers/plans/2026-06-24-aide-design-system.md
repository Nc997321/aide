# Aide Design System Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Aide's hardcoded Catppuccin CSS with a token-based design system, add an atomic component library (`src/ui/`), and restructure the layout for a warm, craftsman-quality aesthetic.

**Architecture:** Theme tokens (TypeScript objects) are injected as CSS custom properties at runtime via `applyTheme()`. An atomic component library (`src/ui/`) provides zero-business-logic Vue components that consume only CSS variables. Page-level components compose these atoms, with layout driven by CSS Grid and a unified `useResizable` composable.

**Tech Stack:** Vue 3 + Composition API + TypeScript, CSS custom properties, CSS Grid, xterm.js (unchanged)

## Global Constraints

- All CSS colors MUST use `var(--aide-*)` variables — zero hardcoded hex values in component styles
- CSS variable prefix: `--aide-` (e.g. `--aide-bg-base`, `--aide-accent`)
- `src/ui/` components: zero imports from `../api`, `../composables`, or `../types` — pure props/emits/slots
- Roundings: `radiusSm=4px` for buttons/badges, `radiusMd=8px` for cards/inputs, `radiusLg=12px` for modals/palette
- Transitions: `0.15s ease` default, `0.12s ease-out` for overlays, `0.2s ease` for layout
- Windows: all existing `CREATE_NO_WINDOW` flags in Rust stay untouched
- No new npm dependencies

---

### Task 1: Theme Infrastructure

**Files:**
- Create: `src/themes/tokens.ts`
- Create: `src/themes/warm-dark.ts`
- Create: `src/themes/catppuccin.ts`
- Create: `src/themes/apply.ts`
- Create: `src/themes/index.ts`
- Modify: `src/styles/global.css`
- Modify: `src/App.vue:252-277` (onMounted)

**Interfaces:**
- Consumes: nothing (foundation layer)
- Produces:
  - `ThemeTokens` interface (used by all themes and `applyTheme`)
  - `applyTheme(tokens: ThemeTokens): void` (called by App.vue and useSettings)
  - `warmDark: ThemeTokens` (default theme object)
  - `catppuccin: ThemeTokens` (compat theme object)
  - `themes: Record<string, ThemeTokens>` (registry for settings panel)

- [ ] **Step 1: Create `src/themes/tokens.ts`**

```ts
export interface ThemeTokens {
  bgDeep: string;
  bgBase: string;
  bgRaised: string;
  bgOverlay: string;

  surfaceDefault: string;
  surfaceHover: string;
  surfaceActive: string;

  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textOnAccent: string;

  accent: string;
  accentHover: string;
  accentSubtle: string;

  success: string;
  warning: string;
  danger: string;
  info: string;

  border: string;
  borderSubtle: string;

  shadowSm: string;
  shadowMd: string;
  shadowLg: string;

  radiusSm: string;
  radiusMd: string;
  radiusLg: string;

  spaceUnit: string;
}
```

- [ ] **Step 2: Create `src/themes/warm-dark.ts`**

```ts
import type { ThemeTokens } from "./tokens";

export const warmDark: ThemeTokens = {
  bgDeep:    "#1a1a22",
  bgBase:    "#22222e",
  bgRaised:  "#2a2a38",
  bgOverlay: "rgba(10, 10, 15, 0.75)",

  surfaceDefault: "#32323f",
  surfaceHover:   "#3a3a4a",
  surfaceActive:  "#44445a",

  textPrimary:   "#d8d4cf",
  textSecondary: "#a8a4a0",
  textMuted:     "#6b6762",
  textOnAccent:  "#1a1a22",

  accent:       "#d4a574",
  accentHover:  "#e0b584",
  accentSubtle: "rgba(212, 165, 116, 0.12)",

  success: "#8bc48a",
  warning: "#e8c374",
  danger:  "#e87070",
  info:    "#7eb8d8",

  border:       "rgba(255, 255, 255, 0.06)",
  borderSubtle: "rgba(255, 255, 255, 0.03)",

  shadowSm: "0 1px 3px rgba(0,0,0,0.25), 0 1px 2px rgba(0,0,0,0.15)",
  shadowMd: "0 4px 12px rgba(0,0,0,0.3), 0 1px 4px rgba(0,0,0,0.2)",
  shadowLg: "0 12px 40px rgba(0,0,0,0.45), 0 4px 12px rgba(0,0,0,0.25)",

  radiusSm: "4px",
  radiusMd: "8px",
  radiusLg: "12px",

  spaceUnit: "4px",
};
```

- [ ] **Step 3: Create `src/themes/catppuccin.ts`**

```ts
import type { ThemeTokens } from "./tokens";

export const catppuccin: ThemeTokens = {
  bgDeep:    "#11111b",
  bgBase:    "#1e1e2e",
  bgRaised:  "#313244",
  bgOverlay: "rgba(17, 17, 27, 0.75)",

  surfaceDefault: "#313244",
  surfaceHover:   "#45475a",
  surfaceActive:  "#585b70",

  textPrimary:   "#cdd6f4",
  textSecondary: "#a6adc8",
  textMuted:     "#6c7086",
  textOnAccent:  "#1e1e2e",

  accent:       "#89b4fa",
  accentHover:  "#b4d0fb",
  accentSubtle: "rgba(137, 180, 250, 0.12)",

  success: "#a6e3a1",
  warning: "#f9e2af",
  danger:  "#f38ba8",
  info:    "#89dceb",

  border:       "rgba(255, 255, 255, 0.06)",
  borderSubtle: "rgba(255, 255, 255, 0.03)",

  shadowSm: "0 1px 3px rgba(0,0,0,0.25), 0 1px 2px rgba(0,0,0,0.15)",
  shadowMd: "0 4px 12px rgba(0,0,0,0.3), 0 1px 4px rgba(0,0,0,0.2)",
  shadowLg: "0 12px 40px rgba(0,0,0,0.45), 0 4px 12px rgba(0,0,0,0.25)",

  radiusSm: "4px",
  radiusMd: "8px",
  radiusLg: "12px",

  spaceUnit: "4px",
};
```

- [ ] **Step 4: Create `src/themes/apply.ts`**

```ts
import type { ThemeTokens } from "./tokens";

export function applyTheme(tokens: ThemeTokens): void {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(tokens)) {
    const cssVar = `--aide-${key.replace(/([A-Z])/g, "-$1").toLowerCase()}`;
    root.style.setProperty(cssVar, value);
  }
}
```

- [ ] **Step 5: Create `src/themes/index.ts`**

```ts
export type { ThemeTokens } from "./tokens";
export { warmDark } from "./warm-dark";
export { catppuccin } from "./catppuccin";
export { applyTheme } from "./apply";

import type { ThemeTokens } from "./tokens";
import { warmDark } from "./warm-dark";
import { catppuccin } from "./catppuccin";

export const themes: Record<string, ThemeTokens> = {
  "warm-dark": warmDark,
  catppuccin,
};
```

- [ ] **Step 6: Replace `global.css` `:root` variables**

Replace the existing `:root` block in `src/styles/global.css`:

```css
:root {
  --aide-bg-deep: #1a1a22;
  --aide-bg-base: #22222e;
  --aide-bg-raised: #2a2a38;
  --aide-bg-overlay: rgba(10, 10, 15, 0.75);
  --aide-surface-default: #32323f;
  --aide-surface-hover: #3a3a4a;
  --aide-surface-active: #44445a;
  --aide-text-primary: #d8d4cf;
  --aide-text-secondary: #a8a4a0;
  --aide-text-muted: #6b6762;
  --aide-text-on-accent: #1a1a22;
  --aide-accent: #d4a574;
  --aide-accent-hover: #e0b584;
  --aide-accent-subtle: rgba(212, 165, 116, 0.12);
  --aide-success: #8bc48a;
  --aide-warning: #e8c374;
  --aide-danger: #e87070;
  --aide-info: #7eb8d8;
  --aide-border: rgba(255, 255, 255, 0.06);
  --aide-border-subtle: rgba(255, 255, 255, 0.03);
  --aide-shadow-sm: 0 1px 3px rgba(0,0,0,0.25), 0 1px 2px rgba(0,0,0,0.15);
  --aide-shadow-md: 0 4px 12px rgba(0,0,0,0.3), 0 1px 4px rgba(0,0,0,0.2);
  --aide-shadow-lg: 0 12px 40px rgba(0,0,0,0.45), 0 4px 12px rgba(0,0,0,0.25);
  --aide-radius-sm: 4px;
  --aide-radius-md: 8px;
  --aide-radius-lg: 12px;
  --aide-space-unit: 4px;

  /* Legacy aliases — temporary bridge, removed in Task 7 */
  --bg-primary: var(--aide-bg-base);
  --bg-secondary: var(--aide-bg-deep);
  --bg-tertiary: var(--aide-bg-deep);
  --surface: var(--aide-surface-default);
  --surface-hover: var(--aide-surface-hover);
  --text-primary: var(--aide-text-primary);
  --text-secondary: var(--aide-text-secondary);
  --text-muted: var(--aide-text-muted);
  --accent: var(--aide-accent);
  --accent-green: var(--aide-success);
  --accent-yellow: var(--aide-warning);
  --accent-red: var(--aide-danger);
}
```

Also update the `html, body, #app` block to use the new variables:

```css
html, body, #app {
  height: 100%;
  width: 100%;
  overflow: hidden;
  background-color: var(--aide-bg-base);
  color: var(--aide-text-primary);
  font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 13px;
}
```

And the scrollbar styles:

```css
::-webkit-scrollbar-thumb {
  background: var(--aide-surface-hover);
  border-radius: 3px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--aide-text-muted);
}
```

- [ ] **Step 7: Call `applyTheme` in `App.vue` onMounted**

In `src/App.vue`, add the import at the top of `<script setup>`:

```ts
import { applyTheme, warmDark } from "./themes";
```

At the start of `onMounted`, before `await loadSettings()`:

```ts
applyTheme(warmDark);
```

- [ ] **Step 8: Verify — run `pnpm dev` and confirm the app starts**

Run: `pnpm dev`

Expected: App launches with identical visuals to before (legacy aliases bridge old variable names). The warm-dark values are in `:root` as CSS fallbacks, overwritten identically by `applyTheme(warmDark)`.

- [ ] **Step 9: Commit**

```bash
git add src/themes/ src/styles/global.css src/App.vue
git commit -m "feat: theme infrastructure — tokens, warm-dark, catppuccin, applyTheme + CSS variable migration"
```

---

### Task 2: Atomic Components — Foundation Set (AStatusDot, ABadge, AButton, AInput)

**Files:**
- Create: `src/ui/AStatusDot.vue`
- Create: `src/ui/ABadge.vue`
- Create: `src/ui/AButton.vue`
- Create: `src/ui/AInput.vue`
- Create: `src/ui/index.ts` (partial — will grow in later tasks)

**Interfaces:**
- Consumes: CSS variables from Task 1 (`--aide-*`)
- Produces:
  - `AStatusDot`: `props: { status: 'stopped' | 'running' | 'waiting' | 'attention' }`
  - `ABadge`: `props: { value: number | string, color?: 'accent' | 'success' | 'warning' | 'danger' }`
  - `AButton`: `props: { variant?: 'primary' | 'ghost' | 'danger', size?: 'sm' | 'md', disabled?: boolean }`, slot: default
  - `AInput`: `props: { modelValue: string, placeholder?: string, icon?: string }`, emit: `update:modelValue`

- [ ] **Step 1: Create `src/ui/AStatusDot.vue`**

```vue
<script setup lang="ts">
defineProps<{
  status: "stopped" | "running" | "waiting" | "attention";
}>();
</script>

<template>
  <span class="a-status-dot" :class="`a-status-dot--${status}`" />
</template>

<style scoped>
.a-status-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.a-status-dot--stopped {
  background: var(--aide-text-muted);
}

.a-status-dot--running {
  background: var(--aide-success);
  box-shadow: 0 0 6px color-mix(in srgb, var(--aide-success) 50%, transparent);
  animation: a-dot-pulse 2s ease-in-out infinite;
}

.a-status-dot--waiting {
  background: var(--aide-accent);
}

.a-status-dot--attention {
  background: var(--aide-warning);
  box-shadow: 0 0 6px color-mix(in srgb, var(--aide-warning) 50%, transparent);
  animation: a-dot-pulse 2s ease-in-out infinite;
}

@keyframes a-dot-pulse {
  0%, 100% { opacity: 0.7; }
  50% { opacity: 1; }
}
</style>
```

- [ ] **Step 2: Create `src/ui/ABadge.vue`**

```vue
<script setup lang="ts">
withDefaults(
  defineProps<{
    value: number | string;
    color?: "accent" | "success" | "warning" | "danger";
  }>(),
  { color: "accent" },
);
</script>

<template>
  <span class="a-badge" :class="`a-badge--${color}`">{{ value }}</span>
</template>

<style scoped>
.a-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  padding: 0 5px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.5;
  border-radius: 8px;
  text-align: center;
}

.a-badge--accent {
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
}
.a-badge--success {
  background: var(--aide-success);
  color: var(--aide-text-on-accent);
}
.a-badge--warning {
  background: var(--aide-warning);
  color: var(--aide-text-on-accent);
}
.a-badge--danger {
  background: var(--aide-danger);
  color: var(--aide-text-on-accent);
}
</style>
```

- [ ] **Step 3: Create `src/ui/AButton.vue`**

```vue
<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: "primary" | "ghost" | "danger";
    size?: "sm" | "md";
    disabled?: boolean;
  }>(),
  { variant: "ghost", size: "md", disabled: false },
);
</script>

<template>
  <button
    class="a-btn"
    :class="[`a-btn--${variant}`, `a-btn--${size}`, { 'a-btn--disabled': disabled }]"
    :disabled="disabled"
  >
    <slot />
  </button>
</template>

<style scoped>
.a-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 1px solid transparent;
  border-radius: var(--aide-radius-sm);
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.a-btn--md {
  padding: 4px 12px;
  font-size: 12px;
}
.a-btn--sm {
  padding: 2px 8px;
  font-size: 11px;
}

/* Ghost */
.a-btn--ghost {
  background: var(--aide-surface-default);
  border-color: var(--aide-border);
  color: var(--aide-text-secondary);
}
.a-btn--ghost:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}

/* Primary */
.a-btn--primary {
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
  box-shadow: var(--aide-shadow-sm);
}
.a-btn--primary:hover {
  background: var(--aide-accent-hover);
}

/* Danger */
.a-btn--danger {
  background: transparent;
  border-color: color-mix(in srgb, var(--aide-danger) 30%, transparent);
  color: var(--aide-danger);
}
.a-btn--danger:hover {
  background: color-mix(in srgb, var(--aide-danger) 10%, transparent);
}

/* Disabled */
.a-btn--disabled {
  opacity: 0.5;
  pointer-events: none;
}
</style>
```

- [ ] **Step 4: Create `src/ui/AInput.vue`**

```vue
<script setup lang="ts">
defineProps<{
  modelValue: string;
  placeholder?: string;
  icon?: string;
}>();

defineEmits<{
  "update:modelValue": [value: string];
}>();
</script>

<template>
  <div class="a-input">
    <span v-if="icon" class="a-input__icon">{{ icon }}</span>
    <input
      class="a-input__field"
      :value="modelValue"
      :placeholder="placeholder"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
  </div>
</template>

<style scoped>
.a-input {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--aide-surface-default);
  border: 1px solid transparent;
  border-radius: var(--aide-radius-md);
  padding: 6px 10px;
  transition: all 0.15s ease;
}

.a-input:focus-within {
  border-color: var(--aide-accent);
  box-shadow: 0 0 0 2px var(--aide-accent-subtle);
}

.a-input__icon {
  font-size: 13px;
  color: var(--aide-text-muted);
  flex-shrink: 0;
}

.a-input__field {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  color: var(--aide-text-primary);
  font-size: 12px;
  font-family: inherit;
}

.a-input__field::placeholder {
  color: var(--aide-text-muted);
}
</style>
```

- [ ] **Step 5: Create `src/ui/index.ts` (partial)**

```ts
export { default as AStatusDot } from "./AStatusDot.vue";
export { default as ABadge } from "./ABadge.vue";
export { default as AButton } from "./AButton.vue";
export { default as AInput } from "./AInput.vue";
```

- [ ] **Step 6: Verify — import test**

Temporarily add to any component (e.g. `App.vue` template):

```vue
<AStatusDot status="running" />
```

With the import:

```ts
import { AStatusDot } from "./ui";
```

Run `pnpm dev`. Confirm a green pulsing dot renders. Remove the temporary test.

- [ ] **Step 7: Commit**

```bash
git add src/ui/
git commit -m "feat: atomic component library — AStatusDot, ABadge, AButton, AInput"
```

---

### Task 3: Atomic Components — Layout Set (ACard, ATabBar, AToolbar, ADropdown, ATreeItem)

**Files:**
- Create: `src/ui/ACard.vue`
- Create: `src/ui/ATabBar.vue`
- Create: `src/ui/AToolbar.vue`
- Create: `src/ui/ADropdown.vue`
- Create: `src/ui/ATreeItem.vue`
- Modify: `src/ui/index.ts`

**Interfaces:**
- Consumes: CSS variables from Task 1
- Produces:
  - `ACard`: `props: { active?, hoverable?, glowColor? }`, slot: default
  - `ATabBar`: `props: { tabs: Tab[], modelValue: string }`, emit: `update:modelValue`. `Tab = { id: string, label: string, icon?: string, badge?: number }`
  - `AToolbar`: slots: left, center, right
  - `ADropdown`: `props: { open, items: DropdownItem[] }`, emits: `select(id)`, `close`. `DropdownItem = { id: string, label: string, icon?: string, divider?: boolean }`
  - `ATreeItem`: `props: { label, icon, depth, isDir, expanded, active }`, emits: `toggle`, `select`

- [ ] **Step 1: Create `src/ui/ACard.vue`**

```vue
<script setup lang="ts">
withDefaults(
  defineProps<{
    active?: boolean;
    hoverable?: boolean;
    glowColor?: string;
  }>(),
  { active: false, hoverable: true },
);
</script>

<template>
  <div
    class="a-card"
    :class="{ 'a-card--active': active, 'a-card--hoverable': hoverable }"
    :style="glowColor ? { '--glow-color': glowColor } as any : undefined"
  >
    <div v-if="glowColor" class="a-card__glow" />
    <slot />
  </div>
</template>

<style scoped>
.a-card {
  position: relative;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  padding: 10px 12px;
  overflow: hidden;
  transition: all 0.15s ease;
}

.a-card--hoverable:hover {
  background: var(--aide-surface-default);
  border-color: rgba(255, 255, 255, 0.1);
  box-shadow: var(--aide-shadow-sm);
}

.a-card--active {
  border-color: color-mix(in srgb, var(--aide-accent) 35%, transparent);
  background:
    linear-gradient(135deg, var(--aide-accent-subtle) 0%, transparent 60%),
    var(--aide-bg-raised);
  box-shadow: var(--aide-shadow-sm);
}

.a-card__glow {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: linear-gradient(180deg, transparent, var(--glow-color, var(--aide-success)), transparent);
  animation: a-card-glow-pulse 2s ease-in-out infinite;
}

@keyframes a-card-glow-pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}
</style>
```

- [ ] **Step 2: Create `src/ui/ATabBar.vue`**

```vue
<script setup lang="ts">
import ABadge from "./ABadge.vue";

export interface Tab {
  id: string;
  label: string;
  icon?: string;
  badge?: number;
}

const props = defineProps<{
  tabs: Tab[];
  modelValue: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [id: string];
}>();

function onKeydown(e: KeyboardEvent) {
  const idx = props.tabs.findIndex((t) => t.id === props.modelValue);
  if (e.key === "ArrowRight" && idx < props.tabs.length - 1) {
    e.preventDefault();
    emit("update:modelValue", props.tabs[idx + 1].id);
  } else if (e.key === "ArrowLeft" && idx > 0) {
    e.preventDefault();
    emit("update:modelValue", props.tabs[idx - 1].id);
  }
}
</script>

<template>
  <div class="a-tab-bar" role="tablist" @keydown="onKeydown">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      class="a-tab"
      :class="{ 'a-tab--active': modelValue === tab.id }"
      role="tab"
      :aria-selected="modelValue === tab.id"
      :tabindex="modelValue === tab.id ? 0 : -1"
      @click="emit('update:modelValue', tab.id)"
    >
      <span v-if="tab.icon" class="a-tab__icon">{{ tab.icon }}</span>
      <span class="a-tab__label">{{ tab.label }}</span>
      <ABadge v-if="tab.badge && tab.badge > 0" :value="tab.badge" />
    </button>
  </div>
</template>

<style scoped>
.a-tab-bar {
  display: flex;
  padding: 6px 8px 0;
  gap: 2px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--aide-border);
}

.a-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 7px 0 8px;
  border: none;
  background: transparent;
  color: var(--aide-text-muted);
  font-size: 11.5px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  border-radius: var(--aide-radius-sm) var(--aide-radius-sm) 0 0;
  transition: all 0.15s ease;
}

.a-tab:hover {
  color: var(--aide-text-secondary);
  background: rgba(255, 255, 255, 0.02);
}

.a-tab--active {
  color: var(--aide-text-primary);
  border-bottom-color: var(--aide-accent);
  background: rgba(255, 255, 255, 0.02);
}

.a-tab__icon {
  font-size: 13px;
}

.a-tab__label {
  font-weight: 500;
}
</style>
```

- [ ] **Step 3: Create `src/ui/AToolbar.vue`**

```vue
<template>
  <div class="a-toolbar">
    <div class="a-toolbar__left"><slot name="left" /></div>
    <div class="a-toolbar__center"><slot name="center" /></div>
    <div class="a-toolbar__right"><slot name="right" /></div>
  </div>
</template>

<style scoped>
.a-toolbar {
  display: flex;
  align-items: center;
  height: 34px;
  padding: 0 12px;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.015) 0%, transparent 100%),
    var(--aide-bg-deep);
  border-bottom: 1px solid var(--aide-border);
  flex-shrink: 0;
  gap: 10px;
}

.a-toolbar__left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.a-toolbar__center {
  flex: 1;
}

.a-toolbar__right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
</style>
```

- [ ] **Step 4: Create `src/ui/ADropdown.vue`**

```vue
<script setup lang="ts">
import { onMounted, onUnmounted, watch } from "vue";

export interface DropdownItem {
  id: string;
  label: string;
  icon?: string;
  divider?: boolean;
}

const props = defineProps<{
  open: boolean;
  items: DropdownItem[];
}>();

const emit = defineEmits<{
  select: [id: string];
  close: [];
}>();

function onClickOutside(e: MouseEvent) {
  if (props.open) {
    emit("close");
  }
}

watch(
  () => props.open,
  (v) => {
    if (v) {
      setTimeout(() => document.addEventListener("click", onClickOutside), 0);
    } else {
      document.removeEventListener("click", onClickOutside);
    }
  },
);

onUnmounted(() => {
  document.removeEventListener("click", onClickOutside);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="a-dropdown">
      <div v-if="open" class="a-dropdown" @click.stop>
        <template v-for="item in items" :key="item.id">
          <div v-if="item.divider" class="a-dropdown__divider" />
          <div
            v-else
            class="a-dropdown__item"
            @click="emit('select', item.id)"
          >
            <span v-if="item.icon" class="a-dropdown__icon">{{ item.icon }}</span>
            <span class="a-dropdown__label">{{ item.label }}</span>
          </div>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>

<style>
.a-dropdown {
  position: absolute;
  z-index: 9000;
  min-width: 160px;
  background: var(--aide-bg-raised);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: var(--aide-radius-md);
  box-shadow: var(--aide-shadow-md);
  padding: 4px;
  overflow: hidden;
}

.a-dropdown__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  font-size: 12px;
  color: var(--aide-text-secondary);
  transition: all 0.1s;
}

.a-dropdown__item:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.a-dropdown__icon {
  font-size: 13px;
  width: 18px;
  text-align: center;
}

.a-dropdown__divider {
  height: 1px;
  background: var(--aide-border);
  margin: 4px 0;
}

.a-dropdown-enter-active {
  transition: opacity 0.12s ease-out, transform 0.12s ease-out;
}
.a-dropdown-leave-active {
  transition: opacity 0.08s ease, transform 0.08s ease;
}
.a-dropdown-enter-from {
  opacity: 0;
  transform: scale(0.96);
}
.a-dropdown-leave-to {
  opacity: 0;
  transform: scale(0.96);
}
</style>
```

- [ ] **Step 5: Create `src/ui/ATreeItem.vue`**

```vue
<script setup lang="ts">
const props = defineProps<{
  label: string;
  icon: string;
  depth: number;
  isDir: boolean;
  expanded: boolean;
  active: boolean;
}>();

defineEmits<{
  toggle: [];
  select: [];
}>();
</script>

<template>
  <div
    class="a-tree-item"
    :class="{ 'a-tree-item--active': active }"
    :style="{ paddingLeft: `${depth * 16 + 8}px` }"
    @click="$emit('select')"
  >
    <span
      v-if="isDir"
      class="a-tree-item__arrow"
      :class="{ 'a-tree-item__arrow--open': expanded }"
      @click.stop="$emit('toggle')"
    >&#x25B8;</span>
    <span v-else class="a-tree-item__arrow-placeholder" />
    <span class="a-tree-item__icon">{{ icon }}</span>
    <span class="a-tree-item__label">{{ label }}</span>
  </div>
</template>

<style scoped>
.a-tree-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 4px;
  padding-bottom: 4px;
  padding-right: 8px;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  font-size: 12px;
  color: var(--aide-text-secondary);
  transition: all 0.1s;
}

.a-tree-item:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.a-tree-item--active {
  background: var(--aide-accent-subtle);
  color: var(--aide-accent);
}

.a-tree-item__arrow {
  font-size: 10px;
  width: 14px;
  text-align: center;
  color: var(--aide-text-muted);
  transition: transform 0.12s;
  flex-shrink: 0;
  cursor: pointer;
}

.a-tree-item__arrow--open {
  transform: rotate(90deg);
}

.a-tree-item__arrow-placeholder {
  width: 14px;
  flex-shrink: 0;
}

.a-tree-item__icon {
  font-size: 14px;
  width: 18px;
  text-align: center;
  flex-shrink: 0;
}

.a-tree-item__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
```

- [ ] **Step 6: Update `src/ui/index.ts`**

```ts
export { default as AStatusDot } from "./AStatusDot.vue";
export { default as ABadge } from "./ABadge.vue";
export { default as AButton } from "./AButton.vue";
export { default as AInput } from "./AInput.vue";
export { default as ACard } from "./ACard.vue";
export { default as ATabBar } from "./ATabBar.vue";
export type { Tab } from "./ATabBar.vue";
export { default as AToolbar } from "./AToolbar.vue";
export { default as ADropdown } from "./ADropdown.vue";
export type { DropdownItem } from "./ADropdown.vue";
export { default as ATreeItem } from "./ATreeItem.vue";
```

- [ ] **Step 7: Commit**

```bash
git add src/ui/
git commit -m "feat: atomic components — ACard, ATabBar, AToolbar, ADropdown, ATreeItem"
```

---

### Task 4: ACommandPalette + Replace SearchBox

**Files:**
- Create: `src/ui/ACommandPalette.vue`
- Modify: `src/ui/index.ts`
- Modify: `src/components/titlebar/TitleBar.vue`
- Modify: `src/App.vue` (add palette state + mount ACommandPalette)
- Modify: `src/composables/useSearchProviders.ts` (export `getProviders` for palette)
- Delete: `src/components/titlebar/SearchBox.vue`

**Interfaces:**
- Consumes:
  - `SearchProvider` / `SearchResult` from `useSearchProviders`
  - CSS variables from Task 1
- Produces:
  - `ACommandPalette`: `props: { open: boolean }`, emits: `close`, `select(result: SearchResult)`
  - `TitleBar`: emits `open-palette` (replaces `searchBox` expose)

- [ ] **Step 1: Add `getProviders()` to `useSearchProviders`**

In `src/composables/useSearchProviders.ts`, add this function before the `return` statement of `useSearchProviders()`:

```ts
function getProviders(): SearchProvider[] {
  return [...providers].sort((a, b) => a.priority - b.priority);
}
```

And add it to the return object:

```ts
return { register, unregister, search, getProviders, initProviders, invalidateFileCache };
```

- [ ] **Step 2: Create `src/ui/ACommandPalette.vue`**

```vue
<script setup lang="ts">
import { ref, watch, nextTick, computed } from "vue";

export interface PaletteResult {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  group: string;
  action: () => void;
}

export interface PaletteProvider {
  id: string;
  label: string;
  priority: number;
  search(query: string, limit: number): Promise<PaletteResult[]>;
}

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  close: [];
}>();

const query = ref("");
const results = ref<PaletteResult[]>([]);
const selectedIndex = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
let searchFn: ((q: string, limit: number) => Promise<PaletteResult[]>) | null = null;

function setSearchFn(fn: (q: string, limit: number) => Promise<PaletteResult[]>) {
  searchFn = fn;
}

const grouped = computed(() => {
  const groups: Record<string, PaletteResult[]> = {};
  for (const r of results.value) {
    if (!groups[r.group]) groups[r.group] = [];
    groups[r.group].push(r);
  }
  return groups;
});

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

watch(query, (q) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (!q.trim()) {
    results.value = [];
    selectedIndex.value = 0;
    return;
  }
  debounceTimer = setTimeout(async () => {
    if (!searchFn) return;
    results.value = await searchFn(q.trim(), 8);
    selectedIndex.value = 0;
  }, 150);
});

watch(
  () => props.open,
  async (v) => {
    if (v) {
      query.value = "";
      results.value = [];
      selectedIndex.value = 0;
      await nextTick();
      inputRef.value?.focus();
    }
  },
);

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    emit("close");
    return;
  }
  if (results.value.length === 0) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedIndex.value = Math.min(selectedIndex.value + 1, results.value.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const item = results.value[selectedIndex.value];
    if (item) {
      item.action();
      emit("close");
    }
  }
}

function onOverlayClick(e: MouseEvent) {
  if (e.target === e.currentTarget) {
    emit("close");
  }
}

defineExpose({ setSearchFn });
</script>

<template>
  <Teleport to="body">
    <Transition name="a-palette">
      <div v-if="open" class="a-palette-overlay" @click="onOverlayClick">
        <div class="a-palette-box">
          <div class="a-palette-input-row">
            <span class="a-palette-icon">🔍</span>
            <input
              ref="inputRef"
              v-model="query"
              class="a-palette-input"
              placeholder="搜索会话、文件或命令..."
              @keydown="onKeydown"
            />
          </div>
          <div v-if="results.length > 0" class="a-palette-results">
            <template v-for="(items, group) in grouped" :key="group">
              <div class="a-palette-section">{{ group }}</div>
              <div
                v-for="item in items"
                :key="item.id"
                class="a-palette-item"
                :class="{ 'a-palette-item--selected': results.indexOf(item) === selectedIndex }"
                @click="item.action(); emit('close')"
                @mouseenter="selectedIndex = results.indexOf(item)"
              >
                <span class="a-palette-item-icon">{{ item.icon || '📄' }}</span>
                <div class="a-palette-item-text">
                  <div class="a-palette-item-label">{{ item.label }}</div>
                  <div v-if="item.description" class="a-palette-item-desc">{{ item.description }}</div>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style>
.a-palette-overlay {
  position: fixed;
  inset: 0;
  background: var(--aide-bg-overlay);
  display: flex;
  justify-content: center;
  padding-top: 80px;
  z-index: 10000;
  backdrop-filter: blur(8px);
}

.a-palette-box {
  width: 560px;
  max-height: 400px;
  background: var(--aide-bg-raised);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: var(--aide-radius-lg);
  box-shadow: var(--aide-shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.a-palette-input-row {
  display: flex;
  align-items: center;
  padding: 14px 18px;
  gap: 10px;
  border-bottom: 1px solid var(--aide-border);
}

.a-palette-icon {
  font-size: 16px;
  color: var(--aide-text-muted);
}

.a-palette-input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  color: var(--aide-text-primary);
  font-size: 14px;
  font-family: inherit;
}

.a-palette-input::placeholder {
  color: var(--aide-text-muted);
}

.a-palette-results {
  overflow-y: auto;
  padding: 6px;
}

.a-palette-section {
  padding: 8px 12px 4px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--aide-text-muted);
}

.a-palette-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--aide-radius-md);
  cursor: pointer;
  transition: background 0.1s;
}

.a-palette-item:hover,
.a-palette-item--selected {
  background: var(--aide-surface-default);
}

.a-palette-item-icon {
  font-size: 14px;
  width: 20px;
  text-align: center;
  color: var(--aide-text-muted);
  flex-shrink: 0;
}

.a-palette-item-text {
  min-width: 0;
  flex: 1;
}

.a-palette-item-label {
  font-size: 13px;
  color: var(--aide-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.a-palette-item-desc {
  font-size: 11px;
  color: var(--aide-text-muted);
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Transitions */
.a-palette-enter-active {
  transition: opacity 0.12s ease-out;
}
.a-palette-enter-active .a-palette-box {
  transition: transform 0.12s ease-out, opacity 0.12s ease-out;
}
.a-palette-leave-active {
  transition: opacity 0.1s ease;
}
.a-palette-leave-active .a-palette-box {
  transition: transform 0.1s ease, opacity 0.1s ease;
}
.a-palette-enter-from {
  opacity: 0;
}
.a-palette-enter-from .a-palette-box {
  opacity: 0;
  transform: scale(0.96);
}
.a-palette-leave-to {
  opacity: 0;
}
.a-palette-leave-to .a-palette-box {
  opacity: 0;
  transform: scale(0.96);
}
</style>
```

- [ ] **Step 3: Update `src/ui/index.ts`**

Add:

```ts
export { default as ACommandPalette } from "./ACommandPalette.vue";
```

- [ ] **Step 4: Rewrite `src/components/titlebar/TitleBar.vue`**

Replace entire file content:

```vue
<script setup lang="ts">
import WindowControls from "./WindowControls.vue";

defineEmits<{
  "open-palette": [];
}>();
</script>

<template>
  <div class="titlebar" data-tauri-drag-region>
    <div class="titlebar-logo" data-tauri-drag-region>
      <img class="titlebar-logo-icon" src="/icon.png" alt="Aide" />
      <span class="titlebar-logo-text">Aide</span>
    </div>

    <button class="titlebar-search-trigger" @click="$emit('open-palette')">
      <span class="titlebar-search-icon">🔍</span>
      <span class="titlebar-search-text">搜索会话、文件或命令...</span>
      <kbd class="titlebar-search-kbd">Ctrl+P</kbd>
    </button>

    <WindowControls />
  </div>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  height: 42px;
  flex-shrink: 0;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.02) 0%, transparent 100%),
    var(--aide-bg-deep);
  border-bottom: 1px solid var(--aide-border);
  padding: 0 16px;
  gap: 16px;
  user-select: none;
}

.titlebar-logo {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.titlebar-logo-icon {
  width: 18px;
  height: 18px;
  object-fit: contain;
}

.titlebar-logo-text {
  font-size: 12px;
  font-weight: 600;
  color: var(--aide-text-secondary);
  letter-spacing: 0.5px;
}

.titlebar-search-trigger {
  flex: 1;
  max-width: 400px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  padding: 6px 14px;
  color: var(--aide-text-muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}

.titlebar-search-trigger:hover {
  background: var(--aide-surface-hover);
  border-color: rgba(255, 255, 255, 0.1);
}

.titlebar-search-icon {
  font-size: 11px;
  flex-shrink: 0;
}

.titlebar-search-text {
  flex: 1;
  text-align: left;
}

.titlebar-search-kbd {
  margin-left: auto;
  background: var(--aide-bg-deep);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  color: var(--aide-text-muted);
  border: 1px solid var(--aide-border);
  font-family: inherit;
}
</style>
```

- [ ] **Step 5: Integrate ACommandPalette in `App.vue`**

In `src/App.vue` `<script setup>`, add imports:

```ts
import ACommandPalette from "./ui/ACommandPalette.vue";
import { useSearchProviders, type SearchResult } from "./composables/useSearchProviders";
```

Add state:

```ts
const paletteOpen = ref(false);
const paletteRef = ref<InstanceType<typeof ACommandPalette> | null>(null);
```

In `handleKeydown`, replace the search shortcut block (that called `titleBarRef.value?.searchBox?.open()`) with:

```ts
if (matchShortcut(e, searchShortcut)) {
  e.preventDefault();
  e.stopPropagation();
  paletteOpen.value = true;
  return;
}
```

In `onMounted`, after the `initSearchProviders` call, add:

```ts
// Wire the search function into the palette
nextTick(() => {
  const { search, getProviders } = useSearchProviders();
  paletteRef.value?.setSearchFn(async (q: string, limit: number) => {
    const rawResults = await search(q, limit);
    return rawResults.map((r) => ({
      ...r,
      group: r.icon === "📝" ? "会话" : r.icon === "📄" ? "文件" : "其他",
    }));
  });
});
```

In the template, add `@open-palette` to TitleBar:

```vue
<TitleBar ref="titleBarRef" @open-palette="paletteOpen = true" />
```

Remove the `searchBox` ref usage from TitleBar (the `ref="titleBarRef"` can stay for future use but the `.searchBox` access is removed).

Add the palette component before `</div>` of `.app-shell`:

```vue
<ACommandPalette
  ref="paletteRef"
  :open="paletteOpen"
  @close="paletteOpen = false"
/>
```

- [ ] **Step 6: Delete `src/components/titlebar/SearchBox.vue`**

```bash
git rm src/components/titlebar/SearchBox.vue
```

- [ ] **Step 7: Verify**

Run `pnpm dev`. Test:
1. Click the search trigger in titlebar → palette opens
2. Ctrl+P → palette opens
3. Type a session name → results appear grouped under "会话"
4. Arrow keys navigate, Enter selects and navigates to session
5. Esc closes palette
6. Click outside closes palette

- [ ] **Step 8: Commit**

```bash
git add src/ui/ACommandPalette.vue src/ui/index.ts src/components/titlebar/TitleBar.vue src/App.vue src/composables/useSearchProviders.ts
git commit -m "feat: ACommandPalette replaces SearchBox — unified Ctrl+P search"
```

---

### Task 5: Left Sidebar — Card-based Sessions

**Files:**
- Modify: `src/components/SidebarLeft.vue`

**Interfaces:**
- Consumes: `ACard`, `AStatusDot` from `src/ui/`, `useSessionState` from composables
- Produces: same external API as before (props, emits, `defineExpose`)

- [ ] **Step 1: Update imports in `SidebarLeft.vue`**

Add at top of `<script setup>`:

```ts
import { ACard, AStatusDot } from "../ui";
```

- [ ] **Step 2: Remove the search box from template**

Delete the entire `<!-- Search box -->` section (the `.search-box` div with the `<input>` inside).

- [ ] **Step 3: Replace session items with ACard**

Replace the session item template block (the `v-for="s in wsSessions(ws.key)"` div) with:

```vue
<ACard
  v-for="s in wsSessions(ws.key)"
  :key="s.id"
  :active="props.activeSessionId === s.id"
  :glow-color="sessionState[s.id] === 'running' ? 'var(--aide-success)' : undefined"
  class="session-card"
  @click="selectSessionFromWorkspace(ws.key, s.id)"
  @contextmenu.prevent="onSessionContextMenu($event, s.id)"
>
  <div class="session-card-header">
    <AStatusDot :status="sessionState[s.id] || 'stopped'" />
    <span class="session-name">{{ s.name }}</span>
    <span class="session-time">{{ timeAgo(s.timestamp) }}</span>
  </div>
  <div class="session-preview">{{ s.last_message }}</div>
</ACard>
```

- [ ] **Step 4: Update scoped styles**

Remove old `.session-item`, `.session-item.active`, `.session-item.running`, `.session-item.waiting`, `.session-item.attention` styles, and the `.search-box`, `.search-input` styles.

Add new card inner styles:

```css
.session-card {
  margin-bottom: 6px;
  cursor: pointer;
}

.session-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.session-name {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--aide-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.session-time {
  font-size: 10px;
  color: var(--aide-text-muted);
  flex-shrink: 0;
}

.session-preview {
  font-size: 11px;
  color: var(--aide-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.4;
}
```

Update `.session-list` padding from `4px 0` to `0 10px 10px`:

```css
.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 10px 10px;
}
```

Update `.sidebar-header` title to use uppercase muted style:

```css
.header-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--aide-text-muted);
}
```

Update `.new-btn`:

```css
.new-btn {
  background: var(--aide-accent-subtle);
  border: 1px solid color-mix(in srgb, var(--aide-accent) 20%, transparent);
  color: var(--aide-accent);
  padding: 4px 12px;
  border-radius: var(--aide-radius-sm);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}
.new-btn:hover {
  background: color-mix(in srgb, var(--aide-accent) 20%, transparent);
  border-color: color-mix(in srgb, var(--aide-accent) 35%, transparent);
}
```

- [ ] **Step 5: Verify**

Run `pnpm dev`. Test:
1. Session list renders as cards with status dots
2. Active card has accent glow border
3. Running session has green left-edge pulse
4. Right-click context menu still works
5. Workspace expand/collapse still works
6. New session button works

- [ ] **Step 6: Commit**

```bash
git add src/components/SidebarLeft.vue
git commit -m "feat: card-based session list with ACard + AStatusDot"
```

---

### Task 6: Layout Grid + Right Panel Three Tabs + useResizable

**Files:**
- Create: `src/composables/useResizable.ts`
- Modify: `src/App.vue` (layout rewrite)
- Modify: `src/components/ChangeLogPanel.vue` (remove collapse-changed emit)

**Interfaces:**
- Consumes: `ATabBar` from `src/ui/`, `useConversationChanges` (existing)
- Produces:
  - `useResizable(opts)`: `{ onMousedown: (e: MouseEvent) => void, isDragging: Ref<boolean> }`
  - Three-tab right panel (files / changes / git)

- [ ] **Step 1: Create `src/composables/useResizable.ts`**

```ts
import { ref } from "vue";

export interface ResizableOptions {
  cssVar: string;
  initial: number;
  min: number;
  max: number;
  direction: "left" | "right";
}

export function useResizable(options: ResizableOptions) {
  const isDragging = ref(false);
  const size = ref(options.initial);

  function onMousedown(e: MouseEvent) {
    isDragging.value = true;
    const startX = e.clientX;
    const startSize = size.value;

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const newSize = options.direction === "left"
        ? startSize + delta
        : startSize - delta;
      size.value = Math.max(options.min, Math.min(options.max, newSize));
      document.documentElement.style.setProperty(options.cssVar, `${size.value}px`);
    };

    const onUp = () => {
      isDragging.value = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // Set initial value
  document.documentElement.style.setProperty(options.cssVar, `${options.initial}px`);

  return { onMousedown, isDragging, size };
}
```

- [ ] **Step 2: Rewrite `App.vue` layout section**

In `src/App.vue` `<script setup>`, replace the old drag state variables and handler functions.

Remove:
- `leftWidth`, `rightWidth`, `changeLogHeight`, `changeLogCollapsed`
- `isDraggingLeft`, `isDraggingRight`, `isDraggingChangeLog`
- `onLeftResizeStart`, `onRightResizeStart`, `onChangeLogResizeStart`

Add:

```ts
import { useResizable } from "./composables/useResizable";
import { ATabBar } from "./ui";
import type { Tab } from "./ui";

const leftResize = useResizable({
  cssVar: "--aide-left-w",
  initial: 280,
  min: 220,
  max: 450,
  direction: "left",
});

const rightResize = useResizable({
  cssVar: "--aide-right-w",
  initial: 300,
  min: 280,
  max: 500,
  direction: "right",
});
```

Replace `changeLogHeight` and `changeLogCollapsed` refs with a computed for the changes tab badge:

```ts
import { useConversationChanges } from "./composables/useConversationChanges";
const { rounds } = useConversationChanges(() => activeSessionId.value);
const changeCount = computed(() => {
  let n = 0;
  for (const r of rounds.value) n += r.files.length;
  return n;
});
```

Add the right panel tabs definition:

```ts
const rightTabs = computed<Tab[]>(() => [
  { id: "files", label: "文件", icon: "📁" },
  { id: "changes", label: "变更", icon: "✎", badge: changeCount.value || undefined },
  { id: "git", label: "Git", icon: "⎇", badge: unstagedFiles.value.length || undefined },
]);
```

- [ ] **Step 3: Rewrite `App.vue` template layout**

Replace the `<div class="app-layout">` section with:

```vue
<div class="app-layout" :class="{ 'is-dragging': leftResize.isDragging.value || rightResize.isDragging.value }">
  <NotificationBanner
    :sessions="pendingSessionInfos"
    :visible="bannerVisible"
    @navigate="onBannerNavigate"
    @dismiss="onBannerDismiss"
  />

  <!-- Left panel -->
  <div class="panel-left" :class="{ collapsed: leftCollapsed }">
    <div
      class="collapse-toggle collapse-toggle-left"
      :title="leftCollapsed ? '展开侧栏' : '收起侧栏'"
      @click.stop="leftCollapsed = !leftCollapsed"
    >
      <span class="collapse-arrow">{{ leftCollapsed ? '▶' : '◀' }}</span>
    </div>
    <SidebarLeft
      v-show="!leftCollapsed"
      ref="sidebarRef"
      :active-session-id="activeSessionId"
      @session-changed="onSessionChanged"
      @workspace-changed="onSidebarWsChanged"
      @open-settings="openSettings"
      @open-workbench="wb.toggle(workspacePath)"
      @provider-switch="onProviderSwitch"
      @open-settings-providers="openSettingsProviders"
    />
  </div>

  <!-- Left resize handle -->
  <div
    v-show="!leftCollapsed"
    class="resize-handle"
    :class="{ active: leftResize.isDragging.value }"
    @mousedown="leftResize.onMousedown"
  />

  <!-- Center panel -->
  <div class="panel-center">
    <TerminalPanel
      ref="terminalPanelRef"
      :session-id="activeSessionId"
      @session-updated="onSessionUpdated"
    />
  </div>

  <!-- Right resize handle -->
  <div
    v-show="!rightCollapsed"
    class="resize-handle"
    :class="{ active: rightResize.isDragging.value }"
    @mousedown="rightResize.onMousedown"
  />

  <!-- Right panel -->
  <div class="panel-right" :class="{ collapsed: rightCollapsed }">
    <div
      class="collapse-toggle collapse-toggle-right"
      :title="rightCollapsed ? '展开侧栏' : '收起侧栏'"
      @click.stop="rightCollapsed = !rightCollapsed"
    >
      <span class="collapse-arrow">{{ rightCollapsed ? '◀' : '▶' }}</span>
    </div>
    <div v-show="!rightCollapsed" class="panel-right-inner">
      <ATabBar :tabs="rightTabs" v-model="rightTab" />

      <div class="tab-content">
        <FileTree v-show="rightTab === 'files'" ref="fileTreeRef" :session-id="activeSessionId" />
        <ChangeLogPanel v-show="rightTab === 'changes'" :session-id="activeSessionId" />
        <GitPanel v-show="rightTab === 'git'" ref="gitPanelRef" />
      </div>
    </div>
  </div>

  <ContextMenu />
  <ModalDialog />
  <SettingsPanel v-if="settingsVisible" :initial-tab="settingsInitialTab" @close="settingsVisible = false" />
  <FileViewer />
  <WorkbenchTerminal :cwd="workspacePath" :height="workbenchHeight" @update:height="onWorkbenchHeightChange" />
  <ACommandPalette ref="paletteRef" :open="paletteOpen" @close="paletteOpen = false" />
</div>
```

- [ ] **Step 4: Rewrite `App.vue` scoped styles for Grid layout**

Replace `.app-layout`, `.panel-left`, `.panel-center`, `.panel-right`, `.resize-handle` styles:

```css
.app-layout {
  display: grid;
  grid-template-columns:
    var(--aide-left-w, 280px)
    1px
    minmax(400px, 1fr)
    1px
    var(--aide-right-w, 300px);
  grid-template-rows: 1fr;
  flex: 1;
  min-height: 0;
  width: 100%;
  background-color: var(--aide-bg-base);
  user-select: none;
}

.app-layout.is-dragging {
  user-select: none;
  cursor: col-resize;
}

.panel-left {
  height: 100%;
  background-color: var(--aide-bg-deep);
  border-right: 1px solid var(--aide-border);
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  min-width: 0;
}

.panel-left.collapsed {
  width: 10px !important;
  min-width: 10px;
}

.panel-center {
  height: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background-color: var(--aide-bg-base);
}

.panel-right {
  height: 100%;
  background-color: var(--aide-bg-deep);
  border-left: 1px solid var(--aide-border);
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  min-width: 0;
}

.panel-right.collapsed {
  width: 10px !important;
  min-width: 10px;
}

.resize-handle {
  width: 1px;
  background: var(--aide-border);
  cursor: col-resize;
  position: relative;
  transition: background 0.15s;
}

.resize-handle::after {
  content: '';
  position: absolute;
  left: -3px;
  right: -3px;
  top: 0;
  bottom: 0;
}

.resize-handle:hover,
.resize-handle.active {
  background: var(--aide-accent);
  box-shadow: 0 0 8px color-mix(in srgb, var(--aide-accent) 20%, transparent);
}
```

Remove the old `.resize-handle-h` styles (no longer needed — ChangeLog is a standalone tab).

Remove the old `.right-tab-bar`, `.right-tab`, `.right-tab-icon`, `.right-tab-label`, `.right-tab-badge` styles (replaced by ATabBar).

- [ ] **Step 5: Update `ChangeLogPanel.vue` — remove collapse logic**

In `src/components/ChangeLogPanel.vue`:

Remove the `emit` definition for `collapse-changed`.
Remove the `collapsed` ref, `toggleCollapsed` function.
Remove the collapse arrow from the header.
Change the header to a simple non-clickable label.
Make the component always-expanded (it now occupies its own full tab).

Replace the template:

```vue
<template>
  <div class="changelog">
    <div class="changelog-header">
      <span class="changelog-dot">●</span>
      <span class="changelog-title">会话变更</span>
      <span v-if="totalFiles > 0" class="changelog-badge">{{ totalFiles }}</span>
    </div>

    <div class="changelog-body">
      <template v-if="rounds.length === 0">
        <div class="changelog-empty">暂无变更记录</div>
      </template>
      <template v-else>
        <div v-for="round in displayedRounds" :key="round.index" class="changelog-round">
          <div class="changelog-round-header">
            <span class="changelog-round-label">轮 {{ round.index }}</span>
            <span class="changelog-round-time">{{ round.time }}</span>
            <button
              v-if="round.files.length > 0"
              class="changelog-round-revert"
              title="撤回本轮"
              @click="revertRound(round)"
            >↶</button>
          </div>
          <div v-if="round.files.length === 0" class="changelog-nochange">无变更</div>
          <div
            v-for="f in round.files"
            :key="f.path"
            class="changelog-file"
            @click="openFile(resolvePath(f.path))"
          >
            <span class="changelog-file-status" :class="f.status === 'A' ? 'status-A' : 'status-M'">{{ f.status || 'M' }}</span>
            <span class="changelog-file-path" :title="f.path">{{ f.path }}</span>
            <span v-if="f.additions > 0 || f.deletions > 0" class="changelog-file-stats">
              <span v-if="f.additions > 0" class="stat-add">+{{ f.additions }}</span>
              <span v-if="f.additions > 0 && f.deletions > 0" class="stat-sep"> </span>
              <span v-if="f.deletions > 0" class="stat-del">-{{ f.deletions }}</span>
            </span>
            <button
              class="changelog-file-revert"
              title="撤回此文件"
              @click.stop="revertSingleFile(round, f.path)"
            >↶</button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
```

In the script, remove `collapsed` ref, `toggleCollapsed` function, and the `emit` definition. Remove the `:class="{ collapsed }"` from the root div.

Update styles: remove `.changelog.collapsed` and `.changelog-arrow` styles. Make `.changelog` take full height:

```css
.changelog {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--aide-bg-deep);
  overflow: hidden;
}

.changelog-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--aide-text-secondary);
  flex-shrink: 0;
  border-bottom: 1px solid var(--aide-border);
}

.changelog-body {
  flex: 1;
  overflow-y: auto;
}
```

- [ ] **Step 6: Update `rightTab` type in `App.vue`**

Change:

```ts
const rightTab = ref<"files" | "git">("files");
```

To:

```ts
const rightTab = ref<"files" | "changes" | "git">("files");
```

- [ ] **Step 7: Verify**

Run `pnpm dev`. Test:
1. Three-column grid layout renders correctly
2. Left/right panels resize by dragging the 1px handles
3. Resize handles glow amber on hover
4. Right panel has three tabs: 文件 / 变更 / Git
5. Switching tabs shows correct content
6. Changes tab shows conversation change rounds (previously nested under files)
7. Badges show counts correctly
8. Collapse toggles still work
9. No vertical resize handle between FileTree and ChangeLog (gone)

- [ ] **Step 8: Commit**

```bash
git add src/composables/useResizable.ts src/App.vue src/components/ChangeLogPanel.vue
git commit -m "feat: CSS Grid layout + three-tab right panel + useResizable composable"
```

---

### Task 7: Terminal Toolbar

**Files:**
- Modify: `src/components/TerminalPanel.vue`

**Interfaces:**
- Consumes: `AToolbar`, `AStatusDot`, `AButton` from `src/ui/`, `useSessionState` from composables
- Produces: same external API as before

- [ ] **Step 1: Add imports to `TerminalPanel.vue`**

```ts
import { AToolbar, AStatusDot, AButton } from "../ui";
```

- [ ] **Step 2: Add session name and status computed**

```ts
const { state: sessionState } = useSessionState();

const currentStatus = computed(() => {
  const sid = props.sessionId;
  if (!sid) return "stopped" as const;
  return (sessionState[sid] || "stopped") as "stopped" | "running" | "waiting" | "attention";
});

const sessionName = computed(() => {
  const sid = props.sessionId;
  if (!sid) return "";
  if (sid.startsWith("new_")) return "新会话";
  return sid.substring(0, 8);
});

const isLive = computed(() => liveDisplayIds.has(props.sessionId));
```

- [ ] **Step 3: Replace template**

Replace the `<template>` block in `TerminalPanel.vue`:

```vue
<template>
  <div class="terminal-panel">
    <AToolbar>
      <template #left>
        <AStatusDot :status="currentStatus" />
        <span class="toolbar-session-name">{{ sessionName }}</span>
      </template>
      <template #right>
        <AButton v-if="!isLive" variant="ghost" size="sm" @click="tryStartClaude">
          ▶ 启动
        </AButton>
        <AButton v-if="isLive" variant="danger" size="sm" @click="stopClaude(props.sessionId)">
          ⏹ 停止
        </AButton>
      </template>
    </AToolbar>
    <div ref="stackRef" class="terminal-stack">
      <div
        ref="previewRef"
        class="terminal-container preview-container"
        tabindex="0"
        @keydown="onPreviewKeydown"
      >
        <div v-if="props.sessionId && props.sessionId.startsWith('new_')" class="preview-empty" @click="onPreviewClick">
          <div class="preview-empty__title">New Session</div>
          <div class="preview-empty__hint">Press Enter or click Start</div>
        </div>
        <template v-else-if="previewHtml">
          <div class="preview-messages" v-html="previewHtml"></div>
          <div class="preview-footer" @click="onPreviewClick">Press Enter to continue</div>
        </template>
        <div v-else class="preview-empty" @click="onPreviewClick">
          <div class="preview-empty__title">Session {{ (props.sessionId || '').substring(0, 8) }}</div>
          <div class="preview-empty__hint">Press Enter or click Start</div>
        </div>
      </div>
    </div>
  </div>
</template>
```

Remove the old floating `<button class="close-btn">` — the AToolbar's stop button replaces it.

- [ ] **Step 4: Update styles**

Add the toolbar session name style:

```css
.toolbar-session-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--aide-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

Remove the old `.close-btn` styles from the scoped block.

- [ ] **Step 5: Verify**

Run `pnpm dev`. Test:
1. Toolbar appears above the terminal with status dot + session name
2. New session shows "▶ 启动" button
3. Clicking "▶ 启动" starts Claude (same as Enter)
4. Running session shows "⏹ 停止" button with red style
5. Clicking stop terminates the session
6. Status dot syncs with sidebar card status

- [ ] **Step 6: Commit**

```bash
git add src/components/TerminalPanel.vue
git commit -m "feat: terminal AToolbar with status dot, session name, start/stop buttons"
```

---

### Task 8: Global Style Migration + Theme Switching

**Files:**
- Modify: `src/styles/global.css` (remove legacy aliases)
- Modify: all components with hardcoded old CSS variables (batch find-replace)
- Modify: `src/types.ts` (add `theme` to `AppSettings`)
- Modify: `src/composables/useSettings.ts` (load/save theme)
- Modify: `src-tauri/src/commands/settings.rs` (add `theme` field)
- Modify: `src/components/SettingsPanel.vue` (add theme selector)
- Modify: `src/App.vue` (apply theme from settings)
- Delete: `src/components/SettingsModal.vue`

**Interfaces:**
- Consumes: `themes` registry from `src/themes/`, `applyTheme` from `src/themes/`
- Produces: `AppSettings.theme` field, theme dropdown in Settings

- [ ] **Step 1: Global find-replace old CSS variables in all `.vue` files**

Search all `.vue` and `.css` files for old variable references and replace with new `--aide-*` names:

| Find | Replace |
|------|---------|
| `var(--bg-primary)` | `var(--aide-bg-base)` |
| `var(--bg-secondary)` | `var(--aide-bg-deep)` |
| `var(--bg-tertiary)` | `var(--aide-bg-deep)` |
| `var(--surface-hover)` | `var(--aide-surface-hover)` |
| `var(--surface)` | `var(--aide-surface-default)` |
| `var(--text-primary)` | `var(--aide-text-primary)` |
| `var(--text-secondary)` | `var(--aide-text-secondary)` |
| `var(--text-muted)` | `var(--aide-text-muted)` |
| `var(--accent-green)` | `var(--aide-success)` |
| `var(--accent-yellow)` | `var(--aide-warning)` |
| `var(--accent-red)` | `var(--aide-danger)` |
| `var(--accent)` | `var(--aide-accent)` |

Important: replace `var(--surface-hover)` BEFORE `var(--surface)` since `--surface` is a substring match. Similarly replace `var(--accent-green)`, `var(--accent-yellow)`, `var(--accent-red)` BEFORE `var(--accent)`.

Also search for remaining hardcoded hex colors that should use variables:
- `#89b4fa` → `var(--aide-accent)` (in catppuccin theme) or `var(--aide-info)` context-dependent
- `#f38ba8` → `var(--aide-danger)`
- `#a6e3a1` → `var(--aide-success)`
- `#f9e2af` → `var(--aide-warning)`
- `#cba6f7` → keep as-is (syntax highlighting, not themeable)
- `#fab387` → keep as-is (syntax highlighting)
- `#1e1e2e` → `var(--aide-bg-base)`

- [ ] **Step 2: Remove legacy aliases from `global.css`**

Remove the entire legacy alias block added in Task 1 Step 6 (the `--bg-primary: var(--aide-bg-base)` etc. lines).

- [ ] **Step 3: Add `theme` to `AppSettings` in `src/types.ts`**

```ts
export interface AppSettings {
  fontSize: number;
  fontFamily: string;
  notificationsEnabled: boolean;
  proxy: string;
  shellPath: string;
  workbenchHeight: number;
  keybindings: Keybindings;
  theme: string;
}
```

- [ ] **Step 4: Add `theme` to Rust `AppSettings` in `src-tauri/src/commands/settings.rs`**

Add to the struct:

```rust
#[serde(default = "default_theme")]
pub theme: String,
```

Add default function:

```rust
fn default_theme() -> String { "warm-dark".to_string() }
```

Add to `Default` impl:

```rust
theme: default_theme(),
```

- [ ] **Step 5: Update `useSettings.ts`**

Add `theme` to defaults:

```ts
const defaults: AppSettings = {
  fontSize: 14,
  fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
  notificationsEnabled: true,
  proxy: "",
  shellPath: "",
  workbenchHeight: 0,
  keybindings: { searchOpen: "Ctrl+P" },
  theme: "warm-dark",
};
```

Add `theme` to the `load()` function:

```ts
settings.theme = s.theme ?? defaults.theme;
```

Add `theme` to the `update()` function:

```ts
if (partial.theme !== undefined) settings.theme = partial.theme;
```

- [ ] **Step 6: Apply theme from settings in `App.vue`**

In `onMounted`, replace the bare `applyTheme(warmDark)` with:

```ts
import { applyTheme, themes } from "./themes";

// In onMounted, after loadSettings():
const themeId = settings.theme || "warm-dark";
const themeTokens = themes[themeId] || themes["warm-dark"];
applyTheme(themeTokens);
```

- [ ] **Step 7: Add theme selector to `SettingsPanel.vue`**

In the "通用" tab template section, add after the proxy input:

```vue
<div class="settings-row">
  <label class="settings-label">主题</label>
  <select
    class="settings-select"
    :value="settings.theme"
    @change="onThemeChange(($event.target as HTMLSelectElement).value)"
  >
    <option value="warm-dark">Warm Dark</option>
    <option value="catppuccin">Catppuccin Mocha</option>
  </select>
</div>
```

Add the handler in `<script setup>`:

```ts
import { applyTheme, themes } from "../themes";

function onThemeChange(themeId: string) {
  const tokens = themes[themeId];
  if (tokens) {
    applyTheme(tokens);
    update({ theme: themeId });
  }
}
```

Add the select style:

```css
.settings-select {
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  padding: 6px 10px;
  color: var(--aide-text-primary);
  font-size: 12px;
  font-family: inherit;
  outline: none;
  cursor: pointer;
}
.settings-select:focus {
  border-color: var(--aide-accent);
}
```

- [ ] **Step 8: Delete `src/components/SettingsModal.vue`**

```bash
git rm src/components/SettingsModal.vue
```

Verify no remaining imports reference it (grep for `SettingsModal`).

- [ ] **Step 9: Verify**

Run `pnpm dev`. Test:
1. App launches with warm-dark theme
2. Open Settings → 通用 → Theme dropdown visible
3. Switch to "Catppuccin Mocha" → all colors change to blue-toned Catppuccin instantly
4. Switch back to "Warm Dark" → amber/warm colors restored
5. Reload app → persisted theme is applied
6. All components render correctly under both themes — no hardcoded colors visible

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: global CSS variable migration + theme switching (warm-dark / catppuccin)"
```
