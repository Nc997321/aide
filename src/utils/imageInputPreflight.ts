export interface ImageInputProbeResult {
  supported: boolean | null;
}

/**
 * 前端图片发送的非破坏性预检：只有明确不支持才中断；未知或探测失败沿用 sidecar
 * 的第二道防线，避免临时网络问题吞掉用户已经粘贴的内容。
 */
export async function checkImageInputSupport(
  hasImages: boolean,
  model: string | undefined,
  probe: (model?: string) => Promise<ImageInputProbeResult>,
): Promise<boolean> {
  if (!hasImages) return true;
  try {
    return (await probe(model)).supported !== false;
  } catch {
    return true;
  }
}
