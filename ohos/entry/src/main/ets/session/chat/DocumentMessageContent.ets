import { ChatMessage, ContentBlock, TextBlock } from './ChatBlocks';
import { ArtifactTextSource, DocumentArtifact, DocumentPresentation, collectDocumentArtifacts } from './DocumentArtifacts';
import { MarkdownText } from './MarkdownText';
import { chatModel } from '../ChatModel';

/** 只用于 assistant 聊天正文。文件预览、用户引用与普通 Markdown 不解释成果协议。 */
@ComponentV2
export struct DocumentMessageContent {
  @Param message: ChatMessage = new ChatMessage();
  @Param workspaceRoot: string = '';
  @BuilderParam renderBlock: (block: ContentBlock, live: boolean) => void = this.emptyBlock;

  @Builder
  emptyBlock(block: ContentBlock, live: boolean) {}

  @Computed
  get presentation(): DocumentPresentation {
    if (this.message.streaming || this.message.role !== 'assistant') return new DocumentPresentation();
    const sources: ArtifactTextSource[] = this.message.blocks.map((b: ContentBlock): ArtifactTextSource => {
      return { type: b.type, text: b instanceof TextBlock ? b.text : '' };
    });
    return collectDocumentArtifacts(sources, this.workspaceRoot);
  }

  private textOf(b: ContentBlock, index: number): string {
    const cleaned: string | undefined = this.presentation.texts.get(index);
    return cleaned !== undefined ? cleaned : (b instanceof TextBlock ? b.text : '');
  }

  @Builder
  documentCard(document: DocumentArtifact) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 12 }) {
        SymbolGlyph($r('sys.symbol.doc'))
          .fontSize(24)
          .fontColor([$r('app.color.accent')])
        Column({ space: 4 }) {
          Text(document.title)
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary'))
            .width('100%')
          Text(document.path)
            .fontSize(11)
            .fontFamily('monospace')
            .fontColor($r('app.color.text_secondary'))
            .width('100%')
          if (document.summary !== '') {
            Text(document.summary)
              .fontSize(12)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
          }
          Text(/\.txt$/i.test(document.path) ? '纯文本 · 打开文档' : 'Markdown · 打开文档')
            .fontSize(11)
            .fontColor($r('app.color.text_secondary'))
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        Text('↗').fontSize(14).fontColor($r('app.color.text_secondary'))
      }
      .width('100%')
      .alignItems(VerticalAlign.Top)
    }
    .width('100%')
    .padding(14)
    .borderRadius(10)
    .backgroundColor($r('app.color.card_bg'))
    .border({ width: 1, color: $r('app.color.line') })
    .accessibilityText(`打开文档：${document.title}`)
    .onClick(() => { chatModel.openDocumentArtifact(document.path); })
  }

  build() {
    Column({ space: 8 }) {
      ForEach(this.message.blocks, (b: ContentBlock, index: number) => {
        if (b instanceof TextBlock) {
          if (this.textOf(b, index).trim() !== '') {
            MarkdownText({ raw: this.textOf(b, index), live: this.message.streaming && index === this.message.blocks.length - 1 })
          }
        } else {
          this.renderBlock(b, this.message.streaming && index === this.message.blocks.length - 1)
        }
      }, (b: ContentBlock) => b.id)
      ForEach(this.presentation.documents, (document: DocumentArtifact) => {
        this.documentCard(document)
      }, (document: DocumentArtifact) => document.path)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
