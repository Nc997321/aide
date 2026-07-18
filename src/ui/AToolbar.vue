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
  gap: 2px;
  height: auto;
  padding: 4px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-md);
  box-shadow: var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  flex-shrink: 0;
}

.a-toolbar__left {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}

.a-toolbar__center {
  flex: 1;
}

.a-toolbar__right {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

/* 图标按钮（GALLERY .tbtn 的映射）：供 slot 内的按钮使用 */
.a-toolbar__btn {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--aide-text-muted);
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
  transition: all var(--aide-ease-t);
}

.a-toolbar__btn:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}

.a-toolbar__btn.active {
  background: var(--aide-accent-subtle);
  color: var(--aide-accent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--aide-accent) 25%, transparent);
}

.a-toolbar__sep {
  width: 1px;
  height: 16px;
  background: var(--aide-border);
  margin: 0 4px;
}

.a-toolbar__spacer {
  flex: 1;
}
</style>
