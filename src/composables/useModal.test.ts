// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { defineComponent } from "vue";
import { useModal } from "./useModal";

const FakeEditor = defineComponent({
  emits: ["submit", "cancel"],
  template: `<div class="fake-editor">
    <button class="btn-submit" @click="$emit('submit', 'test-payload')">Submit</button>
    <button class="btn-cancel" @click="$emit('cancel')">Cancel</button>
  </div>`,
});

describe("useModal custom mode", () => {
  it("custom<T> resolves with typed payload on resolveCustom", async () => {
    const modal = useModal();
    const promise = modal.custom<string>({
      title: "Test",
      component: FakeEditor,
    });

    expect(modal.visible.value).toBe(true);
    expect(modal.mode.value).toBe("custom");
    expect(modal.title.value).toBe("Test");

    modal.resolveCustom("hello");

    const result = await promise;
    expect(result).toBe("hello");
    expect(modal.visible.value).toBe(false);
  });

  it("custom<T> resolves with null on cancel", async () => {
    const modal = useModal();
    const promise = modal.custom<string>({
      title: "Test",
      component: FakeEditor,
    });

    modal.cancel();

    const result = await promise;
    expect(result).toBeNull();
    expect(modal.visible.value).toBe(false);
  });

  it("existing confirm mode still works (regression)", async () => {
    const modal = useModal();
    const promise = modal.confirm("Confirm?", "Are you sure?");

    expect(modal.visible.value).toBe(true);
    expect(modal.mode.value).toBe("confirm");

    modal.submit();

    const result = await promise;
    expect(result).toBe(true);
    expect(modal.visible.value).toBe(false);
  });

  it("existing confirm cancel returns false (regression)", async () => {
    const modal = useModal();
    const promise = modal.confirm("Confirm?", "Are you sure?");

    modal.cancel();

    const result = await promise;
    expect(result).toBe(false);
    expect(modal.visible.value).toBe(false);
  });
});
