// docx 工具共享常量（原 parse.ts / gen.ts 各自定义，统一收敛到这里）

/** 单次解析返回的字符上限。超出截断并置 truncated:true，避免爆 agent context。 */
export const DOCX_MAX_CHARS = 60_000;

/** statSync 守卫：超过此字节的 .docx 不读进内存（OOM/慢），handler 层用。 */
export const DOCX_MAX_BYTES = 50 * 1024 * 1024;

/** 单次生成的 markdown 输入上限（字符）。超出报 invalid_arg，防爆内存/context。 */
export const DOCX_MAX_INPUT_CHARS = 200_000;

/** embed 图片字节上限：超过不读进内存，降级占位。 */
export const DOCX_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** embed 图片最大宽度（px），超出等比缩放。 */
export const DOCX_MAX_IMAGE_WIDTH = 480;

/** EMU → px 换算（1px = 9525 EMU，Word 默认 96dpi）。 */
export const EMU_PER_PX = 9525;

/** twips → 1/20 磅换算（列宽/缩进/间距用 twips 存储）。 */
export const TWIPS_PER_PT = 20;
