"""本地截图自查：python tools/shot.py [输出目录]  —— 需先在仓库根目录起 http.server 8799"""
import sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/tp-shots"); OUT.mkdir(parents=True, exist_ok=True)
URL = "http://localhost:8799/"
ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]

with sync_playwright() as pw:
    b = pw.chromium.launch(args=ARGS)
    for name, vp, mob in [("desk", {"width": 1440, "height": 900}, False), ("phone", {"width": 390, "height": 844}, True)]:
        ctx = b.new_context(viewport=vp, device_scale_factor=2 if mob else 1, is_mobile=mob, has_touch=mob)
        pg = ctx.new_page(); logs = []
        pg.on("console", lambda m: logs.append(f"{m.type}: {m.text}"))
        pg.on("pageerror", lambda e: logs.append(f"PAGEERROR: {e}"))
        pg.goto(URL); pg.wait_for_timeout(9000); pg.screenshot(path=str(OUT / f"{name}_1_globe.png"))
        pg.click("#dice"); pg.wait_for_timeout(12000); pg.screenshot(path=str(OUT / f"{name}_2_random.png"))
        pg.click("#play"); pg.wait_for_timeout(14000); pg.screenshot(path=str(OUT / f"{name}_3_play.png"))
        pg.click("#play")
        if not mob:
            pg.click('[data-cat="glacier"]'); pg.wait_for_timeout(1500); pg.click('[data-dist="m"]'); pg.wait_for_timeout(4000)
            pg.screenshot(path=str(OUT / f"{name}_4_filter.png"))
        pg.click("#globe"); pg.wait_for_timeout(3000); pg.click("#tour"); pg.wait_for_timeout(22000); pg.screenshot(path=str(OUT / f"{name}_5_tour.png"))
        print(name, "\n".join(l for l in logs if "PAGEERROR" in l or "error" in l.lower())[:2000])
        ctx.close()
    b.close()
print("→", OUT)
