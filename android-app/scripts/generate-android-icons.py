#!/usr/bin/env python3
"""Generate native Android launcher icons from the logo saved in TaskMtaani admin settings."""
import base64, json, re, urllib.request
from pathlib import Path
from io import BytesIO
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
url_match = re.search(r'TASKMTAANI_SUPABASE_URL\s*=\s*["\']([^"\']+)', HTML)
key_match = re.search(r'TASKMTAANI_SUPABASE_ANON_KEY\s*=\s*["\']([^"\']+)', HTML)
if not url_match or not key_match:
    raise SystemExit("Could not find the public Supabase configuration in index.html")
url = url_match.group(1).rstrip("/")
key = key_match.group(1)
request = urllib.request.Request(
    url + "/rest/v1/site_settings?setting_key=eq.brand_settings_json&select=setting_value&limit=1",
    headers={"apikey": key, "Authorization": "Bearer " + key}
)
with urllib.request.urlopen(request, timeout=30) as response:
    rows = json.loads(response.read().decode("utf-8"))
if not rows:
    raise SystemExit("No brand_settings_json record found in public site settings")
value = rows[0]["setting_value"]
brand = json.loads(value) if isinstance(value, str) else value
logo = brand.get("logo", "")
if not logo.startswith("data:image/") or "," not in logo:
    raise SystemExit("The saved TaskMtaani logo is not an embedded image data URL")
image_bytes = base64.b64decode(logo.split(",", 1)[1])
source = Image.open(BytesIO(image_bytes)).convert("RGBA")
# The supplied master logo has its service emblem above the wordmark.
# Crop the emblem only so the launcher mark remains legible at small sizes.
w, h = source.size
left, top, right, bottom = int(w * 0.12), int(h * 0.044), int(w * 0.88), int(h * 0.826)
emblem = source.crop((left, top, right, bottom))
bbox = emblem.getchannel("A").getbbox()
if bbox:
    emblem = emblem.crop(bbox)

res_dir = ROOT / "android" / "app" / "src" / "main" / "res"
for density, size in [("mdpi",48),("hdpi",72),("xhdpi",96),("xxhdpi",144),("xxxhdpi",192)]:
    folder = res_dir / ("mipmap-" + density)
    folder.mkdir(parents=True, exist_ok=True)
    canvas = Image.new("RGBA", (size,size), (255,255,255,255))
    mark = emblem.copy()
    mark.thumbnail((int(size*0.78),int(size*0.78)), Image.Resampling.LANCZOS)
    canvas.alpha_composite(mark, ((size-mark.width)//2,(size-mark.height)//2))
    canvas.save(folder / "ic_launcher.png", optimize=True)

# Android adaptive icon foreground: keep the emblem inside the safe central zone.
foreground = Image.new("RGBA", (432,432), (0,0,0,0))
mark = emblem.copy()
mark.thumbnail((300,300), Image.Resampling.LANCZOS)
foreground.alpha_composite(mark, ((432-mark.width)//2,(432-mark.height)//2))
drawable = res_dir / "drawable-nodpi"
drawable.mkdir(parents=True, exist_ok=True)
foreground.save(drawable / "ic_launcher_foreground.png", optimize=True)

colors = res_dir / "values"
colors.mkdir(parents=True, exist_ok=True)
(colors / "ic_launcher_background.xml").write_text(
    '<?xml version="1.0" encoding="utf-8"?>\\n<resources><color name="ic_launcher_background">#FFFFFF</color></resources>\\n',
    encoding="utf-8"
)
adaptive = res_dir / "mipmap-anydpi-v26"
adaptive.mkdir(parents=True, exist_ok=True)
(adaptive / "ic_launcher.xml").write_text(
    '<?xml version="1.0" encoding="utf-8"?>\\n'
    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">'
    '<background android:drawable="@color/ic_launcher_background"/>'
    '<foreground android:drawable="@drawable/ic_launcher_foreground"/>'
    '</adaptive-icon>\\n',
    encoding="utf-8"
)
print("Generated TaskMtaani launcher icons from the currently saved admin logo.")
