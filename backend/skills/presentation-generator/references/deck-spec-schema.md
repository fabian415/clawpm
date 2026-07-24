# Deck Spec JSON Schema

`deck_builder.py` 讀取一份 JSON deck spec,把它渲染成 .pptx。你(agent)的工作是
**產出這份 spec**,不要自己寫 python-pptx。

## 頂層結構

```json
{
  "meta": {
    "title":    "專案名稱(封面與頁尾預設會用到)",
    "subtitle": "選填",
    "team":     "核心團隊(選填,封面用)",
    "date":     "YYYY-MM-DD(選填,封面用)",
    "footer":   "頁尾文字(選填,通常留空;不要放任何賽事/活動字樣)",
    "style":    "professional",
    "accentOrder": ["blue","green","gold","pink","sand"]
  },
  "slides": [ { "type": "...", ... }, ... ]
}
```

`meta.style`(使用者可選,後端會指定):一次套用一整組視覺走向(主色、配色順序、字級、卡片樣式),
但都在 ADVANTECH 模板色盤內。可選值:
- `professional`：沉穩商務(綠色主調、米色實心卡)—預設。
- `vivid`：活潑明亮(藍/粉主調、色彩豐富)。
- `minimal`：極簡留白(橄欖主調、字級略大、白底細框卡、較留白)。
- `warm`：溫暖大地(金/粉主調)。
**請把後端指定的 style 值原樣填入 meta.style。**

`meta.accentOrder`(選填):重排模板色盤順序讓配色節奏不同。有指定時會覆蓋 style 的預設配色;
通常交給 `style` 決定即可,要更多變化才自訂。值只能用:`green/blue/gold/pink/sand/green2`。

`meta.layoutSeed`(選填,整數):版面變體的預設種子。**每次生成請填不同值**(後端會給一個),
讓沒有明確指定 variant 的頁面也會採用不同的排版方式,避免每份簡報 layout 都一樣。

## 版面變體(layout variants)— 讓每次排版都不同

以下頁型可加 `variant`(或 `imageSide`)欄位切換排版方式。**請主動變換**,不要每頁、每份都用同一種:

| 頁型 | 欄位 | 可選值 | 說明 |
|---|---|---|---|
| `bullets` | `variant` | `list` / `cards` | 條列(小圓點)/ 卡片(每點一張卡) |
| `bullets` | `imageSide` | `left` / `right` | 有圖時圖片放左或右 |
| `stats` | `variant` | `row` / `grid` | 單排大字 / 2×2 方格 |
| `two_column` | `variant` | `panels` / `divider` | 米色卡片欄 / 無卡片中線分隔 |
| `section` | — | (自動) | 章節頁會在數種橄欖角形版面間自動輪替 |

不指定時會依 `meta.layoutSeed` 自動挑一種。要刻意指定就填,想讓系統隨機變化就留空。

`slides` 是一個陣列,依序就是投影片順序。每個元素有一個 `type` 欄位決定頁型。
每一頁都可加選填的 `"accent"`,值為:`green` / `blue` / `gold` / `pink` / `sand` / `green2` / `red`。
**多數頁面請「不要」設 accent**,留空會自動套用 `meta.style` 的主色,整份才會一致;只有想特別
強調某一頁(例如痛點頁用 `red`)時才覆寫。

## 圖片參照(重要)

- 任何 `image` 或 `images[].path` 欄位,值一律寫成 **`_assets/檔名.png`**(相對於專案的
  `project-insights/` 根目錄),例如 `"_assets/robotic-dashboard.png"`。
- **只能引用 `_assets/` 底下真實存在的檔案**。deck_builder 找不到檔案會直接報錯中止,
  逼你使用真圖,不得虛構檔名。
- 支援 PNG / JPG / GIF。向量/縮圖格式(emf/wmf/wdp/svg)請避免。
- 圖片一律等比例縮放置入、置中、不變形,你不需要煩惱尺寸。

## 頁型與欄位

### cover — 封面(不編頁碼)
```json
{"type":"cover","title":"專案標題","domain":"Key Area & Application","team":"核心團隊","date":"YYYY-MM-DD"}
```
封面**一律沿用模板原始封面**(ADVANTECH logo + 天空 + Edge Computing 標語),忠實重現原稿的
「Project Title / Domain—Key Area & Application / Core Team / Date」結構。**沒有 variant,不要放任何賽事字樣。**
只需提供 `title`(填 Project Title)、`domain`、`team`、`date`。

### toc — 目錄(自動編號徽章,超過 5 項自動兩欄)
```json
{"type":"toc","title":"目錄 Agenda","items":[
  {"title":"章節名","desc":"英文/補充說明"}, "也可以只給字串"
]}
```

### section — 章節分隔頁(整頁強調色底,不編頁碼)
```json
{"type":"section","title":"章節大標","kicker":"01 / Business Scenario","subtitle":"...","accent":"blue","image":"_assets/x.png"}
```

### summary — Executive Summary 表格式(左彩色標籤 + 右內容,一列一項)
```json
{"type":"summary","title":"Executive Summary","rows":[
  {"label":"Data Input","text":"..."},
  {"label":"AI Agent","text":"..."}
]}
```
建議 rows 4–7 項。對應模板的 Data Input / AI Agent / Delivery / Resources / AI Platform / Key Innovation / Expected Impact。

### bullets — 條列頁(可選右側配一張圖)
```json
{"type":"bullets","title":"...","subtitle":"...","accent":"red",
 "image":"_assets/x.png","caption":"圖說",
 "bullets":[{"heading":"重點標題","text":"說明文字"}, "也可只給字串"]}
```
建議 3–5 條。`image` 可省略(純文字頁)。

### two_column — 雙欄對照(如 Before/After、痛點/解法)
```json
{"type":"two_column","title":"...","subtitle":"...",
 "left":{"heading":"現況 Before","bullets":["...","..."]},
 "right":{"heading":"導入後 After","bullets":["...","..."]}}
```

### stats — 量化數據大字卡(2–4 張)
```json
{"type":"stats","title":"量化效益","subtitle":"Quantified Benefits",
 "stats":[{"value":"30-40%","label":"MQL→SQL 提升"}],
 "note":"* 資料來源/註解(選填)"}
```
`value` 放醒目數字,`label` 放說明。這是簡報最吸睛的一頁,盡量用真實數據。

### image_full — 單張大圖(架構圖、流程圖、完整截圖)
```json
{"type":"image_full","title":"系統架構","image":"_assets/x.png","caption":"圖說"}
```

### image_grid — 多圖網格(2 張並排 / 4 張 2×2 / 6 張 2×3)
```json
{"type":"image_grid","title":"實際畫面","subtitle":"Demo Screenshots",
 "images":[{"path":"_assets/a.png","caption":"儀表板"},{"path":"_assets/b.png","caption":"報告"}]}
```

### roadmap — 時間軸藍圖
```json
{"type":"roadmap","title":"6-12 個月藍圖","phases":[
  {"period":"Q1","items":["...","..."]},
  {"period":"Q2","items":["..."]}
]}
```

### closing — 結尾頁(不編頁碼)
```json
{"type":"closing","title":"Thank You","subtitle":"..."}
```

### quote — 金句頁(故事轉折 / 核心主張)
```json
{"type":"quote","accent":"blue","text":"客戶要的不是更多零散工具,而是一條走得通的導入路徑。","attribution":"某客戶訪談,2026"}
```
用於情緒轉折或點出核心主張。`text` 放一句有力的話,`attribution` 選填出處。

### hero_image — 滿版主圖頁(畫面感強)
```json
{"type":"hero_image","accent":"green","kicker":"Solution","title":"...","text":"一句短說明","image":"_assets/photo.jpg"}
```
左側色塊面板放標題,右側大圖**裁切填滿**。**只用真實照片 / 主視覺**;架構圖、細節圖表請改用 `image_full`(會被裁到)。

### big_number — 單一巨大數據頁(最有力的一個證據)
```json
{"type":"big_number","accent":"pink","value":"70%","label":"提案準備時間縮短","context":"由一週壓縮到數小時(試點觀察值)"}
```
把最有說服力的一個數字放大到滿版。`value` 醒目數字、`label` 說明、`context` 補充(附來源更佳)。

### process — 流程步驟頁(工作流程 / 導入路徑)
```json
{"type":"process","accent":"green","title":"導入四步驟","subtitle":"Adoption Path","steps":[
  {"title":"錄製","text":"擷取真實場景資料"},
  {"title":"訓練","text":"生成專屬模型"},
  {"title":"模擬","text":"Isaac Sim 驗證"},
  {"title":"推論","text":"實機部署"}
]}
```
水平 3–5 個步驟卡 + 箭頭,取代死板條列。`steps` 可為字串或 `{title,text}`。

### sources — 市場洞察來源頁(引用連結)
```json
{"type":"sources","title":"市場洞察來源","sources":[
  {"title":"NVIDIA Isaac Sim 官方文件","url":"https://developer.nvidia.com/isaac/sim"},
  {"title":"產業趨勢報告","url":"https://example.com/report"}
]}
```
放在倒數第二頁,列出外部研究引用。對應「引用外部資源附連結」的要求。

## 執行

```bash
python3 scripts/deck_builder.py \
  --spec /path/deck.spec.json \
  --template <此 skill>/references/template.pptx \
  --assets-root /home/node/.openclaw/workspace/project-insights \
  --out /home/node/.openclaw/workspace/project-insights/pptx-<slug>/<timestamp>.pptx
```

成功時 stdout 會印出 `{"ok": true, "slide_count": N, "missing_images": []}`。
若 `missing_images` 非空,表示你引用了不存在的圖,請修正 spec 後重跑。
