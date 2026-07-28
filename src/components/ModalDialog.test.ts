// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import ModalDialog from "./ModalDialog.vue";
import { useModal } from "../composables/useModal";

const FakeEditor = defineComponent({
  emits: ["submit", "cancel"],
  props: {
    initialValue: { type: String, default: "" },
  },
  template: `<div class="fake-editor">
    <button class="btn-submit" @click="$emit('submit', 'test-payload')">Submit</button>
    <button class="btn-cancel" @click="$emit('cancel')">Cancel</button>
  </div>`,
});

function mountModal() {
  return mount(ModalDialog, {
    attachTo: document.body,
    global: {
      stubs: {
        Teleport: {
          template: "<div><slot /></div>",
        },
      },
    },
  });
}

describe("ModalDialog custom mode", () => {
  it("renders custom component and handles submit", async () => {
    const modal = useModal();
    const promise = modal.custom<string>({
      title: "Custom Editor",
      component: FakeEditor,
      props: { initialValue: "hello" },
    });

    const wrapper = mountModal();

    // Should render the fake editor
    expect(wrapper.find(".fake-editor").exists()).toBe(true);

    // Click submit button in the editor
    await wrapper.find(".btn-submit").trigger("click");

    const result = await promise;
    expect(result).toBe("test-payload");
    expect(modal.visible.value).toBe(false);
  });

  it("handles cancel from custom component", async () => {
    const modal = useModal();
    const promise = modal.custom<string>({
      title: "Custom Editor",
      component: FakeEditor,
    });

    const wrapper = mountModal();

    await wrapper.find(".btn-cancel").trigger("click");

    const result = await promise;
    expect(result).toBeNull();
    expect(modal.visible.value).toBe(false);
  });

  it("does not render generic action buttons in custom mode", async () => {
    const modal = useModal();
    modal.custom<string>({
      title: "Custom Editor",
      component: FakeEditor,
    });

    const wrapper = mountModal();

    // The generic modal-actions div should not be present in custom mode
    expect(wrapper.find(".modal-actions").exists()).toBe(false);
  });
});
