import { describe, expect, it, vi } from "vitest";
import {
  classifyImageInputResult,
  imageCapabilityKey,
  ImageInputCapabilityCache,
  isImagePath,
  probeImageInput,
} from "./imageInputCapability.js";

describe("isImagePath", () => {
  it.each(["shot.png", "PHOTO.JPEG", "diagram.Gif", "asset.webp"]) (
    "recognizes %s",
    (path) => expect(isImagePath(path)).toBe(true),
  );

  it.each(["README.md", "src/main.ts", { file_path: "x.png" }, ""]) (
    "does not treat %p as an image path",
    (value) => expect(isImagePath(value)).toBe(false),
  );
});

describe("classifyImageInputResult", () => {
  it("recognizes only the explicit unsupported-image 400", () => {
    expect(classifyImageInputResult({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      api_error_status: 400,
      errors: ["API Error: 400 this model does not support image input"],
    })).toBe(false);
  });

  it("recognizes the SDKResultError shape, which carries HTTP 400 only in errors[]", () => {
    expect(classifyImageInputResult({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["API Error: 400 this model does not support image input (ref: abc)"],
    })).toBe(false);
  });

  it("treats successful result messages as definitive support", () => {
    expect(classifyImageInputResult({ type: "result", subtype: "success", is_error: false })).toBe(true);
  });

  it.each([
    { type: "result", subtype: "error_during_execution" },
    { type: "result", subtype: "aborted", is_error: false },
    { type: "result", subtype: "error_during_execution", is_error: true, api_error_status: 401, errors: ["Unauthorized"] },
    { type: "result", subtype: "error_during_execution", is_error: true, api_error_status: 429, errors: ["rate limited"] },
    { type: "result", subtype: "error_during_execution", is_error: true, api_error_status: 400, errors: ["invalid model"] },
  ])("does not misclassify %o", (message) => {
    expect(classifyImageInputResult(message)).toBeNull();
  });
});

describe("imageCapabilityKey", () => {
  it("hashes endpoint and credential without exposing the raw secret", () => {
    const key = imageCapabilityKey(
      {
        ANTHROPIC_BASE_URL: "https://gateway.example",
        ANTHROPIC_AUTH_TOKEN: "secret-token",
      },
      "vision-model",
    );

    expect(key).toContain("\0vision-model");
    expect(key).not.toContain("secret-token");
    expect(key).not.toContain("gateway.example");
    expect(key).not.toContain("vision-model\0vision-model");
    expect(key).toMatch(/^[a-f0-9]{64}\0vision-model$/);
  });
});

describe("ImageInputCapabilityCache", () => {
  it("deduplicates concurrent probes and persists only definitive answers", async () => {
    const cache = new ImageInputCapabilityCache();
    let calls = 0;
    const probe = async () => {
      calls += 1;
      return false as const;
    };

    await Promise.all([
      cache.ensure("connection\0glm-5.2", probe),
      cache.ensure("connection\0glm-5.2", probe),
    ]);

    expect(calls).toBe(1);
    expect(await cache.ensure("connection\0glm-5.2", async () => true)).toBe(false);

    const unknown = new ImageInputCapabilityCache();
    expect(await unknown.ensure("k", async () => null)).toBeNull();
    expect(await unknown.ensure("k", async () => true)).toBe(true);
  });
});

describe("probeImageInput", () => {
  it("probes with an ephemeral image-only query and never resumes a session", async () => {
    const calls: any[] = [];
    const queryFn = (request: any) => {
      calls.push(request);
      return (async function* () {
        yield { type: "result", subtype: "success", is_error: false };
      })();
    };

    await expect(
      probeImageInput(queryFn as any, {
        env: { ANTHROPIC_BASE_URL: "https://gateway" },
        model: "vision-model",
      }),
    ).resolves.toBe(true);

    expect(calls[0].options).toMatchObject({
      model: "vision-model",
      persistSession: false,
      tools: [],
    });
    expect(calls[0].options).not.toHaveProperty("resume");
    expect(calls[0].prompt).toBeDefined();
  });

  it("returns null for unsupported-image errors and ignores unrelated failures", async () => {
    const unsupported = vi.fn(() => (async function* () {
      yield {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        api_error_status: 400,
        errors: ["API Error: 400 this model does not support image input"],
      };
    })());

    const unrelated = vi.fn(() => (async function* () {
      yield {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        api_error_status: 401,
        errors: ["Unauthorized"],
      };
    })());

    await expect(probeImageInput(unsupported as any, { env: {}, model: "vision-model" })).resolves.toBe(false);
    await expect(probeImageInput(unrelated as any, { env: {}, model: "vision-model" })).resolves.toBeNull();
  });

  it("classifies a synthetic assistant error message as unsupported (real SDK 400 shape)", async () => {
    // 真实 SDK 行为：CLI 把 400 包成 model="<synthetic>" 的 assistant 文本消息，
    // 不是 result(is_error)。probe 必须识别这条合成消息，否则判 unknown → 守卫放行 → 400 冒到用户。
    const queryFn = vi.fn(() => (async function* () {
      yield {
        type: "assistant",
        message: {
          role: "assistant",
          model: "<synthetic>",
          content: [
            { type: "text", text: "API Error: 400 this model does not support image input (ref: 5fa0c0d1)" },
          ],
        },
      };
    })());
    await expect(probeImageInput(queryFn as any, { env: {}, model: "glm-5.2" })).resolves.toBe(false);
  });

  it("classifies a thrown 400 exception as unsupported", async () => {
    // 部分网关让 CLI 非零退出，SDK 抛异常；异常文本同样含 400 + 不支持图片。
    const queryFn = vi.fn(() => (async function* () {
      throw new Error("接口返回错误（HTTP 400） — API Error: 400 this model does not support image input (ref: x)");
    })());
    await expect(probeImageInput(queryFn as any, { env: {}, model: "glm-5.2" })).resolves.toBe(false);
  });

  it("returns null for thrown exceptions that are not the unsupported-image 400", async () => {
    const queryFn = vi.fn(() => (async function* () {
      throw new Error("some other 500 error");
    })());
    await expect(probeImageInput(queryFn as any, { env: {}, model: "glm-5.2" })).resolves.toBeNull();
  });
});
