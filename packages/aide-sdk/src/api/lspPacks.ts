import { getTransport } from "../transport";
import type { LanguagePack } from "../types/lspPacks";

/** 语言包：装在**当前窗口连着的 Host** 上（本机 / WSL / SSH 各装各的）。 */
export const lspPacksApi = {
  list(): Promise<LanguagePack[]> {
    return getTransport().invoke("lsp_packs");
  },
  /** 下载 + 校验 + 解压，可能要几十秒；返回装好后的状态。 */
  install(id: string): Promise<LanguagePack> {
    return getTransport().invoke("lsp_pack_install", { id });
  },
  uninstall(id: string): Promise<LanguagePack> {
    return getTransport().invoke("lsp_pack_uninstall", { id });
  },
};
