// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import BrowserSiteIcon from "./BrowserSiteIcon.vue";

enableAutoUnmount(afterEach);
const CACHED = "data:image/png;base64,AAA";

describe("browser website icons", () => {
  it("waits for the local cache before making a site icon request", async () => {
    const w = mount(BrowserSiteIcon, { props: { url: "https://example.test/page?private=1", cacheState: "pending" } });
    expect(w.find("img").exists()).toBe(false);
    expect(w.find("svg").exists()).toBe(true);
    await w.setProps({ cacheState: "ready" });
    expect(w.find("img").attributes("src")).toBe("https://example.test/favicon.ico");
    expect(w.find("img").attributes("referrerpolicy")).toBe("no-referrer");
    expect(w.find("img").attributes("loading")).toBe("lazy");
  });

  it("prefers a cached icon, including while another cache lookup is pending", async () => {
    const w = mount(BrowserSiteIcon, { props: { url: "https://example.test/", cached: CACHED, cacheState: "pending" } });
    expect(w.find("img").attributes("src")).toBe(CACHED);
    expect(w.find("svg").exists()).toBe(true);
    await w.find("img").trigger("load");
    expect(w.find("img").classes()).toContain("is-loaded");
    expect(w.find("svg").exists()).toBe(false);
  });

  it("falls back from a broken cached image to the site icon, then to the globe", async () => {
    const w = mount(BrowserSiteIcon, { props: { url: "https://example.test/", cached: CACHED, cacheState: "ready" } });
    await w.find("img").trigger("error");
    expect(w.find("img").attributes("src")).toBe("https://example.test/favicon.ico");
    await w.find("img").trigger("error");
    expect(w.find("img").exists()).toBe(false);
    expect(w.find("svg").exists()).toBe(true);
  });

  it.each(["file:///project/page.html", "javascript:alert(1)", "https://user:password@example.test/", "not a url"])("does not derive a network icon from %s", (url) => {
    const w = mount(BrowserSiteIcon, { props: { url, cacheState: "ready" } });
    expect(w.find("img").exists()).toBe(false);
    expect(w.find("svg").exists()).toBe(true);
  });

  it("preserves the site's protocol and port without leaking page parameters", () => {
    const w = mount(BrowserSiteIcon, { props: { url: "http://localhost:3000/private/page?q=secret#section", cacheState: "ready" } });
    expect(w.find("img").attributes("src")).toBe("http://localhost:3000/favicon.ico");
  });

  it("resets a failed source when the website changes", async () => {
    const w = mount(BrowserSiteIcon, { props: { url: "https://old.test/", cacheState: "ready" } });
    await w.find("img").trigger("error");
    expect(w.find("img").exists()).toBe(false);
    await w.setProps({ url: "https://new.test/path" });
    expect(w.find("img").attributes("src")).toBe("https://new.test/favicon.ico");
  });

  it("does not mark a new icon as failed when an old detached image reports an error", async () => {
    const w = mount(BrowserSiteIcon, { props: { url: "https://example.test/", cached: CACHED, cacheState: "ready" } });
    const old = w.find("img");
    const updated = "data:image/png;base64,BBB";
    await w.setProps({ cached: updated });
    await old.trigger("error");
    expect(w.find("img").attributes("src")).toBe(updated);
  });
});
