// 真模型批次的凭据解析器：复用**当前 aide 会话的 provider 配置**（用户授权，2026-09-11）。
// 来源：~/.aide/settings.json 的 activeProvider → 条目（kind/baseUrl/modelMappings）；
//       Windows 凭据管理器 `io.aide.desktop` / `aide/settings/provider/<id>/{authToken,apiKey}`
//       （KeyringSecretStore 的落点，src-tauri/src/settings/secrets.rs）。
// 红线：返回值只在调用方内存中流转——永不 console.log、永不写文件、永不进清单/日志。
//       （真 key 出现在 runtime stdout 也会被抓，见 C8 扫描把真 token 列入哨兵。）
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const KEYRING_SERVICE = "io.aide.desktop";
/** kind → catalog 预置 base_url 兜底（预置 kind 的 baseUrl 不入 settings，见 provider/mod.rs 注释）。 */
const PRESET_BASE_URL: Record<string, string> = {
  qwen: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
};

export interface ResolvedProviderEnv {
  providerId: string;
  kind: string;
  /** send.env 直接可用（ANTHROPIC_* 通道，对齐 runtime/provider/strategy 的注入面）。 */
  env: Record<string, string>;
  /** 脱敏摘要，供日志/台账打印——绝不含 token 本体。 */
  describe(): string;
}

export function resolveProviderEnv(): ResolvedProviderEnv {
  const settings = JSON.parse(readFileSync(join(homedir(), ".aide", "settings.json"), "utf8"));
  const v = settings.values ?? {};
  const activeId: string | undefined = v.activeProvider ?? v.active_provider;
  const providers: Array<Record<string, unknown>> = Array.isArray(v.providers) ? v.providers : [];
  const prov = providers.find((p) => p.id === activeId) ?? providers.find((p) => p.kind === "qwen");
  if (!prov || typeof prov.id !== "string") throw new Error("active provider not found in ~/.aide/settings.json");
  const kind = String(prov.kind ?? "");
  const baseUrl = String(prov.baseUrl || "") || PRESET_BASE_URL[kind] || "";
  if (!baseUrl) throw new Error(`provider ${kind} has no base_url (settings empty + no preset)`);
  const maps = (prov.modelMappings ?? {}) as Record<string, string>;
  const model = maps.defaultSonnetModel || maps.anthropicModel || "";
  const small = maps.defaultHaikuModel || model;

  const id = prov.id;
  const secret = readSecretViaKeyring(id);
  const env: Record<string, string> = { ANTHROPIC_BASE_URL: baseUrl };
  if (secret.kind === "authToken") env.ANTHROPIC_AUTH_TOKEN = secret.value;
  else env.ANTHROPIC_API_KEY = secret.value;
  if (model) { env.ANTHROPIC_MODEL = model; env.ANTHROPIC_SMALL_FAST_MODEL = small || model; }
  return {
    providerId: id, kind, env,
    describe: () => `provider=${kind}/${id.slice(0, 8)}… base=${baseUrl} model=${model || "(默认)"} secret=${secret.kind}(${secret.value.length} chars)`,
  };
}

function readSecretViaKeyring(providerId: string): { kind: "authToken" | "apiKey"; value: string } {
  const ps = (account: string) => [
    "Add-Type -TypeDefinition '",
    "using System;using System.Runtime.InteropServices;",
    "public class AideCred{",
    "[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]",
    "public struct CREDENTIAL{public int Flags;public int Type;public string Target;public string Comment;public long LastWritten;public int CredentialBlobSize;public IntPtr CredentialBlob;public int Persist;public int AttributeCount;public IntPtr Attributes;public string TargetAlias;public string UserName;}",
    '[DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] public static extern bool CredReadW(string target,int type,int flags,out IntPtr cred);',
    '[DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);',
    "public static string Read(string target){IntPtr p;if(!CredReadW(target,1,0,out p))return null;try{var c=(CREDENTIAL)Marshal.PtrToStructure(p,typeof(CREDENTIAL));return Marshal.PtrToStringUni(c.CredentialBlob,c.CredentialBlobSize/2);}finally{CredFree(p);}}}",
    "'",
    // keyring-rs 在 Windows 的落点（cmdkey 实测）：TargetName = "{account}.{service}" 整串。
    `[Console]::Out.Write([AideCred]::Read('${account}.${KEYRING_SERVICE}'))`,
  ].join("\n");
  for (const kind of ["authToken", "apiKey"] as const) {
    try {
      const out = execFileSync("powershell.exe", ["-NonInteractive", "-NoProfile", "-Command", ps(`aide/settings/provider/${providerId}/${kind}`)], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000,
      }).trim();
      if (out) return { kind, value: out };
    } catch { /* 该形态无凭据，试下一种 */ }
  }
  throw new Error(`no apiKey/authToken in keyring for provider ${providerId}`);
}
