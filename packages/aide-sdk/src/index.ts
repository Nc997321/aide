// @aide/sdk 公共面：api 门面 + 传输层 + 共享类型。
// 桌面与 remote-pwa 共用本包；传输层可注入（桌面默认 Tauri IPC，远端 setTransport(RemoteTransport)）。

export { api } from "./api";
export type { SendMessageParams, PermissionResponseParams, StartBtwParams, DiagHeartbeatPayload } from "./api";
export { permissionsApi } from "./api/permissions";

export type { AideTransport } from "./transport";
export { setTransport, getTransport, listen, openExternal } from "./transport";

export { RemoteTransport } from "./remote";
export type { ConnState, ConnectCreds, PairOk, WsLike } from "./remote";
