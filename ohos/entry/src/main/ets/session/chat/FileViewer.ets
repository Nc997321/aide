/**
 * 文件预览层（readChip 点击经 ChatStore.openFilePreview 打开的全屏浮层）。
 *
 * 内容零 I/O：正文即 Read 卡内存快照（≤50k 字），按扩展名分流渲染——
 *  - md/markdown → 复用 MarkdownText（标题/列表/代码块全量渲染）
 *  - 其余非空文本 → monospace 原文（对照 MarkdownText code 块观感）
 *  - 空文本 → 居中占位（引用缺内容/被清理的场景）
 * 关闭：标题栏 ← 键（onClose → store.closeFilePreview）；系统返回键走
 * Index.onBackPress → ChatStore.handlePopups 统一收。层级：自动化浮层
 * 之上、灯箱之下（页面根 Stack 挂载，关闭即卸载零渲染）。
 * 视觉基线照灯箱：全屏 page_bg + 200ms 淡入淡出；标题栏 = 32 圆钮 +
 * 扩展名徽标（ChatWire.extBadgeColor 统一配色）+ 文件名/路径两行。
 */
import { MarkdownText } from './MarkdownText';
import { extBadgeColor } from './ChatWire';

/** 标题栏高度（32 圆钮 + 上下留白 12）。 */
const FV_HEADER_H: number = 56;

/** 路径取末段文件名（无分隔符原样返回；末段空 = 目录式路径，回退整串）。 */
function baseName(path: string): string {
  const i: number = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (i < 0 || i === path.length - 1) {
    return path;
  }
  return path.substring(i + 1);
}

/** 扩展名（小写、无点；无后缀/末点结尾 = 空串）。 */
function extOf(name: string): string {
  const i: number = name.lastIndexOf('.');
  if (i < 0 || i === name.length - 1) {
    return '';
  }
  return name.substring(i + 1).toLowerCase();
}

/** 字节数人类可读（B / KB / MB）。 */
function byteLabel(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

@ComponentV2
export struct FileViewer {
  /** 展示标题（readChip 传入 = file_path；兜底工具名）。 */
  @Param title: string = '';
  /** 正文全文（Read 卡 result 快照）。 */
  @Param content: string = '';
  /** 关闭回调（标题栏 ← 键；上层接 store.closeFilePreview）。 */
  @Param onClose: () => void = () => {};
  /** 预览种类（ChatStore.fvKind）：text 正文 / loading 拉取中 / image 图片 / other 文档 / error 失败。 */
  @Param kind: string = 'text';
  /** 图片 data: URI（kind = image）。 */
  @Param dataUri: string = '';
  /** 字节数（kind = image；0 = 未知）。 */
  @Param bytes: number = 0;
  /** 失败原文（kind = error）。 */
  @Param errorText: string = '';
  /** 图片解码后的像素尺寸（Image.onComplete 回填；0 = 未解码完）。 */
  @Local imgW: number = 0;
  @Local imgH: number = 0;

  /** 文件名（标题末段；空标题兜底「文件」）。 */
  private nameOf(): string {
    const n: string = baseName(this.title);
    return n !== '' ? n : '文件';
  }

  /** 扩展名（分流与徽标共用）。 */
  private extValue(): string {
    return extOf(baseName(this.title));
  }

  /** 图片信息行：像素尺寸（解码后）· 字节数 · 格式。 */
  private imageInfo(): string {
    const parts: string[] = [];
    if (this.imgW > 0 && this.imgH > 0) {
      parts.push(`${this.imgW} × ${this.imgH}`);
    }
    if (this.bytes > 0) {
      parts.push(byteLabel(this.bytes));
    }
    parts.push(this.extValue().toUpperCase());
    return parts.join(' · ');
  }

  /** 居中提示块（loading / other / error 共用）。 */
  @Builder
  centerNote(icon: Resource, title: string, sub: string) {
    Column({ space: 8 }) {
      SymbolGlyph(icon)
        .fontSize(40)
        .fontColor([$r('app.color.text_secondary')])
      Text(title)
        .fontSize(13)
        .fontColor($r('app.color.text_secondary'))
      if (sub !== '') {
        Text(sub)
          .fontSize(11.5)
          .fontColor($r('app.color.text_secondary'))
          .textAlign(TextAlign.Center)
          .padding({ left: 24, right: 24 })
      }
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
  }

  build() {
    Column() {
      Row({ space: 10 }) {
        Row() {
          SymbolGlyph($r('sys.symbol.chevron_left'))
            .fontSize(16)
            .fontColor([$r('app.color.text_primary')])
        }
        .width(32)
        .height(32)
        .borderRadius(16)
        .backgroundColor($r('app.color.card_bg'))
        .border({ width: 1, color: $r('app.color.line') })
        .justifyContent(FlexAlign.Center)
        .alignItems(VerticalAlign.Center)
        .onClick(() => {
          this.onClose();
        })

        Row() {
          Text(this.extValue() !== '' ? this.extValue() : '?')
            .fontSize(9.5)
            .fontWeight(FontWeight.Bold)
            .fontColor(Color.White)
        }
        .width(28)
        .height(28)
        .borderRadius(8)
        .backgroundColor(extBadgeColor(this.extValue()))
        .justifyContent(FlexAlign.Center)
        .alignItems(VerticalAlign.Center)

        Column({ space: 1 }) {
          Text(this.nameOf())
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          if (baseName(this.title) !== this.title) {
            Text(this.title)
              .fontSize(10.5)
              .fontColor($r('app.color.text_secondary'))
              .fontFamily('monospace')
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
      }
      .width('100%')
      .height(FV_HEADER_H)
      .padding({ left: 12, right: 16 })
      .alignItems(VerticalAlign.Center)

      if (this.kind === 'loading') {
        Column({ space: 10 }) {
          LoadingProgress().width(28).height(28).color($r('app.color.accent'))
          Text('正在从桌面读取…')
            .fontSize(13)
            .fontColor($r('app.color.text_secondary'))
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
      } else if (this.kind === 'error') {
        this.centerNote($r('sys.symbol.exclamationmark_circle'), '读取失败', this.errorText)
      } else if (this.kind === 'other') {
        this.centerNote($r('sys.symbol.doc'), '手机端暂不预览此类文件', '请在桌面端打开查看')
      } else if (this.kind === 'image') {
        Column({ space: 10 }) {
          Image(this.dataUri)
            .objectFit(ImageFit.Contain)
            .width('100%')
            .layoutWeight(1)
            .onComplete((e?: ImageCompleteCallback) => {
              if (e !== undefined) {
                this.imgW = e.width;
                this.imgH = e.height;
              }
            })
          Text(this.imageInfo())
            .fontSize(11.5)
            .fontColor($r('app.color.text_secondary'))
            .fontFamily('monospace')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .width('100%')
        .layoutWeight(1)
        .padding({ left: 16, right: 16, top: 12, bottom: 24 })
      } else if (this.content === '') {
        Column({ space: 8 }) {
          SymbolGlyph($r('sys.symbol.doc'))
            .fontSize(40)
            .fontColor([$r('app.color.text_secondary')])
          Text('无可预览内容')
            .fontSize(13)
            .fontColor($r('app.color.text_secondary'))
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
      } else if (this.extValue() === 'md' || this.extValue() === 'markdown') {
        Scroll() {
          Column() {
            MarkdownText({ raw: this.content })
          }
          .constraintSize({ minWidth: '100%' })
          .padding({ left: 16, right: 16, top: 12, bottom: 32 })
          .alignItems(HorizontalAlign.Start)
        }
        .layoutWeight(1)
        .align(Alignment.Top)
        .scrollBar(BarState.Auto)
        .edgeEffect(EdgeEffect.Spring)
      } else {
        Scroll() {
          Text(this.content)
            .fontSize(13)
            .fontFamily('monospace')
            .fontColor($r('app.color.text_primary'))
            .lineHeight(20)
            .width('100%')
            .padding({ left: 16, right: 16, top: 12, bottom: 32 })
        }
        .layoutWeight(1)
        .align(Alignment.Top)
        .scrollBar(BarState.Auto)
        .edgeEffect(EdgeEffect.Spring)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_bg'))
    .transition(TransitionEffect.OPACITY.animation({ duration: 200 }))
  }
}
