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
