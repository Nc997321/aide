// pdfjs-dist 的 canvas 渲染模块在 import 时执行顶层 `new DOMMatrix()`（SCALE_MATRIX 初始化）。
// bun 运行时无 DOMMatrix/Path2D 全局（bun 1.3.14 实测 undefined），且 bun build --compile
// 会把 pdfjs 的动态 import 静态打包 → canvas 模块在 exe 启动时立即执行 → ReferenceError
// （bun 直接跑源码时动态 import 保持动态、canvas 模块不加载，所以不崩——compile 才崩）。
//
// 文本提取不渲染，本 polyfill 只让模块加载通过；矩阵方法按 2D 变换正确实现（渲染路径
// 不会走到，但实现正确以防万一）。必须在 import pdfjs 之前副作用加载（见 parse.ts 顶部）。

class DOMMatrixPolyfill {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  constructor(init?: number[] | string) {
    if (Array.isArray(init)) {
      if (init.length >= 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = init;
      }
    } else if (typeof init === "string" && init.trim() !== "") {
      // "matrix(a,b,c,d,e,f)" / "matrix3d(...)" — 取前 6 个数字
      const nums = init.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      if (nums.length >= 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = nums;
      }
    }
  }

  /** this = this × m */
  multiplySelf(m: DOMMatrixPolyfill): this {
    const { a, b, c, d, e, f } = this;
    this.a = a * m.a + c * m.b;
    this.b = b * m.a + d * m.b;
    this.c = a * m.c + c * m.d;
    this.d = b * m.c + d * m.d;
    this.e = a * m.e + c * m.f + e;
    this.f = b * m.e + d * m.f + f;
    return this;
  }

  /** this = m × this */
  preMultiplySelf(m: DOMMatrixPolyfill): this {
    const { a, b, c, d, e, f } = m;
    this.a = a * this.a + c * this.b;
    this.b = b * this.a + d * this.b;
    this.c = a * this.c + c * this.d;
    this.d = b * this.c + d * this.d;
    this.e = a * this.e + c * this.f + e;
    this.f = b * this.e + d * this.f + f;
    return this;
  }

  invertSelf(): this {
    const { a, b, c, d, e, f } = this;
    const det = a * d - b * c;
    if (det === 0) return this;
    this.a = d / det;
    this.b = -b / det;
    this.c = -c / det;
    this.d = a / det;
    this.e = (c * f - d * e) / det;
    this.f = (b * e - a * f) / det;
    return this;
  }

  translate(x: number, y: number): this {
    this.e += this.a * x + this.c * y;
    this.f += this.b * x + this.d * y;
    return this;
  }

  scale(x: number, y: number): this {
    this.a *= x;
    this.b *= x;
    this.c *= y;
    this.d *= y;
    return this;
  }

  transformPoint(p: { x: number; y: number }): { x: number; y: number } {
    return {
      x: this.a * p.x + this.c * p.y + this.e,
      y: this.b * p.x + this.d * p.y + this.f,
    };
  }
}

class Path2DPolyfill {
  addPath(): void {
    // no-op：文本提取不渲染，addPath 只被 canvas 渲染路径调用
  }
}

if (!("DOMMatrix" in globalThis)) {
  (globalThis as Record<string, unknown>).DOMMatrix = DOMMatrixPolyfill;
}
if (!("Path2D" in globalThis)) {
  (globalThis as Record<string, unknown>).Path2D = Path2DPolyfill;
}
