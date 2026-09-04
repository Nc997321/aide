"""生成 Aide 内置插件图标：64x64 圆角方形 + 双色渐变 + 白色缩写字母。

产物写入 src-tauri/resources/builtin-icons/，由 Rust `include_bytes!` 内嵌进二进制，
经 data URL 下发前端（见 src-tauri/src/commands/marketplace/bundled.rs）。
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).parent.parent / "src-tauri" / "resources" / "builtin-icons"
FONT = Path(
    r"C:\Users\<user>\AppData\Roaming\kimi-desktop\daimon-share\daimon\runtime\python"
    r"\.venv\Lib\site-packages\matplotlib\mpl-data\fonts\ttf\DejaVuSans-Bold.ttf"
)
SIZE = 64
RADIUS = 14
SS = 4  # supersample 抗锯齿

# name -> (缩写, 顶部色, 底部色)
ICONS = {
    # 自动安装（精选）
    "superpowers": ("SP", "#8B5CF6", "#6D28D9"),
    "commit-commands": ("CC", "#F59E0B", "#D97706"),
    "pr-review-toolkit": ("PR", "#3B82F6", "#1D4ED8"),
    "security-guidance": ("SG", "#EF4444", "#B91C1C"),
    # 精选推荐（不自动安装）
    "github": ("GH", "#4B5563", "#111827"),
    "playwright": ("Pw", "#2EAD33", "#15803D"),
    # 有图标（普通条目）
    "hookify": ("Hk", "#EC4899", "#BE185D"),
    "frontend-design": ("FD", "#06B6D4", "#0E7490"),
    "agent-sdk-dev": ("SDK", "#6366F1", "#4338CA"),
    "plugin-dev": ("PD", "#14B8A6", "#0F766E"),
    "typescript-lsp": ("TS", "#3178C6", "#1E40AF"),
    "pyright-lsp": ("Py", "#F97316", "#C2410C"),
}


def hex_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def make_icon(text: str, top: str, bottom: str, out: Path) -> None:
    s = SIZE * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    # 垂直渐变
    c1, c2 = hex_rgb(top), hex_rgb(bottom)
    grad = Image.new("RGBA", (1, s))
    for y in range(s):
        t = y / (s - 1)
        grad.putpixel(
            (0, y), tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3)) + (255,)
        )
    grad = grad.resize((s, s))
    # 圆角蒙版
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, s - 1, s - 1], radius=RADIUS * SS, fill=255
    )
    img.paste(grad, (0, 0), mask)
    # 轻微顶部高光
    hl = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(hl).rounded_rectangle(
        [0, 0, s - 1, s // 2], radius=RADIUS * SS, fill=(255, 255, 255, 26)
    )
    img.alpha_composite(Image.composite(hl, Image.new("RGBA", (s, s)), mask))
    # 字母
    font_size = int(s * (0.34 if len(text) <= 2 else 0.26))
    font = ImageFont.truetype(str(FONT), font_size)
    d = ImageDraw.Draw(img)
    bbox = d.textbbox((0, 0), text, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(
        ((s - w) / 2 - bbox[0], (s - h) / 2 - bbox[1]),
        text,
        font=font,
        fill=(255, 255, 255, 245),
    )
    img = img.resize((SIZE, SIZE), Image.LANCZOS).filter(
        ImageFilter.GaussianBlur(0.2)
    )
    img.save(out, optimize=True)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (text, top, bottom) in ICONS.items():
        make_icon(text, top, bottom, OUT / f"{name}.png")
        print(f"✓ {name}.png")


if __name__ == "__main__":
    main()
