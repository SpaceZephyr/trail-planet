"""trails.py → data/trails.json：解析途经点、沿 OSM 路网连成真实轨迹、采样海拔剖面。

用 map-motion 的 amap / osm / dem 模块（高德地名、Overpass 小路最短路、AWS 高程）。
  uv run --with certifi --with pillow python tools/build.py [id …]     # 只重建指定路线
"""
import json, math, sys, time, urllib.parse, urllib.request
from pathlib import Path

HERE = Path(__file__).parent
MM = Path.home() / "Documents/GitHub/map-motion/scripts"
sys.path.insert(0, str(MM)); sys.path.insert(0, str(HERE))
import amap, osm, dem, elev
from trails import TRAILS

CACHE = HERE / ".cache"; CACHE.mkdir(exist_ok=True)
GEO = CACHE / "geocode.json"; geo = json.loads(GEO.read_text()) if GEO.exists() else {}
UA = {"User-Agent": "trail-planet/1.0 (hiking map build script)"}
osm.MIRRORS = ["https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass-api.de/api/interpreter"]
NETFAIL = []


def km(a, b): return osm._km(a, b)


def length(line): return sum(km(a, b) for a, b in zip(line, line[1:]))


def get_json(url):
    for i in range(3):
        try: return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60, context=amap._ctx()))
        except Exception as e: err = e; time.sleep(2)
    raise RuntimeError(err)


def resolve(p, t):
    if not isinstance(p, str): return list(p)
    key = ("cn:" if t.get("cn") else t.get("cc", "") + ":") + p
    if key not in geo:
        g = None
        if t.get("cn"):
            try:
                r = amap.get("/v3/place/text", keywords=p, city=t.get("city"), citylimit="true" if t.get("city") else None, offset=1, page=1).get("pois") or []
                g = r[0]; geo[key] = elev.gcj2wgs(*amap.ll(g["location"])) + [g["name"] + " " + g.get("adname", "")]
            except BaseException as e: print(f"     高德找不到 {p}，改用 Nominatim"); g = None
        if g is None:
            q = urllib.parse.urlencode({"q": p, "format": "json", "limit": 1, "countrycodes": t.get("cc", "cn" if t.get("cn") else "")})
            r = get_json(f"https://nominatim.openstreetmap.org/search?{q}"); time.sleep(1.1)
            if not r: raise SystemExit(f"[{t['id']}] Nominatim 找不到：{p}")
            geo[key] = [float(r[0]["lon"]), float(r[0]["lat"]), r[0]["display_name"][:60]]
        GEO.write_text(json.dumps(geo, ensure_ascii=False, indent=1))
    g = geo[key]; print(f"     {p:<28} → {g[0]:.4f},{g[1]:.4f}  {g[2]}"); return g[:2]


def osrm(via):
    c = ";".join(f"{x:.6f},{y:.6f}" for x, y in via)
    r = get_json(f"https://routing.openstreetmap.de/routed-foot/route/v1/foot/{c}?overview=full&geometries=geojson")
    return r["routes"][0]["geometry"]["coordinates"]


def segs(via):
    """逐段：先 OSRM 步行路由；绕得离谱再在 OSM 小路网里求最短路；都不行这段直连"""
    line = []
    for a, b in zip(via, via[1:]):
        d = km(a, b); ok = lambda s: length(s) <= max(2.2 * d, d + 3)
        s = None
        try:
            s = osrm([a, b])
            if not ok(s): s = None
        except Exception as e: print(f"       osrm 段失败 {str(e)[:40]}")
        if s is None:
            for i in range(2):
                try:
                    s = osm.trail([a, b], 0.03 if d < 15 else 0.06)
                    if not ok(s): s = None
                    break
                except BaseException as e:
                    msg = str(e); s = None
                    if "查询失败" not in msg: break
                    if i: NETFAIL.append(1)
                    time.sleep(5)
        if s is None: print(f"       段 {a}→{b} {d:.1f} km 直连"); s = straight([a, b])
        line += s if not line else s[1:]
    return line


def amap_walk(via):
    line = []
    for a, b in zip(via, via[1:]):
        r = amap.route(amap.wgs2gcj(*a), amap.wgs2gcj(*b), "walking")
        line += [elev.gcj2wgs(*p) for p in r["line"]]
    return line


def straight(via):
    out = []
    for a, b in zip(via, via[1:]):
        n = max(2, int(km(a, b) / 0.3))
        out += [[a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n] for i in range(n)]
    return out + [via[-1]]


def route(t, via):
    f = CACHE / f"route_{t['id']}.json"
    if f.exists(): return json.loads(f.read_text())
    want = (t["km"] / (2 if t["kind"] == "outback" else 1)) if t["km"] else None
    span = max(max(p[0] for p in via) - min(p[0] for p in via), max(p[1] for p in via) - min(p[1] for p in via))
    tries = []
    methods = (["osm"] if span < 0.35 else ["seg"]) + (["amap"] if t.get("cn") else []) + ["osrm"]
    for m in methods:
        try:
            line = {"osm": lambda: osm.trail(via, 0.02), "osrm": lambda: osrm(via), "seg": lambda: segs(via), "amap": lambda: amap_walk(via)}[m]()
            L = length(line); tries.append((m, L, line)); print(f"     {m:<5} {L:6.1f} km" + (f"（公认 {want:g}）" if want else ""))
            if want is None or 0.75 < L / want < 1.3: break
        except BaseException as e:
            print(f"     {m:<5} 失败：{str(e)[:80]}")
            if "查询失败" in str(e): NETFAIL.append(1)
    if not tries: tries.append(("line", length(straight(via)), straight(via)))
    good = [x for x in tries if want is None or 0.6 < x[1] / want < 1.6]     # 先信 OSM 小路（按尝试顺序），差得太多才比谁更接近
    m, L, line = good[0] if good else min(tries, key=lambda x: abs(math.log(x[1] / want)) if want else 0)
    if want and not 0.6 < L / want < 1.6:
        print(f"     !! 路网结果偏差大（{L:.1f} vs {want}），改用途经点直连"); m, line = "line", straight(via)
    res = {"src": m, "line": line}
    if not NETFAIL: f.write_text(json.dumps(res))
    NETFAIL.clear(); return res


def profile(line, n=160):
    cum = [0.0]
    for a, b in zip(line, line[1:]): cum.append(cum[-1] + km(a, b))
    tot, out, j = cum[-1], [], 0
    for i in range(n + 1):
        d = tot * i / n
        while j < len(cum) - 2 and cum[j + 1] < d: j += 1
        u = (d - cum[j]) / max(1e-9, cum[j + 1] - cum[j]); a, b = line[j], line[j + 1]
        p = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]
        out.append([round(d, 2), round(dem.at(*p, z=12))])
    return out


def snap(line, p):
    """点到折线最近处的沿线里程（km）"""
    best, acc = (1e9, 0), 0.0
    for a, b in zip(line, line[1:]):
        seg = km(a, b); u = 0.0
        if seg > 0:
            k = math.cos(math.radians(a[1])); dx, dy = (b[0] - a[0]) * k, b[1] - a[1]
            u = max(0, min(1, (((p[0] - a[0]) * k) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
        q = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]
        best = min(best, (km(q, p), acc + seg * u)); acc += seg
    if best[0] > 0.4: print(f"     !! 看点 {p} 离轨迹 {best[0]:.2f} km")
    return best[1]


def stops(t, line, prof):
    out = []
    for s in t.get("stops", []):
        d = max(prof, key=lambda p: p[1])[0] if s["at"] == "top" else snap(line, s["at"])
        o = {k: s[k] for k in ("kind", "name", "text")}; o["d"] = round(d, 3)
        if s.get("look"): o["look"] = [*s["look"][:2], round(dem.at(*s["look"][:2], z=12))]   # 带上海拔，镜头好算仰角
        out.append(o)
    return sorted(out, key=lambda o: o["d"])


def main():
    only = set(sys.argv[1:]); dst = HERE.parent / "data/trails.json"
    old = {t["id"]: t for t in json.loads(dst.read_text())} if dst.exists() and only else {}
    out, bad = [], []
    for t in TRAILS:
        if only and t["id"] not in only:
            if t["id"] in old: out.append(old[t["id"]])
            continue
        print(f"[{t['id']}] {t['name']}")
        try:
            via = [resolve(p, t) for p in t["via"]]
            r = route(t, via); line = r["line"]
        except BaseException as e:
            print(f"     ✗ 跳过：{e}"); bad.append(t["id"]); continue
        line = amap.simplify(line, None)
        if t["kind"] == "loop" and km(line[0], line[-1]) > 0.05: line.append(line[0])
        L = length(line)
        for i in range(4):
            try: prof = profile(line); break
            except BaseException as e: print(f"     高程重试 {i + 1}"); time.sleep(3)
        else: bad.append(t["id"]); continue
        e = [p[1] for p in prof]
        gain = sum(max(0, b - a) for a, b in zip(e, e[1:]))
        o = {k: t[k] for k in ("id", "name", "en", "where", "cat", "kind", "days", "max", "level", "season", "desc")}
        o.update(km=t["km"] or round(L * (2 if t["kind"] == "outback" else 1), 1), line_km=round(L, 2), src=r["src"],
                 line=[[round(x, 5), round(y, 5)] for x, y in line], prof=prof, gain=round(gain / 10) * 10, lo=min(e), hi=max(e))
        if t.get("stops"): o["stops"] = stops(t, line, prof)
        if t.get("marks"): o["marks"] = t["marks"]
        out.append(o); print(f"     → {r['src']} {L:.1f} km, {len(line)} 点, 海拔 {min(e)}–{max(e)} m")
    dst.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    if bad: print("失败：", " ".join(bad))
    print(f"{len(out)} 条 → {dst}  {dst.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
