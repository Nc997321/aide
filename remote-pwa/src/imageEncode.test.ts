import { describe, expect, it } from "vitest";
import { blobToBase64, fileToAttachment } from "./imageEncode";

/**
 * 图片编码器单测。jsdom 没有 canvas/ImageBitmap，shrinkToJpeg 的缩放重编码
 * 路径只能在真实浏览器里验证——这里覆盖 jsdom 可跑的臂，其余静态对账（见
 * 文件末尾对账表）。
 */

describe("blobToBase64", () => {
  it("剥离 data: 前缀，返回裸 base64", async () => {
    const b64 = await blobToBase64(new Blob(["hi"], { type: "text/plain" }));
    expect(b64).toBe(btoa("hi"));
  });
});

describe("fileToAttachment", () => {
  it("非图片/解码失败 → 拒绝并带可读信息", async () => {
    // jsdom 无 createImageBitmap：调用即 TypeError，走 catch 分支
    await expect(
      fileToAttachment(new File(["x"], "a.txt", { type: "text/plain" })),
    ).rejects.toThrow("无法读取图片文件");
  });

  /* 分支对账表（fileToAttachment / shrinkToJpeg，jsdom 缺 canvas/ImageBitmap，
     缩放重编码臂只能真机验证——非实测，静态对账）：
     分支                                            | 覆盖 | 测试
     createImageBitmap 抛错（非图片/损坏）           | 实测 | rejects 用例
     小图直传（≤1.5MB 且 ≤1568px 且 png/jpeg/webp）  | 静态 | 需真实解码器
     大图缩放 → JPEG                                 | 静态 | 需真实 canvas
     toBlob 返回 null → 抛错                         | 静态 | 需真实 canvas
     压缩后仍超 4.5MB → 抛错                         | 静态 | 需真实解码器
     getContext 为 null → 抛错                       | 静态 | 需真实 DOM
     blobToBase64 无逗号（FileReader 异常格式）      | 静态 | 防御臂，jsdom readAsDataURL 恒产合法 data: URL */
});