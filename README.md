# 徒步星球

在 3D 地球上看全世界的经典徒步路线。纯静态网页，手机、电脑都能用。

- **44 条路线**：环勃朗峰、珠峰大本营、冈仁波齐转山、虎跳峡、熊野古道、米尔福德、五渔村……
- **按地貌筛选**：雪山 / 冰川 / 森林 / 海岸 / 峡谷峡湾 / 火山 / 奇峰 / 草甸荒原
- **按里程筛选**：≤10 km / 10–30 / 30–100 / 100+
- **随机**：随机传送到地球上某条路线
- **自动巡游**：自动挑路线 → 飞过去 → 3D 沿线飞行 → 下一条（手动拖动地图即暂停）
- **沿线查看**：拖滑块或在海拔剖面上拖动，镜头跟着走
- 链接带 `#路线id` 直达，如 `#tmb`、`#kailash`

## 运行

```sh
python3 -m http.server 8799   # 然后打开 http://localhost:8799
```

## 数据

| 内容 | 来源 |
|---|---|
| 卫星影像 | Esri World Imagery |
| 3D 地形 | AWS Terrain Tiles（Mapzen Terrarium） |
| 路线轨迹 | 途经点沿 OpenStreetMap 步道 / 步行路网生成（Overpass、OSRM、高德步行） |
| 海拔剖面 | 轨迹上采样 AWS 高程 |
| 里程、天数、最高海拔、季节、介绍 | 常见走法的公开信息，仅供参考 |

轨迹是按途经点生成的近似线，不是官方 GPX；往返线只画去程。出发前请以当地最新信息为准。

## 增改路线

编辑 `tools/trails.py`（途经点可写坐标或地名），然后：

```sh
uv run --with certifi --with pillow python tools/build.py [路线id …]
```

构建脚本复用 [map-motion](https://github.com/SpaceZephyr/map-motion) 的 `amap / osm / dem` 模块（需在 `~/Documents/GitHub/map-motion`），高德地名需要 `AMAP_KEY`。

## 技术

MapLibre GL JS 5（地球投影 + 地形），无框架，`index.html` + `app.js` + `data/trails.json`。
