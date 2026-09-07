/**
 * 供应商品牌商标（桌面 providerLogos.ts 的 ohos 渲染端）。
 *
 * 数据：resources/base/media/pv_<kind>.svg，脚本从桌面 simple-icons 单 path
 * 生成，勿手改——以 packages/aide-sdk/src/utils/providerLogos.ts 为单一权威源。
 * 渲染约定与桌面/remote-pwa 一致：
 *   · 品牌色商标（system_default/deepseek/zhipu/qwen）固定官方色，浅深主题均可辨；
 *   · mono 商标（ollama/kimi，官方纯黑 mark）SVG 不烧 fill，由 tint 随上下文
 *     前景色着色——忠于品牌同时保证深浅主题可见性；
 *   · 无条目（cpa_gpt/custom/未知 kind）→ 桌面侧配置的 icon 字符 → 名称首字母。
 */
import { ProviderConfigView } from '../sdk/types';

/** kind → 商标资源；无条目返回 null（回退 icon 字符/首字母）。 */
function logoRes(kind: string): Resource | null {
  switch (kind) {
    case 'system_default':
      return $r('app.media.pv_system_default');
    case 'ollama':
      return $r('app.media.pv_ollama');
    case 'kimi':
      return $r('app.media.pv_kimi');
    case 'deepseek':
      return $r('app.media.pv_deepseek');
    case 'zhipu':
      return $r('app.media.pv_zhipu');
    case 'qwen':
      return $r('app.media.pv_qwen');
    default:
      return null;
  }
}

/** mono 商标（官方纯黑 mark）：SVG 不烧色，渲染时以 tint 着色。 */
function isMonoKind(kind: string): boolean {
  return kind === 'ollama' || kind === 'kimi';
}

/** 供应商商标三态渲染：品牌色 → mono(tint) → icon 字符 → 首字母（null → ?）。 */
@ComponentV2
export struct ProviderMark {
  /** 供应商配置视图；null（未激活/加载中）回退 ?。 */
  @Param p: ProviderConfigView | null = null;
  /** 商标边长（px）；回退字号同值。 */
  @Param markSize: number = 14;
  /** mono 商标与字母回退的着色；品牌色商标忽略。 */
  @Param tint: ResourceColor = $r('app.color.text_primary');

  build() {
    if (this.p !== null && logoRes(this.p.kind) !== null) {
      if (isMonoKind(this.p.kind)) {
        Image(logoRes(this.p.kind))
          .width(this.markSize)
          .height(this.markSize)
          .fillColor(this.tint)
      } else {
        Image(logoRes(this.p.kind))
          .width(this.markSize)
          .height(this.markSize)
      }
    } else if (this.p !== null && this.p.icon !== '') {
      Text(this.p.icon)
        .fontSize(this.markSize)
    } else {
      Text(this.p !== null && this.p.name.length > 0 ? this.p.name.substring(0, 1).toUpperCase() : '?')
        .fontSize(this.markSize)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.tint)
    }
  }
}
