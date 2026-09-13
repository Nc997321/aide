/**
 * DoH 直连薄封装（独立模块，可整体删除或换供应商）。
 *
 * 动机（2026-09-12 排查定型）：
 * 中继域名只有 AAAA 记录，运营商/光猫递归 DNS 缓存过期 AAAA 时按域名直连必然
 * 失败且时好时坏。连接前改走 DoH（阿里公共解析 JSON API）取新鲜字面量直连，
 * 域名降为兜底——解析缓存怎么抽风都不再影响。
 *
 * 边界（删除/替换成本最小化约定）：
 *  - 只被 ws-ohos.ets 引用；删除本文件 + 还原 ws-ohos 构造里的 DoH 段即完整回退
 *  - 换供应商：改 DOH_ENDPOINT 一处（Google/Cloudflare 为同构 JSON API）
 *  - 上游 remote-pwa / aide-sdk 无对应物，属 ohos 独立增强，不参与三端同步
 *
 * 策略：
 *  - AAAA 优先（本部署 v6-only），空则查 A 兜底；两样皆空 / DoH 不可达 → 域名直连
 *  - 正缓存 60s：offline 退避风暴下不重复打 DoH
 *  - 直连失败熔断 10min：该字面量期内不再入选（回落其他记录/域名），期满自动重探，
 *    成功即解除——「间歇性」故障自愈，不会把好 IP 永久打死
 *  - wss:// 不做字面量直连：ohos webSocket 无 SNI 覆盖，证书按 URL host 校验必炸
 *  - v6 字面量不做直连（2026-09-12 实测定型）：ohos 栈对 v6 字面量生成无括号
 *    Host（如 "2409:…:8000"），自定义 Host 覆盖又被 netstack 无视，nginx 按规范
 *    必回 400 且 netstack 不回调——探测注定失败，白烧 15s 握手看门狗（每冷启动
 *    必现，用户可感）。解析出 v6 直接回落域名；v4 字面量保留直连（无括号问题）。
 *    若未来 netstack 修复 v6 Host 生成，删掉 dohConnectUrl 里的 v6 跳过即可恢复
 *  - 全链路受 RemoteTransport 握手看门狗兜底（DoH 最坏 ~6s + 剩余握手时长）
 */
import { http } from '@kit.NetworkKit';

/** DoH 供应商端点（换供应商只改这里）。 */
const DOH_ENDPOINT: string = 'https://dns.alidns.com/resolve';
/** 正缓存时长：命中期内（且未被熔断）直接复用字面量，不打 DoH。 */
const CACHE_TTL_MS: number = 60000;
/** 直连失败熔断时长：期内该 IP 不再入选，期满重探。 */
const IP_FAIL_TTL_MS: number = 600000;
/** 单次 HTTP 超时：connect/read 各限，DoH 最坏 ~6s，为握手看门狗留余量。 */
const HTTP_TIMEOUT_MS: number = 3000;
/** DNS JSON API 记录类型：A=1，AAAA=28。 */
const TYPE_A: number = 1;
const TYPE_AAAA: number = 28;

// ── DNS JSON API 应答形状（字段按 alidns/Google 实际使用面）──

interface DohAnswer {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

interface DohResponse {
  Status: number;
  Answer: DohAnswer[] | null;
}

/** dohConnectUrl 的产出：url = 实际连接地址；ip = 命中的字面量（null = 域名直连）；
 * origAuthority = 原地址 authority——字面量直连时用它覆盖 Host 头保留原域名（见 ws-ohos.ets）。 */
export interface DohOutcome {
  url: string;
  ip: string | null;
  origAuthority: string;
}

interface CacheEntry {
  ip: string;
  expiresAt: number;
}

/** 正缓存：host → 字面量（短 TTL，退避风暴限流用）。 */
const cache: Map<string, CacheEntry> = new Map();
/** 熔断表：失败字面量 → 最近失败时刻。 */
const ipFailAt: Map<string, number> = new Map();

/**
 * 连接前解析：给定 ws 完整地址，返回实际应连接的地址。
 * 仅明文 ws:// 且 host 为域名时走 DoH 换字面量；其余（wss / 已是字面量 /
 * 非 ws 形态）原样返回。永不 reject——一切失败都收敛为「域名兜底」。
 */
export function dohConnectUrl(url: string): Promise<DohOutcome> {
  const schemeEnd: number = url.indexOf('://');
  if (schemeEnd < 0) {
    return Promise.resolve<DohOutcome>(outcome(url, null, ''));
  }
  const afterScheme: number = schemeEnd + 3;
  const authority: string = authorityOf(url.substring(afterScheme));
  const host: string = hostOfAuthority(authority);
  // 闸门：wss 无 SNI 覆盖不能字面量直连；host 为空 / 已是字面量的原样走
  if (!url.startsWith('ws://') || host === '' || isIpLiteral(host)) {
    return Promise.resolve<DohOutcome>(outcome(url, null, authority));
  }
  return resolveHost(host).then((ip: string | null): DohOutcome => {
    if (ip === null) {
      return outcome(url, null, authority);
    }
    if (ip.includes(':')) {
      // v6 跳过直连：ohos 栈对 v6 字面量生成无括号 Host，nginx 必 400 且无回调，
      // 探测注定白烧 15s 握手看门狗（见文件头策略）——直接域名兜底
      console.info(`[doh] ${host} 解析为 v6，跳过字面量直连（Host 缺陷必拒），走域名`);
      return outcome(url, null, authority);
    }
    const hostPart: string = ip; // 走到这里必为 v4：字面量无需方括号
    const portPart: string = portOfAuthority(authority) !== '' ? `:${portOfAuthority(authority)}` : '';
    const rewritten: string =
      url.substring(0, afterScheme) + hostPart + portPart + url.substring(afterScheme + authority.length);
    console.info(`[doh] ${host} -> ${hostPart}${portPart} 字面量直连`);
    return outcome(rewritten, ip, authority);
  });
}

/** 直连结果回写（ws-ohos 调用）：失败熔断该字面量，成功解除。 */
export function noteIpConnectResult(ip: string, ok: boolean): void {
  if (ok) {
    ipFailAt.delete(ip);
    return;
  }
  ipFailAt.set(ip, Date.now());
  console.warn(`[doh] 字面量 ${ip} 直连失败，熔断期内回落域名/其他记录`);
}

// ── 解析编排 ──

/** host → 字面量：正缓存 → AAAA → A；全程失败返回 null（域名兜底）。 */
function resolveHost(host: string): Promise<string | null> {
  const hit: CacheEntry | undefined = cache.get(host);
  if (hit !== undefined) {
    if (hit.expiresAt > Date.now() && !isIpBad(hit.ip)) {
      return Promise.resolve(hit.ip);
    }
    cache.delete(host); // 过期或已被熔断：重新解析
  }
  return queryType(host, TYPE_AAAA).then((v6: string | null): Promise<string | null> => {
    if (v6 !== null) {
      return Promise.resolve(v6);
    }
    return queryType(host, TYPE_A);
  }).then((ip: string | null): string | null => {
    if (ip !== null) {
      const e: CacheEntry = { ip: ip, expiresAt: Date.now() + CACHE_TTL_MS };
      cache.set(host, e);
    }
    return ip;
  });
}

/** 单次 DoH 查询：请求失败 / 非 200 / 坏 JSON / 无可用记录 → null。 */
function queryType(host: string, rrtype: number): Promise<string | null> {
  const h: http.HttpRequest = http.createHttp();
  const opts: http.HttpRequestOptions = {
    method: http.RequestMethod.GET,
    expectDataType: http.HttpDataType.STRING,
    connectTimeout: HTTP_TIMEOUT_MS,
    readTimeout: HTTP_TIMEOUT_MS,
    usingCache: false
  };
  const typeParam: string = rrtype === TYPE_AAAA ? 'AAAA' : 'A';
  const q: string = `${DOH_ENDPOINT}?name=${encodeURIComponent(host)}&type=${typeParam}`;
  return h.request(q, opts).then((resp: http.HttpResponse): string | null => {
    h.destroy();
    if (resp.responseCode !== 200) {
      return null;
    }
    // JSON 边界：expectDataType STRING 保证 result 为 string
    return firstUsableIp(resp.result as string, rrtype);
  }).catch((_e: Error): string | null => {
    h.destroy();
    return null; // DoH 不可达：静默回落域名（域名路径原样可用）
  });
}

/** 应答里取目标类型、未被熔断的首条记录（A/AAAA 的 data 即字面量）。 */
function firstUsableIp(body: string, rrtype: number): string | null {
  let resp: DohResponse;
  try {
    resp = JSON.parse(body) as DohResponse;
  } catch (e) {
    return null;
  }
  if (resp.Status !== 0 || resp.Answer === null || resp.Answer === undefined) {
    return null;
  }
  const answers: DohAnswer[] = resp.Answer;
  for (let i = 0; i < answers.length; i++) {
    const a: DohAnswer = answers[i];
    if (a.type === rrtype && typeof a.data === 'string' && !isIpBad(a.data)) {
      return a.data;
    }
  }
  return null;
}

function isIpBad(ip: string): boolean {
  const t: number | undefined = ipFailAt.get(ip);
  if (t === undefined) {
    return false;
  }
  if (Date.now() - t >= IP_FAIL_TTL_MS) {
    ipFailAt.delete(ip); // 熔断期满：重探
    return false;
  }
  return true;
}

// ── URL 拆装（无正则字面量，纯字符串扫描）──

function outcome(url: string, ip: string | null, origAuthority: string): DohOutcome {
  const o: DohOutcome = { url: url, ip: ip, origAuthority: origAuthority };
  return o;
}

/** 截取 authority（host[:port]）：到首个 '/'、'?' 或 '#' 为止。 */
function authorityOf(rest: string): string {
  let end: number = rest.length;
  const slash: number = rest.indexOf('/');
  const qmark: number = rest.indexOf('?');
  const hash: number = rest.indexOf('#');
  if (slash >= 0) {
    end = Math.min(end, slash);
  }
  if (qmark >= 0) {
    end = Math.min(end, qmark);
  }
  if (hash >= 0) {
    end = Math.min(end, hash);
  }
  return rest.substring(0, end);
}

/** authority 的 host 段：剥 [v6] 括号；非法返回 ''。 */
function hostOfAuthority(authority: string): string {
  if (authority.startsWith('[')) {
    const close: number = authority.indexOf(']');
    if (close <= 0) {
      return '';
    }
    return authority.substring(1, close);
  }
  const colon: number = authority.indexOf(':');
  return colon >= 0 ? authority.substring(0, colon) : authority;
}

/** authority 的端口段（无端口返回 ''；[v6] 内的冒号不算分隔）。 */
function portOfAuthority(authority: string): string {
  const close: number = authority.indexOf(']');
  const colon: number = authority.indexOf(':', close >= 0 ? close : 0);
  return colon >= 0 ? authority.substring(colon + 1) : '';
}

/** 是否 IP 字面量：含冒号（v6）或四段纯数字（v4）。 */
function isIpLiteral(host: string): boolean {
  if (host.includes(':')) {
    return true;
  }
  const parts: string[] = host.split('.');
  if (parts.length !== 4) {
    return false;
  }
  for (let i = 0; i < parts.length; i++) {
    const p: string = parts[i];
    if (p.length === 0 || p.length > 3) {
      return false;
    }
    for (let j = 0; j < p.length; j++) {
      const c: string = p.charAt(j);
      if (c < '0' || c > '9') {
        return false;
      }
    }
  }
  return true;
}
