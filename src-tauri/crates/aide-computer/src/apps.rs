//! 按名字挑应用（纯函数；应用列表由适配器从开始菜单读出）。

/// 开始菜单里的一个应用：显示名 + 启动用的标识。
#[derive(Debug, Clone, PartialEq)]
pub struct App {
    pub name: String,
    pub launch_id: String,
}

/// 精确（忽略大小写）> 开头匹配 > 包含；同一档多个时，精确取第一个，其余档报歧义。
pub fn pick<'a>(apps: &'a [App], query: &str) -> Result<&'a App, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Err("Pass the application's name as `app`.".into());
    }
    let name = |a: &App| a.name.to_lowercase();
    if let Some(a) = apps.iter().find(|a| name(a) == q) {
        return Ok(a);
    }
    for tier in [
        apps.iter().filter(|a| name(a).starts_with(&q)).collect::<Vec<_>>(),
        apps.iter().filter(|a| name(a).contains(&q)).collect::<Vec<_>>(),
    ] {
        match tier.len() {
            0 => continue,
            1 => return Ok(tier[0]),
            n => {
                let list: Vec<&str> = tier.iter().take(10).map(|a| a.name.as_str()).collect();
                return Err(format!("\"{query}\" matches {n} apps: {}. Pass the exact name.", list.join(", ")));
            }
        }
    }
    Err(format!(
        "No app named \"{query}\" in the Start menu. Try another name the user would see in the Start menu, or an executable name such as notepad.exe."
    ))
}

/// `app` 看起来像可执行文件或路径（直接交给系统启动，不查开始菜单）。
pub fn looks_like_command(app: &str) -> bool {
    let a = app.trim().to_lowercase();
    a.ends_with(".exe") || a.contains('\\') || a.contains('/')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apps() -> Vec<App> {
        ["记事本", "Windows Terminal", "Terminal Preview", "Terminal Canary", "Notepad++", "计算器"]
            .iter()
            .map(|n| App { name: n.to_string(), launch_id: format!("id:{n}") })
            .collect()
    }

    #[test]
    fn exact_beats_prefix() {
        let a = apps();
        assert_eq!(pick(&a, "记事本").unwrap().name, "记事本");
        assert_eq!(pick(&a, "notepad").unwrap().name, "Notepad++");
    }

    #[test]
    fn ambiguous_lists_candidates() {
        let a = apps();
        let e = pick(&a, "terminal").unwrap_err();
        assert!(e.contains("matches 2"), "{e}");
        assert_eq!(pick(&a, "windows term").unwrap().name, "Windows Terminal");
    }

    #[test]
    fn unknown_and_commands() {
        assert!(pick(&apps(), "photoshop").is_err());
        assert!(looks_like_command("wt.exe"));
        assert!(looks_like_command(r"C:\Tools\x.exe"));
        assert!(!looks_like_command("记事本"));
    }
}
