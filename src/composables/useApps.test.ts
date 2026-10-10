import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppInfo } from "@aide/sdk/types/apps";

const list = vi.fn<() => Promise<AppInfo[]>>();
vi.mock("@aide/sdk/api/apps", () => ({
  APPS_CHANGED_EVENT: "apps-changed",
  appsApi: { list: () => list() },
}));
vi.mock("@aide/sdk", () => ({ listen: vi.fn(async () => () => {}) }));

import { appIdOfTab, appTabId, useApps } from "./useApps";

const app = (id: string, over: Partial<AppInfo> = {}): AppInfo => ({
  id,
  name: id,
  version: "0.1.0",
  icon: null,
  placement: "right",
  entry: "ui/index.html",
  permissions: [],
  hasServer: false,
  source: "user",
  enabled: true,
  consented: true,
  grant: "permissions=;server=",
  revision: 1,
  readOnlyTools: [],
  installed: false,
  alwaysVisible: false,
  error: null,
  ...over,
});

describe("useApps", () => {
  beforeEach(() => {
    list.mockReset();
    useApps().closeMain();
  });

  it("按位置分到右栏与主区", async () => {
    list.mockResolvedValue([app("snake"), app("db", { placement: "main" })]);
    const apps = useApps();
    await apps.refresh();
    expect(apps.rightApps.value.map((a) => a.id)).toEqual(["snake"]);
    expect(apps.mainApps.value.map((a) => a.id)).toEqual(["db"]);
  });

  it("主区一次只开一个应用，再点同一个是关", async () => {
    list.mockResolvedValue([app("db", { placement: "main" }), app("api", { placement: "main" })]);
    const apps = useApps();
    await apps.refresh();
    apps.toggleMain("db");
    expect(apps.mainOpenApp.value?.id).toBe("db");
    apps.toggleMain("api");
    expect(apps.mainOpenApp.value?.id).toBe("api");
    apps.toggleMain("api");
    expect(apps.mainPanelOpen.value).toBe(false);
  });

  it("开着的应用从清单里消失（卸载 / 换工作区）→ 主区让出来", async () => {
    list.mockResolvedValue([app("db", { placement: "main" })]);
    const apps = useApps();
    await apps.refresh();
    apps.toggleMain("db");
    list.mockResolvedValue([]);
    await apps.refresh();
    expect(apps.mainPanelOpen.value).toBe(false);
  });

  it("Host 没有这条命令（旧版）→ 静默，清单保持原样", async () => {
    list.mockResolvedValue([app("snake")]);
    const apps = useApps();
    await apps.refresh();
    list.mockRejectedValue("unknown command app_list");
    await expect(apps.refresh()).resolves.toBeUndefined();
    expect(apps.apps.value.map((a) => a.id)).toEqual(["snake"]);
  });

  it("右栏 tab id 与应用 id 互转", () => {
    expect(appTabId("snake")).toBe("app:snake");
    expect(appIdOfTab("app:snake")).toBe("snake");
    expect(appIdOfTab("files")).toBeNull();
  });
});
