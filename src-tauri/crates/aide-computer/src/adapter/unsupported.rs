//! 还没有适配器的平台：每个调用如实回「此平台暂不支持」，agent 能直接转告用户。

use std::time::Duration;

use crate::keys::Combo;
use crate::model::{Direction, MouseButton, PatternClick, RawTree, Shot, WindowAction, WindowInfo};
use crate::port::{Backend, Guard, Res};

fn no<T>() -> Res<T> {
    Err(format!(
        "Operating the computer is not supported on this platform yet ({}); it is available on Windows.",
        std::env::consts::OS
    ))
}

pub struct Unsupported;

impl Backend for Unsupported {
    fn list_windows(&mut self) -> Res<Vec<WindowInfo>> {
        no()
    }
    fn window(&mut self, _: &str) -> Res<WindowInfo> {
        no()
    }
    fn foreground(&mut self) -> Option<String> {
        None
    }
    fn focused_element(&mut self) -> Option<(Vec<i32>, String)> {
        None
    }
    fn window_action(&mut self, _: &str, _: WindowAction) -> Res<()> {
        no()
    }
    fn launch(&mut self, _: &str) -> Res<String> {
        no()
    }
    fn snapshot(&mut self, _: &str, _: Option<u32>) -> Res<RawTree> {
        no()
    }
    fn screenshot(&mut self, _: &str, _: u32) -> Res<Shot> {
        no()
    }
    fn element_alive(&mut self, _: &str, _: &[i32], _: &str) -> Res<bool> {
        no()
    }
    fn pattern_click(&mut self, _: &str, _: &[i32]) -> Res<PatternClick> {
        no()
    }
    fn element_center(&mut self, _: &str, _: &[i32]) -> Res<(i32, i32)> {
        no()
    }
    fn focus_element(&mut self, _: &str, _: &[i32]) -> Res<()> {
        no()
    }
    fn set_value(&mut self, _: &str, _: &[i32], _: &str) -> Res<()> {
        no()
    }
    fn bring_to_front(&mut self, _: &str) -> Res<()> {
        no()
    }
    fn check_point(&mut self, _: &str, _: i32, _: i32) -> Res<()> {
        no()
    }
    fn mouse_click(&mut self, _: i32, _: i32, _: MouseButton, _: u32) -> Res<()> {
        no()
    }
    fn scroll(&mut self, _: i32, _: i32, _: Direction, _: u32) -> Res<()> {
        no()
    }
    fn type_text(&mut self, _: &str, _: &str, _: &dyn Fn() -> Option<String>) -> Res<usize> {
        no()
    }
    fn press(&mut self, _: &str, _: &Combo) -> Res<()> {
        no()
    }
}

pub struct NoGuard;

impl Guard for NoGuard {
    fn watch_input(&self, _: bool) {}
    fn show(&self, _: Option<String>, _: Option<Duration>) {}
}
