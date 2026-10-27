/** Add controls outside <code> so copied text preserves whitespace and excludes UI. */
export function hydrateCodeBlockCopy(root: HTMLElement | null): void {
  root?.querySelectorAll<HTMLElement>("pre").forEach((pre) => {
    if (!pre.querySelector("code") || pre.querySelector(".code-block-copy")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-block-copy";
    button.textContent = "复制";
    button.setAttribute("aria-label", "复制代码块");
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(pre.querySelector("code")?.textContent ?? "");
        button.textContent = "已复制";
      } catch {
        button.textContent = "复制失败";
      }
      setTimeout(() => { button.textContent = "复制"; }, 2000);
    });
    pre.append(button);
  });
}
