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
