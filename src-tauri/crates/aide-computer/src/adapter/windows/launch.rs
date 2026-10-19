//! 启动应用：读开始菜单（`shell:AppsFolder`，桌面程序与商店应用都在里面），按名字挑一个启动。

use std::time::{Duration, Instant};

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::Shell::{
    IEnumShellItems, IShellItem, SHGetKnownFolderItem, ShellExecuteW, BHID_EnumItems, FOLDERID_AppsFolder,
    KF_FLAG_DEFAULT, SIGDN, SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use crate::apps::{looks_like_command, pick, App};
use crate::port::Res;

const LIST_TTL: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct Launcher {
    apps: Vec<App>,
    read_at: Option<Instant>,
}

impl Launcher {
    pub fn launch(&mut self, app: &str) -> Res<String> {
        if looks_like_command(app) {
            shell_open(app.trim())?;
            return Ok(app.trim().to_string());
        }
        if self.read_at.is_none_or(|t| t.elapsed() > LIST_TTL) {
            self.apps = unsafe { list_apps() }?;
            self.read_at = Some(Instant::now());
        }
        let chosen = pick(&self.apps, app)?.clone();
        shell_open(&format!("shell:AppsFolder\\{}", chosen.launch_id))?;
        Ok(chosen.name)
    }
}

fn shell_open(target: &str) -> Res<()> {
    let file = HSTRING::from(target);
    let op = HSTRING::from("open");
    let r = unsafe { ShellExecuteW(None, &op, &file, PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
    if (r.0 as isize) <= 32 {
        return Err(format!("Windows could not start \"{target}\" (code {}).", r.0 as isize));
    }
    Ok(())
}

unsafe fn list_apps() -> Res<Vec<App>> {
    let folder: IShellItem = SHGetKnownFolderItem(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None)
        .map_err(|e| format!("Could not read the Start menu: {e}"))?;
    let items: IEnumShellItems =
        folder.BindToHandler(None, &BHID_EnumItems).map_err(|e| format!("Could not read the Start menu: {e}"))?;
    let mut out = Vec::new();
    loop {
        let mut batch: [Option<IShellItem>; 1] = [None];
        let mut fetched = 0u32;
        if items.Next(&mut batch, Some(&mut fetched)).is_err() || fetched == 0 {
            break;
        }
        let Some(item) = batch[0].take() else { break };
        let (Some(name), Some(id)) = (display(&item, SIGDN_NORMALDISPLAY), display(&item, SIGDN_PARENTRELATIVEPARSING))
        else {
            continue;
        };
        out.push(App { name, launch_id: id });
    }
    Ok(out)
}

unsafe fn display(item: &IShellItem, kind: SIGDN) -> Option<String> {
    let p = item.GetDisplayName(kind).ok()?;
    let s = p.to_string().ok();
    CoTaskMemFree(Some(p.0 as *const _));
    s.filter(|s| !s.is_empty())
}
