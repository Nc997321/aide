import { describe, expect, it } from "vitest";
import { classifyImageInputResult } from "./imageInputCapability.js";

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
