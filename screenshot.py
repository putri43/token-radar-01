#!/usr/bin/env python3
"""Take the three token-radar screenshots with the headless shell and tune each JPEG
into the 300-350 KB band the rules ask for (gate cap is 512 KiB)."""
import os
import shutil
import subprocess
import sys

CH = "/home/hatch/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell"
REPO = "/home/hatch/workspace/makefun/token-radar-01"
OUT = os.path.join(REPO, "out", "dashboard", "index.html")
SHOTS = [
    ("1-board.png", "file://" + OUT, "board"),
    ("2-detail.png", "file://" + OUT + "#p=sentora-curator", "detail"),
    ("3-filtered.png", "file://" + OUT + "#verdict=FARM", "filtered"),
]

from PIL import Image


def capture(name, url):
    png = os.path.join("/tmp", name)
    subprocess.run(
        [CH, "--no-sandbox", "--headless", "--disable-gpu", "--hide-scrollbars",
         "--window-size=1440,1400", "--screenshot=" + png,
         "--virtual-time-budget=8000", url],
        check=True, capture_output=True, text=True)
    return png


def to_jpeg(png, target=(300_000, 350_000)):
    im = Image.open(png).convert("RGB")
    for q in (88, 92, 95, 97, 100):
        out = "/tmp/tune.jpg"
        im.save(out, "JPEG", quality=q, optimize=True)
        size = os.path.getsize(out)
        if target[0] <= size <= target[1]:
            return out, size, q
    # Fall back: PNG if it lands in band, else the largest JPEG under the cap.
    out = "/tmp/tune.png"
    im.save(out, "PNG", optimize=True)
    size = os.path.getsize(out)
    if target[0] <= size <= target[1]:
        return out, size, "png"
    im.save("/tmp/tune.jpg", "JPEG", quality=100, optimize=True)
    size = os.path.getsize("/tmp/tune.jpg")
    return "/tmp/tune.jpg", size, 100


def main():
    for name, url, label in SHOTS:
        png = capture(name, url)
        im = Image.open(png)
        print(f"{label}: captured {im.size} PNG {os.path.getsize(png)} bytes")
        tuned, size, how = to_jpeg(png)
        ext = "jpg" if tuned.endswith(".jpg") else "png"
        dest = os.path.join(REPO, "screenshots", name.replace(".png", "." + ext))
        # Remove a same-stem file of the other extension, if any.
        for other in ("jpg", "png"):
            o = os.path.join(REPO, "screenshots", name.replace(".png", "." + other))
            if o != dest and os.path.exists(o):
                os.remove(o)
        os.replace(tuned, dest) if os.path.dirname(tuned) == os.path.dirname(dest) else shutil.move(tuned, dest)
        print(f"{label}: -> {os.path.basename(dest)} {size} bytes (quality={how})")
        if not (300_000 <= size <= 350_000):
            print(f"WARNING: {label} outside 300-350 KB band: {size} bytes", file=sys.stderr)


if __name__ == "__main__":
    main()
