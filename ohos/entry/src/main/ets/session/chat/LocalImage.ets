/**
 * 回复里的本地图片（`![说明](路径)`，见 Markdown.localImagePath）：经 Host 的
 * read_file_base64 读出字节显示——图在 Host 上（可能是 WSL / SSH），手机上本来就没有。
 * 对照桌面 src/utils/localImages.ts。
 *
 * - 相对路径按会话所在工作区解析（agent 被要求写绝对路径，相对的是兜底）
 * - 点图 = 文件预览看大图（ChatModel.openWorkspaceFile，同一道 Host 读文件闸）
 * - 读失败显示虚线框 + 路径 + 原因，不吞内容；手机显示不了的格式同样如实说
 */
import { api } from '../../sdk/api';
import { chatModel } from '../ChatModel';
import { imageMime } from './ChatWire';

/** 同一路径短时间内只读一次：流式期间尾段每次重排都会重建这个组件。过期后重读——
 *  agent 常对同一个文件反复出图，新消息要看到新内容。 */
const FRESH_MS: number = 3000;
/** data URI 常驻内存，条目数收紧。 */
const MAX_ENTRIES: number = 16;

class Entry {
  at: number;
  uri: Promise<string>;

  constructor(at: number, uri: Promise<string>) {
    this.at = at;
    this.uri = uri;
  }
}

const cache: Map<string, Entry> = new Map<string, Entry>();

function load(path: string, mime: string): Promise<string> {
  const now: number = Date.now();
  const hit: Entry | undefined = cache.get(path);
  if (hit !== undefined && now - hit.at < FRESH_MS) {
    return hit.uri;
  }
  cache.delete(path);
  const uri: Promise<string> = api.readFileBase64(path).then((b64: string) => `data:${mime};base64,${b64}`);
  const entry: Entry = new Entry(now, uri);
  cache.set(path, entry);
  // 读失败不缓存：文件可能稍后才写出来
  uri.catch(() => {
    if (cache.get(path) === entry) {
      cache.delete(path);
    }
  });
  while (cache.size > MAX_ENTRIES) {
    const oldest: string = cache.keys().next().value as string;
    cache.delete(oldest);
  }
  return uri;
}

@ComponentV2
export struct LocalImage {
  /** markdown 里写的路径（未解析）。 */
  @Param src: string = '';
  @Param alt: string = '';
  @Local state: string = 'loading';
  @Local uri: string = '';
  @Local reason: string = '';
  private path: string = '';

  aboutToAppear(): void {
    this.start();
  }

  @Monitor('src')
  onSrcChange(m: IMonitor): void {
    this.start();
  }

  private start(): void {
    const path: string = chatModel.resolveHostPath(this.src);
    this.path = path;
    const mime: string = imageMime(path);
    if (mime === '') {
      this.state = 'error';
      this.reason = '手机端暂不支持显示这种图片格式';
      return;
    }
    this.state = 'loading';
    load(path, mime).then((uri: string) => {
      if (this.path !== path) {
        return; // 路径已变（流式重排）：丢弃过期结果
      }
      this.uri = uri;
      this.state = 'ok';
    }).catch((e: Object) => {
      if (this.path !== path) {
        return;
      }
      this.state = 'error';
      this.reason = e instanceof Error ? e.message : String(e);
    });
  }

  build() {
    if (this.state === 'ok') {
      Image(this.uri)
        .objectFit(ImageFit.Contain)
        .constraintSize({ maxWidth: '100%', maxHeight: 360 })
        .borderRadius(8)
        .onError(() => {
          this.state = 'error';
          this.reason = '图片解码失败';
        })
        .onClick(() => {
          chatModel.openWorkspaceFile(this.path);
        })
    } else if (this.state === 'loading') {
      Row({ space: 8 }) {
        LoadingProgress().width(14).height(14).color($r('app.color.accent'))
        Text(this.alt !== '' ? this.alt : '正在读取图片…')
          .fontSize(12)
          .fontColor($r('app.color.text_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
      }
      .width('100%')
      .height(56)
      .padding({ left: 12, right: 12 })
      .borderRadius(8)
      .backgroundColor($r('app.color.card_bg'))
      .alignItems(VerticalAlign.Center)
    } else {
      Column({ space: 4 }) {
        Text(this.alt !== '' ? `图片读取失败：${this.alt}` : '图片读取失败')
          .fontSize(12)
          .fontColor($r('app.color.text_primary'))
          .width('100%')
        Text(this.path)
          .fontSize(11)
          .fontFamily('monospace')
          .fontColor($r('app.color.text_secondary'))
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        if (this.reason !== '') {
          Text(this.reason)
            .fontSize(11)
            .fontColor($r('app.color.status_danger'))
            .maxLines(3)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
        }
      }
      .width('100%')
      .padding(12)
      .borderRadius(8)
      .border({ width: 1, color: $r('app.color.line'), style: BorderStyle.Dashed })
      .alignItems(HorizontalAlign.Start)
    }
  }
}
