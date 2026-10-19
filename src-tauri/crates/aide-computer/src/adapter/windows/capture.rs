//! 窗口截图：`PrintWindow(PW_RENDERFULLCONTENT)`（被挡住也能截），裁掉隐形边框，缩放，编码 PNG。

use std::ffi::c_void;

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsIconic};

use super::win::frame;
use crate::model::Shot;
use crate::port::Res;

const PW_RENDERFULLCONTENT: u32 = 2;

pub fn window(hwnd: HWND, max_side: u32) -> Res<Shot> {
    if unsafe { IsIconic(hwnd) }.as_bool() {
        return Err("The window is minimized; restore it first (computer_window action=restore).".into());
    }
    let mut wr = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut wr) }.map_err(|e| format!("Could not get the window's position: {e}"))?;
    let (w, h) = (wr.right - wr.left, wr.bottom - wr.top);
    if w <= 0 || h <= 0 {
        return Err("The window has no visible area.".into());
    }
    let bgra = unsafe { print(hwnd, w, h)? };
    // 裁到可见框（DWM 扩展边界），坐标与 frame() 一致。
    let f = frame(hwnd);
    let (cx, cy) = ((f.x - wr.left).clamp(0, w), (f.y - wr.top).clamp(0, h));
    let (cw, ch) = (f.w.min(w - cx).max(1), f.h.min(h - cy).max(1));
    let cropped = crop(&bgra, w as usize, cx as usize, cy as usize, cw as usize, ch as usize);
    let scale = (max_side as f64 / cw.max(ch) as f64).min(1.0);
    let (ow, oh) = (((cw as f64) * scale).round().max(1.0) as usize, ((ch as f64) * scale).round().max(1.0) as usize);
    let rgb = resize_to_rgb(&cropped, cw as usize, ch as usize, ow, oh);
    let png = encode_png(&rgb, ow as u32, oh as u32)?;
    Ok(Shot { png, width: ow as u32, height: oh as u32, scale, origin: (f.x, f.y) })
}

unsafe fn print(hwnd: HWND, w: i32, h: i32) -> Res<Vec<u8>> {
    let screen = GetDC(None);
    let mem = CreateCompatibleDC(Some(screen));
    let bmp = CreateCompatibleBitmap(screen, w, h);
    let old = SelectObject(mem, bmp.into());
    let printed = PrintWindow(hwnd, mem, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool();
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // 自上而下
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut buf = vec![0u8; (w * h * 4) as usize];
    SelectObject(mem, old);
    let lines = GetDIBits(mem, bmp, 0, h as u32, Some(buf.as_mut_ptr() as *mut c_void), &mut info, DIB_RGB_COLORS);
    let _ = DeleteObject(bmp.into());
    let _ = DeleteDC(mem);
    ReleaseDC(None, screen);
    if !printed || lines == 0 {
        return Err("Windows could not capture this window.".into());
    }
    Ok(buf)
}

fn crop(src: &[u8], stride_px: usize, x: usize, y: usize, w: usize, h: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(w * h * 4);
    for row in y..y + h {
        let start = (row * stride_px + x) * 4;
        out.extend_from_slice(&src[start..start + w * 4]);
    }
    out
}

/// 区域平均缩小（UI 截图里文字缩小后仍清楚），BGRA → RGB。
fn resize_to_rgb(src: &[u8], w: usize, h: usize, ow: usize, oh: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(ow * oh * 3);
    for oy in 0..oh {
        let y0 = oy * h / oh;
        let y1 = ((oy + 1) * h / oh).max(y0 + 1).min(h);
        for ox in 0..ow {
            let x0 = ox * w / ow;
            let x1 = ((ox + 1) * w / ow).max(x0 + 1).min(w);
            let (mut r, mut g, mut b, mut n) = (0u32, 0u32, 0u32, 0u32);
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = (y * w + x) * 4;
                    b += src[i] as u32;
                    g += src[i + 1] as u32;
                    r += src[i + 2] as u32;
                    n += 1;
                }
            }
            out.extend_from_slice(&[(r / n) as u8, (g / n) as u8, (b / n) as u8]);
        }
    }
    out
}

fn encode_png(rgb: &[u8], w: u32, h: u32) -> Res<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgb).map_err(|e| e.to_string())?;
    }
    Ok(out)
}
