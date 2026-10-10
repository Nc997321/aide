/** 侧栏应用（Aide App）。字段与 Host 的 `apps::store::AppInfo` 同形（camelCase）。 */
export interface AppInfo {
  id: string;
  name: string;
  version: string;
  /** 应用目录内的图标路径（未经同意也可取）。 */
  icon: string | null;
  /** right = 右栏 rail 的一个 tab；main = 左侧栏导航组里的一行，点开占主区。 */
  placement: "right" | "main";
  /** 界面入口（应用目录内的相对路径）。 */
  entry: string;
  permissions: string[];
  hasServer: boolean;
  /** user = 已安装（`~/.aide/apps`）；workspace = 受信任工作区里的开发态。 */
  source: "user" | "workspace";
  enabled: boolean;
  /** 用户已同意**当前这份**权限与后端入口。 */
  consented: boolean;
  /** 同意的对象，原样回传给 `consent`：保证用户同意的就是他看到的那一份。 */
  grant: string;
  /** 应用文件的最新修改时刻；变了面板就重载。 */
  revision: number;
  /** 后端里 agent 调用时免确认的工具：安装版应用自己标成只读的。开发态恒为空（全部逐次确认）。 */
  readOnlyTools: string[];
  /** 这个 id 有安装版。开发态 + installed = 装过之后又改了（面板提示「更新安装」）。 */
  installed: boolean;
  /** 不管开着哪个工作区都看得见：安装版，或放在日常目录里的开发态。 */
  alwaysVisible: boolean;
  /** 清单有问题时的说明（此时其余字段不可信）。 */
  error: string | null;
}
