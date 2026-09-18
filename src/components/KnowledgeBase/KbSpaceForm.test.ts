// @vitest-environment jsdom
// 新建空间表单：ModalDialog 的 custom 内容，按契约 emit submit(payload) / cancel。
import { describe, it, expect, afterEach } from "vitest";
import { mount, enableAutoUnmount } from "@vue/test-utils";
import KbSpaceForm from "./KbSpaceForm.vue";

enableAutoUnmount(afterEach);

function mountForm() {
  return mount(KbSpaceForm);
}

async function fill(w: ReturnType<typeof mountForm>, key: string, name: string) {
  await w.find("[data-space-key]").setValue(key);
  await w.find("[data-space-name]").setValue(name);
}

describe("KbSpaceForm", () => {
  it("默认不可提交：两个字段都空", () => {
    expect(mountForm().find("[data-space-submit]").attributes("disabled")).toBeDefined();
  });

  it("标识不合法时不可提交——前端只为省一次必然失败的往返，服务端仍是唯一权威", async () => {
    const w = mountForm();
    for (const bad of ["", "a", "Bad Key!", "中文标识", "eng_handbook", "-".repeat(41)]) {
      await fill(w, bad, "名字");
      expect(w.find("[data-space-submit]").attributes("disabled"), `「${bad}」应被拒`).toBeDefined();
    }
    for (const good of ["ab", "eng-handbook", "team2", "a".repeat(40)]) {
      await fill(w, good, "名字");
      expect(w.find("[data-space-submit]").attributes("disabled"), `「${good}」应通过`).toBeUndefined();
    }
  });

  it("名称为空（或全空白）时不可提交", async () => {
    const w = mountForm();
    await fill(w, "eng", "   ");
    expect(w.find("[data-space-submit]").attributes("disabled")).toBeDefined();
  });

  it("提交时 trim 标题并带上可见性", async () => {
    const w = mountForm();
    await fill(w, "  eng-handbook  ", "  工程手册  ");
    await w.find("[data-space-visibility]").setValue("public");
    await w.find("[data-space-submit]").trigger("click");
    expect(w.emitted("submit")?.[0]).toEqual([
      { key: "eng-handbook", name: "工程手册", visibility: "public" },
    ]);
  });

  it("不可提交时点按钮也不发 submit", async () => {
    const w = mountForm();
    await w.find("[data-space-submit]").trigger("click");
    expect(w.emitted("submit")).toBeFalsy();
  });

  it("取消发 cancel", async () => {
    const w = mountForm();
    await w.findAll("button")[0]!.trigger("click");
    expect(w.emitted("cancel")).toBeTruthy();
  });
});
