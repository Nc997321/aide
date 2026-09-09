/**
 * 输入区附件域：拍照/图片/视频/文件的选入、编码与发送载荷组装。
 *
 * 过筛对照：design/image-send/app.html 原型（.at-strip 附件条 + .plus-pop
 * 选入菜单）与 remote-pwa/src/imageEncode.ts（编码策略）。协议出口对齐桌面：
 *  - 图片（拍照/相册）：images 载荷 + display image 块（PWA 既有通路；空
 *    prompt 只发附件合法——mapper 对空 prompt 不加 text 块）
 *  - 视频：协议无视频通道，取首帧海报进 images + ohos 专有 display video
 *    块（poster/durationMs/name；桌面 blocksFromDisplay 未知类型安全跳过）
 *  - 文件：协议无 attachments 字段，文本类内容按桌面 mention 标记内联进
 *    prompt（fileMentions.ts 同格式，50k 字符截断对齐），display mention
 *    块 → 桌面 Read 卡（与历史重载的 transcript 拆分形态一致）
 * 编码策略（对照 PWA）：png/jpg/jpeg/webp/gif ≤1.5MB 直通原字节，否则重
 * 编码（长边 ≤1568 jpeg q85，>4.5MB 拒绝）；EXIF 方向经 PropertyKey.
 * ORIENTATION 读取、DecodingOptions.rotate 应用（缩略图与重编码共用；
 * 直通保持原字节——与 PWA 直通分支同语义）。
 * 资源纪律：fd / PixelMap / ImageSource / ImagePacker / AVImageGenerator /
 * AVMetadataExtractor 全部 finally 释放；视频开双 fd（generator 与
 * extractor 的 fdSrc 各持一个——fd 独占，media d.ts 明令）。
 * UI 反馈：条内编码/错误遮罩（点格移除）；轻提示经 pickToast 回调由页面
 * 注入（本模块不 import ChatDrawer——ChatDrawer → ChatModel → 本模块已
 * 成链，再回指 toastModel 即循环依赖）。
 */
import { cameraPicker, camera } from '@kit.CameraKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { picker, fileIo as fs, ReadOptions } from '@kit.CoreFileKit';
import { image } from '@kit.ImageKit';
import { media } from '@kit.MediaKit';
import { util } from '@kit.ArkTS';
import { common } from '@kit.AbilityKit';
import { SendImage, SendDisplayBlock } from '../../sdk/types';
import { uuid } from './ChatWire';

/** 附件上限（原型 MAX_ATTACH；＋格随余量显隐）。 */
const MAX_ATTACH: number = 5;
/** 重编码长边上限（对照 PWA imageEncode MAX_EDGE）。 */
const MAX_EDGE: number = 1568;
/** 直通阈值：≤1.5MB 的 png/jpg/jpeg/webp/gif 原样上送（PWA 同策略）。 */
const PASS_THROUGH_MAX: number = 1536 * 1024;
/** 重编码产物上限（PWA 4.5MB cap）。 */
const ENCODED_MAX: number = Math.floor(4.5 * 1024 * 1024);
/** 缩略图解码目标边长（附件条 64 + 气泡格 ≤220，两倍余量一图两用）。 */
const THUMB_EDGE: number = 256;
/** 视频首帧海报解码目标边长（气泡卡 200 宽 + 灯箱余量；超原尺寸不缩放）。 */
const POSTER_EDGE: number = 320;
/** 文件读取字节上限（512KB；超出拒绝——50k 字符内联远用不满）。 */
const FILE_READ_MAX: number = 512 * 1024;
/** 单文件内联字符上限（桌面 fileMentions MAX_MENTION_CHARS；截断后缀同格式）。 */
const MENTION_MAX_CHARS: number = 50000;

/** 文本类文件扩展名白名单（小写；内容再经 UTF-8 fatal 解码校验兜底拦二进制）。 */
const TEXT_EXTS: string[] = [
  'txt', 'md', 'json', 'json5', 'ts', 'ets', 'js', 'tsx', 'jsx', 'css', 'html',
  'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'sh', 'bat', 'ps1', 'py',
  'rs', 'go', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'sql',
  'vue', 'gradle', 'properties', 'log', 'csv', 'swift', 'm', 'mm', 'scala',
  'lua', 'pl', 'r', 'dart', 'proto'
];

function base64Of(buf: ArrayBuffer): string {
  return new util.Base64Helper().encodeToStringSync(new Uint8Array(buf));
}

/** 协议 mediaType 直通映射（重编码路径恒 image/jpeg）。 */
function mediaTypeOfExt(ext: string): string {
  if (ext === 'png') {
    return 'image/png';
  }
  if (ext === 'webp') {
    return 'image/webp';
  }
  if (ext === 'gif') {
    return 'image/gif';
  }
  return 'image/jpeg';
}

/** 选入 URI 末段作展示名（相册/文档 URI 已带文件名；解码失败回退原文）。 */
function uriName(uri: string): string {
  const raw: string = uri.substring(uri.lastIndexOf('/') + 1);
  let n: string = raw;
  try {
    n = decodeURIComponent(raw);
  } catch (e) {
    // 百分号序列不合法：回退原文
  }
  return n !== '' ? n : '未命名';
}

function sizeLabelOf(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** 视频时长徽标文案：m:ss（≥1h 才出 h 位）。 */
export function durationLabel(ms: number): string {
  const total: number = Math.floor(ms / 1000);
  const h: number = Math.floor(total / 3600);
  const m: number = Math.floor((total % 3600) / 60);
  const s: number = total % 60;
  if (h > 0) {
    return `${h}:${pad2(m)}:${pad2(s)}`;
  }
  return `${m}:${pad2(s)}`;
}

/**
 * EXIF Orientation → 旋转角（竖拍照片直立显示；缩略图与重编码共用）。
 * 属性返回可能是 EXIF 数字串或方位名（'Right-top' 等），两种形态都认；
 * 5/7 带镜像的罕见值只处理旋转角。
 */
function exifDegrees(raw: string): number {
  const v: string = raw.trim();
  if (v === '3' || v === 'Bottom-right') {
    return 180;
  }
  if (v === '6' || v === 'Right-top') {
    return 90;
  }
  if (v === '8' || v === 'Left-bottom') {
    return 270;
  }
  return 0;
}

/** 单个附件（附件条 + 气泡栅格共用一份缩略图）。 */
@ObservedV2
export class Attachment {
  id: string = '';
  /** 'image' | 'video' | 'file'。 */
  type: string = 'image';
  name: string = '';
  /** 小写无点扩展名（直通判定 / 文件卡徽标色）。 */
  ext: string = '';
  sizeLabel: string = '';
  /** 条 + 气泡缩略图（图 = 本图，视频 = 首帧；文件恒 null）。 */
  @Trace thumb: image.PixelMap | null = null;
  /** 'encoding' | 'ready' | 'error'。 */
  @Trace state: string = 'encoding';
  @Trace errorText: string = '';
  /** 视频时长（毫秒；AVMetadata.duration 为 string 毫秒，此处已数值化）。 */
  @Trace durationMs: number = 0;
  /** 上送载荷：图 = 本图 base64，视频 = 首帧 jpeg base64（均无 data: 前缀）。 */
  base64: string = '';
  mediaType: string = 'image/jpeg';
  /** 文件正文（≤50k 截断后）。 */
  text: string = '';

  constructor(type: string, name: string) {
    this.id = uuid();
    this.type = type;
    this.name = name;
    const dot: number = name.lastIndexOf('.');
    this.ext = dot >= 0 ? name.substring(dot + 1).toLowerCase() : '';
  }
}

/** 附件集合（单例：会话页输入区唯一宿主；发送后/切会话整体复位）。 */
@ObservedV2
export class ChatAttachments {
  @Trace items: Attachment[] = [];

  /** 选入失败轻提示回调（页面注入 toastModel.show；防 ChatDrawer 循环依赖）。 */
  pickToast: (msg: string) => void = (_msg: string) => {};

  /** 剩余可附额度。 */
  room(): number {
    return MAX_ATTACH - this.items.length;
  }

  anyEncoding(): boolean {
    for (let i = 0; i < this.items.length; i++) {
      if (this.items[i].state === 'encoding') {
        return true;
      }
    }
    return false;
  }

  anyError(): boolean {
    for (let i = 0; i < this.items.length; i++) {
      if (this.items[i].state === 'error') {
        return true;
      }
    }
    return false;
  }

  remove(i: number): void {
    const it: Attachment | undefined = this.items[i];
    if (it === undefined) {
      return;
    }
    this.releaseThumb(it);
    this.items = this.items.filter((_x: Attachment, idx: number) => idx !== i);
  }

  /** 整体复位（发送后清条 / 切会话；缩略图逐个释放）。 */
  reset(): void {
    for (let i = 0; i < this.items.length; i++) {
      this.releaseThumb(this.items[i]);
    }
    this.items = [];
  }

  private releaseThumb(it: Attachment): void {
    if (it.thumb !== null) {
      it.thumb.release();
    }
  }

  // ── 选入入口（＋菜单四项；全部先过余量闸门）──

  /** 拍照：系统相机直拍直回（cameraPicker 免权限；ctx = UI 宿主 Context）。 */
  async takePhoto(ctx: common.Context): Promise<void> {
    if (this.room() <= 0) {
      this.pickToast('最多附 5 个附件');
      return;
    }
    try {
      const profile: cameraPicker.PickerProfile = new cameraPicker.PickerProfile();
      profile.cameraPosition = camera.CameraPosition.CAMERA_POSITION_BACK;
      const r: cameraPicker.PickerResult =
        await cameraPicker.pick(ctx, [cameraPicker.PickerMediaType.PHOTO], profile);
      if (r.resultCode === 0 && r.resultUri !== '') {
        await this.addImageUris([r.resultUri]);
      }
    } catch (e) {
      this.pickToast('相机拉起失败');
    }
  }

  /** 相库图片（photoAccessHelper 新版选择器；旧 picker.PhotoViewPicker 已废弃）。 */
  async pickImages(): Promise<void> {
    const room: number = this.room();
    if (room <= 0) {
      this.pickToast('最多附 5 个附件');
      return;
    }
    try {
      const p: photoAccessHelper.PhotoViewPicker = new photoAccessHelper.PhotoViewPicker();
      const opts: photoAccessHelper.PhotoSelectOptions = new photoAccessHelper.PhotoSelectOptions();
      opts.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
      opts.maxSelectNumber = room;
      const res: photoAccessHelper.PhotoSelectResult = await p.select(opts);
      await this.addImageUris(res.photoUris);
    } catch (e) {
      // 用户取消等：静默
    }
  }

  /** 相库视频（取首帧 + 时长元数据；协议无视频通道）。 */
  async pickVideos(): Promise<void> {
    const room: number = this.room();
    if (room <= 0) {
      this.pickToast('最多附 5 个附件');
      return;
    }
    try {
      const p: photoAccessHelper.PhotoViewPicker = new photoAccessHelper.PhotoViewPicker();
      const opts: photoAccessHelper.PhotoSelectOptions = new photoAccessHelper.PhotoSelectOptions();
      opts.MIMEType = photoAccessHelper.PhotoViewMIMETypes.VIDEO_TYPE;
      opts.maxSelectNumber = room;
      const res: photoAccessHelper.PhotoSelectResult = await p.select(opts);
      await this.addVideoUris(res.photoUris);
    } catch (e) {
      // 用户取消等：静默
    }
  }

  /** 文档选择器（文本类白名单 + 512KB 上限；内容随 prompt 内联）。 */
  async pickFiles(): Promise<void> {
    const room: number = this.room();
    if (room <= 0) {
      this.pickToast('最多附 5 个附件');
      return;
    }
    try {
      const d: picker.DocumentViewPicker = new picker.DocumentViewPicker();
      const opts: picker.DocumentSelectOptions = new picker.DocumentSelectOptions();
      opts.maxSelectNumber = room;
      const uris: string[] = await d.select(opts);
      this.addFileUris(uris);
    } catch (e) {
      // 用户取消等：静默
    }
  }

  // ── 编码管线（逐条串行 await：限 fd/内存压力，条内遮罩逐个转 ready）──

  private async addImageUris(uris: string[]): Promise<void> {
    for (let i = 0; i < uris.length; i++) {
      if (this.room() <= 0) {
        break;
      }
      const a: Attachment = new Attachment('image', uriName(uris[i]));
      this.items = this.items.concat([a]);
      await this.encodeImage(a, uris[i]);
    }
  }

  private async addVideoUris(uris: string[]): Promise<void> {
    for (let i = 0; i < uris.length; i++) {
      if (this.room() <= 0) {
        break;
      }
      const a: Attachment = new Attachment('video', uriName(uris[i]));
      this.items = this.items.concat([a]);
      await this.encodeVideo(a, uris[i]);
    }
  }

  private addFileUris(uris: string[]): void {
    for (let i = 0; i < uris.length; i++) {
      if (this.room() <= 0) {
        break;
      }
      const a: Attachment = new Attachment('file', uriName(uris[i]));
      this.items = this.items.concat([a]);
      this.encodeFile(a, uris[i]);
    }
  }

  /** 图片编码：直通（白名单后缀 ≤1.5MB 原字节）或重编码（≤1568 jpeg q85）。 */
  private async encodeImage(a: Attachment, uri: string): Promise<void> {
    let f: fs.File | null = null;
    let src: image.ImageSource | null = null;
    try {
      f = fs.openSync(uri, fs.OpenMode.READ_ONLY);
      const size: number = fs.statSync(f.fd).size;
      a.sizeLabel = sizeLabelOf(size);
      const passThrough: boolean = size <= PASS_THROUGH_MAX
        && (a.ext === 'png' || a.ext === 'jpg' || a.ext === 'jpeg' || a.ext === 'webp' || a.ext === 'gif');
      src = image.createImageSource(f.fd);
      // EXIF 直立（竖拍）：方向角同时用于缩略图与重编码；直通保持原字节
      let rotate: number = 0;
      try {
        const o: string = await src.getImageProperty(image.PropertyKey.ORIENTATION);
        rotate = exifDegrees(o);
      } catch (e) {
        // 无 EXIF / 属性缺失：不旋转
      }
      const tSize: image.Size = { width: THUMB_EDGE, height: THUMB_EDGE };
      const tOpts: image.DecodingOptions = { desiredSize: tSize, rotate: rotate };
      const thumb: image.PixelMap = await src.createPixelMap(tOpts);
      if (!this.items.includes(a)) {
        // 编码中途被移除（点格即焚）：迟到的缩略图原地释放，不再回写状态
        thumb.release();
        return;
      }
      a.thumb = thumb;
      if (passThrough) {
        const buf: ArrayBuffer = new ArrayBuffer(size);
        const ro: ReadOptions = { offset: 0, length: size };
        fs.readSync(f.fd, buf, ro);
        a.base64 = base64Of(buf);
        a.mediaType = mediaTypeOfExt(a.ext);
      } else {
        const info: image.ImageInfo = await src.getImageInfo();
        const w: number = info.size.width;
        const h: number = info.size.height;
        let dOpts: image.DecodingOptions = { rotate: rotate };
        if (w > MAX_EDGE || h > MAX_EDGE) {
          const scale: number = MAX_EDGE / Math.max(w, h);
          const dSize: image.Size = { width: Math.round(w * scale), height: Math.round(h * scale) };
          dOpts = { desiredSize: dSize, rotate: rotate };
        }
        const pm: image.PixelMap = await src.createPixelMap(dOpts);
        const packer: image.ImagePacker = image.createImagePacker();
        const po: image.PackingOption = { format: 'image/jpeg', quality: 85 };
        const buf: ArrayBuffer = await packer.packing(pm, po);
        pm.release();
        packer.release();
        if (buf.byteLength > ENCODED_MAX) {
          a.state = 'error';
          a.errorText = '图片过大';
          return;
        }
        a.base64 = base64Of(buf);
        a.mediaType = 'image/jpeg';
      }
      a.state = 'ready';
    } catch (e) {
      a.state = 'error';
      a.errorText = '读取失败';
    } finally {
      if (src !== null) {
        try {
          await src.release();
        } catch (e2) {
          // 释放失败静默
        }
      }
      if (f !== null) {
        fs.closeSync(f);
      }
    }
  }

  /** 视频编码：双 fd（generator 与 extractor 的 fdSrc 独占）；首帧 + 时长。 */
  private async encodeVideo(a: Attachment, uri: string): Promise<void> {
    let fMeta: fs.File | null = null;
    let fGen: fs.File | null = null;
    let ex: media.AVMetadataExtractor | null = null;
    let gen: media.AVImageGenerator | null = null;
    try {
      fMeta = fs.openSync(uri, fs.OpenMode.READ_ONLY);
      fGen = fs.openSync(uri, fs.OpenMode.READ_ONLY);
      const size: number = fs.statSync(fMeta.fd).size;
      a.sizeLabel = sizeLabelOf(size);
      ex = await media.createAVMetadataExtractor();
      const dMeta: media.AVFileDescriptor = { fd: fMeta.fd, offset: 0, length: size };
      ex.fdSrc = dMeta;
      const meta: media.AVMetadata = await ex.fetchMetadata();
      const durRaw: string | undefined = meta.duration;
      let dur: number = durRaw !== undefined ? Number(durRaw) : 0;
      if (Number.isNaN(dur)) {
        dur = 0;
      }
      a.durationMs = dur;
      gen = await media.createAVImageGenerator();
      const dGen: media.AVFileDescriptor = { fd: fGen.fd, offset: 0, length: size };
      gen.fdSrc = dGen;
      const pp: media.PixelMapParams = { width: POSTER_EDGE, height: POSTER_EDGE };
      const poster: image.PixelMap =
        await gen.fetchFrameByTime(0, media.AVImageQueryOptions.AV_IMAGE_QUERY_NEXT_SYNC, pp);
      if (!this.items.includes(a)) {
        // 编码中途被移除：迟到的首帧原地释放，不再回写状态
        poster.release();
        return;
      }
      a.thumb = poster;
      const packer: image.ImagePacker = image.createImagePacker();
      const po: image.PackingOption = { format: 'image/jpeg', quality: 85 };
      const buf: ArrayBuffer = await packer.packing(poster, po);
      packer.release();
      a.base64 = base64Of(buf);
      a.mediaType = 'image/jpeg';
      a.state = 'ready';
    } catch (e) {
      a.state = 'error';
      a.errorText = '视频读取失败';
    } finally {
      if (ex !== null) {
        try {
          await ex.release();
        } catch (e2) {
          // 释放失败静默
        }
      }
      if (gen !== null) {
        try {
          await gen.release();
        } catch (e2) {
          // 释放失败静默
        }
      }
      if (fMeta !== null) {
        fs.closeSync(fMeta);
      }
      if (fGen !== null) {
        fs.closeSync(fGen);
      }
    }
  }

  /** 文件编码（同步）：白名单 + 512KB 闸门，UTF-8 fatal 解码拦二进制，50k 截断。 */
  private encodeFile(a: Attachment, uri: string): void {
    let f: fs.File | null = null;
    try {
      if (!TEXT_EXTS.includes(a.ext)) {
        a.state = 'error';
        a.errorText = '仅支持文本类文件';
        this.pickToast('仅支持文本类文件');
        return;
      }
      f = fs.openSync(uri, fs.OpenMode.READ_ONLY);
      const size: number = fs.statSync(f.fd).size;
      if (size > FILE_READ_MAX) {
        a.state = 'error';
        a.errorText = '超过 512KB';
        this.pickToast('文件超过 512KB 上限');
        return;
      }
      a.sizeLabel = sizeLabelOf(size);
      const buf: ArrayBuffer = new ArrayBuffer(size);
      const ro: ReadOptions = { offset: 0, length: size };
      fs.readSync(f.fd, buf, ro);
      const tdo: util.TextDecoderOptions = { fatal: true };
      const dec: util.TextDecoder = new util.TextDecoder('utf-8', tdo);
      let text: string = dec.decodeWithStream(new Uint8Array(buf));
      if (text.length > MENTION_MAX_CHARS) {
        const total: number = text.length;
        text = text.substring(0, MENTION_MAX_CHARS) + `\n...(内容过长，已截断，完整文件共 ${total} 字符)`;
      }
      a.text = text;
      a.state = 'ready';
    } catch (e) {
      a.state = 'error';
      a.errorText = '无法按文本读取';
      this.pickToast('该文件无法按文本读取');
    } finally {
      if (f !== null) {
        fs.closeSync(f);
      }
    }
  }

  // ── 发送载荷组装（send 前同步快照；只收 ready 项）──

  /** images 载荷：图片 + 视频首帧（协议唯一媒体通道）；无媒体返回 null。 */
  buildImages(): SendImage[] | null {
    const out: SendImage[] = [];
    for (let i = 0; i < this.items.length; i++) {
      const it: Attachment = this.items[i];
      if ((it.type === 'image' || it.type === 'video') && it.state === 'ready') {
        const s: SendImage = { data: it.base64, mediaType: it.mediaType };
        out.push(s);
      }
    }
    return out.length > 0 ? out : null;
  }

  /** prompt 组装：文本 + 文件 mention 内联（桌面 fileMentions 同标记格式）。 */
  composePrompt(text: string): string {
    const sections: string[] = [];
    for (let i = 0; i < this.items.length; i++) {
      const it: Attachment = this.items[i];
      if (it.type === 'file' && it.state === 'ready') {
        sections.push(`--- 引用文件：${it.name} ---\n${it.text}\n--- 文件结束：${it.name} ---`);
      }
    }
    if (sections.length === 0) {
      return text;
    }
    const joined: string = sections.join('\n\n');
    return text !== '' ? `${text}\n\n${joined}` : joined;
  }

  /** display 组装（块序 = PWA buildUserDisplay：媒体 → text → mention）。 */
  buildDisplay(text: string): SendDisplayBlock[] | null {
    const out: SendDisplayBlock[] = [];
    for (let i = 0; i < this.items.length; i++) {
      const it: Attachment = this.items[i];
      if (it.state !== 'ready') {
        continue;
      }
      if (it.type === 'image') {
        out.push({ type: 'image', data: it.base64, mediaType: it.mediaType });
      } else if (it.type === 'video') {
        out.push({ type: 'video', poster: it.base64, durationMs: it.durationMs, name: it.name });
      }
    }
    if (text !== '') {
      out.push({ type: 'text', text: text });
    }
    for (let i = 0; i < this.items.length; i++) {
      const it: Attachment = this.items[i];
      if (it.type === 'file' && it.state === 'ready') {
        out.push({ type: 'mention', path: it.name, content: it.text });
      }
    }
    return out.length > 0 ? out : null;
  }
}

/** 全局单例（会话页输入区唯一附件宿主；ChatModel.open/newSession 复位）。 */
export const attachmentsModel: ChatAttachments = new ChatAttachments();
