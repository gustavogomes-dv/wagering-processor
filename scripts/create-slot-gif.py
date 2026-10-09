from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 720, 360
OUT = Path("docs/wagering-slot.gif")
OUT.parent.mkdir(parents=True, exist_ok=True)

FONT_PATH = "C:/Windows/Fonts/seguiemj.ttf"
TEXT_PATH = "C:/Windows/Fonts/arialbd.ttf"

def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()

title_font = font(TEXT_PATH, 24)
symbol_font = font(TEXT_PATH, 46)
small_font = font(TEXT_PATH, 18)

def centered(draw, box, text, used_font, fill):
    draw.text(((box[0] + box[2]) / 2, (box[1] + box[3]) / 2), text,
              font=used_font, fill=fill, anchor="mm")

def frame(index):
    image = Image.new("RGB", (WIDTH, HEIGHT), "#10251f")
    draw = ImageDraw.Draw(image)

    # Fundo com folhas simples para lembrar o tema de selva.
    for x, y, color in [(35, 35, "#1e6249"), (675, 42, "#2f8057"), (55, 300, "#245f45"), (650, 300, "#1b513b")]:
        draw.ellipse((x - 35, y - 14, x + 35, y + 14), fill=color)
        draw.line((x - 25, y + 20, x + 25, y - 20), fill="#65a86b", width=3)

    # Corpo e cabeça do macaco.
    draw.ellipse((62, 88, 214, 240), fill="#70432e", outline="#d09a55", width=5)
    draw.ellipse((47, 105, 105, 174), fill="#a96e42", outline="#d09a55", width=4)
    draw.ellipse((171, 105, 229, 174), fill="#a96e42", outline="#d09a55", width=4)
    draw.ellipse((73, 72, 202, 188), fill="#a96e42", outline="#d09a55", width=5)
    draw.ellipse((91, 108, 184, 180), fill="#d9a56b")
    draw.ellipse((105, 113, 120, 130), fill="#13231d")
    draw.ellipse((153, 113, 168, 130), fill="#13231d")
    draw.ellipse((123, 140, 151, 161), fill="#75462f")
    draw.arc((112, 139, 162, 178), 10, 170, fill="#13231d", width=4)
    draw.ellipse((145, 195, 224, 220), fill="#a96e42")

    # Máquina.
    machine = (245, 53, 650, 315)
    draw.rounded_rectangle(machine, radius=24, fill="#d99a3d", outline="#f7d477", width=6)
    draw.rounded_rectangle((267, 83, 628, 286), radius=18, fill="#263d34", outline="#f7d477", width=4)
    centered(draw, (267, 58, 628, 92), "WAGERING", title_font, "#fff1b8")

    symbols = ["7", "$", "★", "●"]
    for column, x in enumerate((286, 394, 502)):
        box = (x, 115, x + 85, 255)
        draw.rounded_rectangle(box, radius=12, fill="#f5e7bf", outline="#a8612c", width=4)
        if index < 8:
            symbol = symbols[(index + column * 2) % len(symbols)]
        else:
            symbol = ["7", "7", "7"][column]
        centered(draw, box, symbol, symbol_font, "#b52e36" if symbol == "7" else "#245744")

    # Alavanca, movida durante os primeiros quadros.
    pull = min(index, 4) / 4
    base_x, base_y = 666, 235
    end_y = 126 + int(76 * pull)
    draw.line((base_x, base_y, base_x, end_y), fill="#f1d08a", width=12)
    draw.ellipse((base_x - 19, end_y - 19, base_x + 19, end_y + 19), fill="#b52e36", outline="#f7d477", width=4)
    draw.ellipse((base_x - 13, base_y - 13, base_x + 13, base_y + 13), fill="#6c422c")

    if index >= 10:
        centered(draw, (280, 263, 600, 300), "PROCESSADO!", small_font, "#ffe38c")
    else:
        centered(draw, (280, 263, 600, 300), "PROCESSANDO...", small_font, "#b9d7a3")
    return image

frames = [frame(index) for index in range(12)]
frames[0].save(OUT, save_all=True, append_images=frames[1:], duration=[120] * 4 + [90] * 6 + [700] * 2,
               loop=0, optimize=True)
print(OUT)
