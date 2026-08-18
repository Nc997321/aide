// pdf 工具共享常量（与 docx/constants.ts 同语义，PDF 场景独立取值）

/** 单次解析返回的字符上限。超出截断并置 truncated:true，避免爆 agent context。 */
export const PDF_MAX_CHARS = 60_000;

/** statSync 守卫：超过此字节的 .pdf 不读进内存（OOM/慢），handler 层用。 */
export const PDF_MAX_BYTES = 100 * 1024 * 1024;

/** 不传 pages 时默认读取的页数上限（≤ 此值读全部，> 此值只读前几页并提示用 pages）。 */
export const PDF_DEFAULT_PAGE_LIMIT = 20;

/** 大 PDF 不传 pages 时默认只读前几页（让模型先看开头再决定读哪些页）。 */
export const PDF_PREVIEW_PAGES = 5;

/** 单次 pages 参数允许的最大页数（防模型一次要 500 页爆 context）。 */
export const PDF_MAX_PAGES_PER_READ = 100;

/** 布局重建：同一行 y 坐标容差（pt），超过视为换行。 */
export const PDF_LINE_Y_TOLERANCE = 2;

/** 布局重建：同一行内 x 间隙超过此值（pt）插入空格（表格列分隔）。 */
export const PDF_COLUMN_GAP = 4;
