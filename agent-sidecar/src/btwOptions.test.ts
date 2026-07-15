import { describe, it, expect } from "vitest";
import { btwQueryOverrides, forkResumeOptions } from "./btwOptions.js";

describe("btwQueryOverrides", () => {
  it("non-btw: no overrides", () => {
    expect(btwQueryOverrides(false, false)).toEqual({});
  });
  it("btw full: persistSession false only", () => {
    expect(btwQueryOverrides(true, false)).toEqual({ persistSession: false });
  });
  it("btw lightweight: persistSession false + no tools", () => {
    expect(btwQueryOverrides(true, true)).toEqual({
      persistSession: false,
      tools: [],
      allowedTools: [],
    });
  });
});

describe("forkResumeOptions", () => {
  it("no fork: plain resume", () => {
    expect(forkResumeOptions("s1", false)).toEqual({ resume: "s1" });
  });
  it("fork: resume + forkSession", () => {
    expect(forkResumeOptions("s1", true)).toEqual({ resume: "s1", forkSession: true });
  });
  it("no session id: empty", () => {
    expect(forkResumeOptions("", true)).toEqual({});
  });
});
