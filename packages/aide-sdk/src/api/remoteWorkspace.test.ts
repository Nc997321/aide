import { describe, expect, it } from "vitest";
import { isRemotePath, parseRemotePath, remoteDesktopPath, resolveAgainstWorkspace } from "./remoteWorkspace";
import { resolveFileLinkPath } from "../utils/fileLink";

// 与 Rust remote_workspace/path.rs 的用例对齐：Rust 为准，这里是显示/判定用的影子实现。
describe("parseRemotePath", () => {
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
      expect(isRemotePath(p)).toBe(false);
    }
  });
});

describe("remoteDesktopPath", () => {
  it("往返", () => {
    const d = remoteDesktopPath("wsl:Debian", "/home/u/p/a.rs");
    expect(d).toBe("\\\\wsl.localhost\\Debian\\home\\u\\p\\a.rs");
    expect(parseRemotePath(d)?.posix).toBe("/home/u/p/a.rs");
  });
  it("根目录", () => {
    expect(remoteDesktopPath("ssh:box", "/")).toBe("\\\\aide-ssh.invalid\\box\\");
  });
});

describe("聊天文件链接解析（远程会话）", () => {
  const ws = "\\\\wsl.localhost\\Debian\\home\\u\\p";
  it("目标机绝对路径 → 该主机的桌面形态", () => {
    expect(resolveAgainstWorkspace("/home/u/p/src/a.rs", ws)).toBe("\\\\wsl.localhost\\Debian\\home\\u\\p\\src\\a.rs");
    expect(resolveFileLinkPath("/home/u/p/src/a.rs", ws)).toBe("\\\\wsl.localhost\\Debian\\home\\u\\p\\src\\a.rs");
  });
  it("本机工作区的 POSIX 路径原样返回（mac / Linux 桌面）", () => {
    expect(resolveFileLinkPath("/Users/u/a.rs", "/Users/u")).toBe("/Users/u/a.rs");
  });
  it("相对路径仍挂到工作区根下", () => {
    expect(parseRemotePath(resolveFileLinkPath("src/a.rs", ws))?.posix).toBe("/home/u/p/src/a.rs");
  });
});
