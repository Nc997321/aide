// localStorage 凭据：中继 URL + device_id + token（配对成功后持久化，重连免配对）。

const KEY = "aide-remote-creds";

export interface StoredCreds {
  relayUrl: string;
  deviceId: string;
  token: string;
}

export function loadCreds(): StoredCreds | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredCreds>;
    if (
      typeof parsed.relayUrl === "string" &&
      typeof parsed.deviceId === "string" &&
      typeof parsed.token === "string"
    ) {
      return parsed as StoredCreds;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveCreds(creds: StoredCreds): void {
  localStorage.setItem(KEY, JSON.stringify(creds));
}

export function clearCreds(): void {
  localStorage.removeItem(KEY);
}

// 中继 URL 单独记住（未配对时也保留上次输入）
const RELAY_URL_KEY = "aide-remote-relay-url";

export function saveRelayUrl(url: string): void {
  localStorage.setItem(RELAY_URL_KEY, url);
}

export function loadRelayUrl(): string {
  return localStorage.getItem(RELAY_URL_KEY) ?? "";
}
