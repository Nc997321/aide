import { describe, expect, it } from "vitest";
import { parseRemotePath } from "./remoteWorkspace";
import { resolveFileLinkPath } from "../utils/fileLink";

// 旧版登记的 UNC 远程工作区：侧栏据此认出它属于哪台 Host（点开进该 Host 的窗口）。
describe("parseRemotePath（旧版远程工作区条目）", () => {
  it("识别 WSL 的各种写法", () => {
    for (const p of [
      "\\\\wsl.localhost\\Debian\\home\\u\\proj",
      "//wsl.localhost/Debian/home/u/proj",
      "\\\\wsl$\\Debian\\home\\u\\proj\\",
    ]) {
      expect(parseRemotePath(p)).toEqual({ host: "wsl:Debian", label: "WSL: Debian", posix: "/home/u/proj" });
    }
  });

  it("识别 SSH 形态", () => {
    expect(parseRemotePath("\\\\aide-ssh.invalid\\me@box\\srv\\app")).toEqual({
      host: "ssh:me@box",
      label: "SSH: me@box",
      posix: "/srv/app",
    });
  });

  it("本机路径与普通 UNC 不是远程", () => {
    for (const p of ["C:\\Users\\u", "/home/u", "\\\\fileserver\\share\\x", ""]) {
      expect(parseRemotePath(p)).toBeNull();
    }
  });
});

// Host 窗口里的路径就是 Host 原生路径：聊天文件链接不做任何翻译。
describe("聊天文件链接解析（Host 原生路径）", () => {
  it("POSIX 绝对路径原样返回", () => {
    expect(resolveFileLinkPath("/home/u/p/src/a.rs", "/home/u/p")).toBe("/home/u/p/src/a.rs");
  });
  it("相对路径挂到工作区根下", () => {
    expect(resolveFileLinkPath("src/a.rs", "/home/u/p")).toBe("/home/u/p/src/a.rs");
  });
});
