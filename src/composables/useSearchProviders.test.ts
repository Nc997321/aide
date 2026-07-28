import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "../types";

const mocks = vi.hoisted(() => ({
  codegraphGotoDefinition: vi.fn(),
  findFilesByName: vi.fn(),
  openAndScrollTo: vi.fn(),
}));

vi.mock("../api", () => ({
  api: {
    codegraphGotoDefinition: mocks.codegraphGotoDefinition,
    findFilesByName: mocks.findFilesByName,
  },
}));

vi.mock("./useFileViewer", () => ({
  useFileViewer: () => ({
    openAndScrollTo: mocks.openAndScrollTo,
  }),
}));

import { useSearchProviders } from "./useSearchProviders";

function structureResult(
  file: string,
  line: number,
  symbolOverrides: Partial<QueryResult["symbol"]> = {},
): QueryResult {
  return {
    symbol: {
      name: "getEnabled",
      kind: "Method",
      file,
      line,
      column: 5,
      parent: null,
      ...symbolOverrides,
    },
    confidence: "Structure",
    score: null,
  };
}

describe("useSearchProviders CodeGraph results", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFilesByName.mockResolvedValue([]);
    mocks.codegraphGotoDefinition.mockResolvedValue([]);

    useSearchProviders().initProviders(
      async () => [],
      vi.fn(),
      () => "C:\\workspace",
    );
  });

  it("puts the filename and line before shared path prefixes", async () => {
    const account = "common/src/main/java/com/senontech/vendor/CameraVendorAccount.java";
    const provider = "common/src/main/java/com/senontech/vendor/CameraVendorAccountProvider.java";
    mocks.codegraphGotoDefinition.mockResolvedValue([
      structureResult(account, 35),
      structureResult(provider, 13),
    ]);

    const results = await useSearchProviders().search("getEnabled", 8);

    expect(results).toHaveLength(2);
    expect(results).toEqual([
      expect.objectContaining({
        label: "getEnabled",
        description: "精确 · CameraVendorAccount.java:35 · common",
        tooltip: `${account}:35`,
      }),
      expect.objectContaining({
        label: "getEnabled",
        description: "精确 · CameraVendorAccountProvider.java:13 · common",
        tooltip: `${provider}:13`,
      }),
    ]);
  });

  it("removes exact duplicates before applying the visible-result limit", async () => {
    const controller = "cameraService/src/main/java/com/senontech/controller/CameraVendorAccountController.java";
    const feign = "manufacturerService/src/main/java/com/senontech/feign/CameraVendorAccountFeignClient.java";
    const original = structureResult(controller, 25, {
      parent: "CameraVendorAccountController",
    });
    const exactDuplicate: QueryResult = {
      ...original,
      symbol: { ...original.symbol },
    };

    mocks.codegraphGotoDefinition.mockResolvedValue([
      original,
      exactDuplicate,
      structureResult(controller, 40, { parent: "CameraVendorAccountController" }),
      structureResult(feign, 18),
    ]);

    const results = await useSearchProviders().search("getEnabled", 3);

    expect(results).toHaveLength(3);
    expect(results.map(result => result.tooltip)).toEqual([
      `${controller}:25`,
      `${controller}:40`,
      `${feign}:18`,
    ]);
    expect(new Set(results.map(result => result.id))).toHaveLength(3);

    results[2].action();
    expect(mocks.openAndScrollTo).toHaveBeenCalledWith(
      "C:\\workspace\\manufacturerService\\src\\main\\java\\com\\senontech\\feign\\CameraVendorAccountFeignClient.java",
      18,
    );
  });
});
