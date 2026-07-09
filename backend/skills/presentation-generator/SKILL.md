---
name: presentation-generator
description: 以「先市場研究、再反問使用者、再確認故事大綱、最後才生成」的互動流程,把一個專案的知識庫（{slug}.md、record-{slug}/、supplements-{slug}/、以及既有的 swot-{slug}/、market-{slug}/、tech-{slug}/ 分析報告最新版、與 _assets 圖片）做成一份有故事性、套用 ADVANTECH 模板風格的 PowerPoint 簡報（.pptx）。分三個模式:discovery（完整讀取專案含既有 SWOT/市場/技術分析報告、再做深入市場/技術研究並動態產出要反問使用者的關鍵問題）、outline（依研究與使用者回答，先寫出完整目的再設計故事大綱，自我檢視是否為一篇完整的故事，交給使用者確認或依回饋重新設計）、build（大綱經使用者確認後，才產出 deck spec 並渲染成 pptx）。由後端 /api/presentation/plan/start（discovery）、/api/presentation/outline/start（outline）、/api/presentation/generate（build）分別觸發。
---

# Presentation Generator（互動・故事化・市場洞察版）

## Overview
這個 skill 不是「拿一句 prompt 就直接生成」,也不是「問完問題就直接生成」。它分三個模式,
由後端分別觸發,**中間有一個使用者必須確認的關卡:故事大綱**。

- **discovery（探索）**:讀專案（含既有的 `swot-{slug}/`、`market-{slug}/`、`tech-{slug}/` 分析報告最新版,重複利用其中已驗證的洞察與來源,不重做一次)→ 上網補做**深入市場/技術研究**(附來源連結)→ 依這個專案的實際狀況,**動態產出 3–5 個要反問使用者的關鍵問題**→ 寫進 `*.discovery.json`。
- **outline（故事大綱,必經關卡）**:拿到使用者的回答與視覺風格後,**先把整份簡報與每一頁的「完整目的」寫清楚**,再據此設計逐頁故事大綱;自我檢視這是不是一篇完整、連貫、打動人心的故事;寫進 `*.outline.json`。前端會把這份大綱以可讀的方式呈現給使用者——使用者可以「確認,開始製作」,也可以「給回饋、要求重新設計故事線」(這時你會被再次呼叫,帶著使用者的回饋重做 outline)。**這個模式不產生 pptx。**
- **build（生成,只在大綱被使用者確認後才會被觸發）**:讀取已核准的 outline.json,語意配對圖片、決定版面組合,產出 deck spec 並渲染成 pptx。

核心鐵則(每次都要遵守):
1. **先寫目的,再設計內容**。整份簡報的 `deck_purpose`、每一頁的 `purpose`,都要在動筆寫內容前先想清楚、寫下來。沒有目的的頁面就是流水帳,不准出現。細節見 `references/outline-schema.md` 與 `references/storytelling.md` 第 0 節。
2. **故事性優先,且要能通過自我檢視**。用一條清楚的故事線串全場:鉤子 → 痛點 → 洞察 → 解法 → 佐證 → 效益 → 行動。頁與頁之間要有因果銜接,不是各自獨立的資訊塊。
3. **大綱必須先給使用者確認,不可跳過**。outline 模式做完就停,等使用者核准或給回饋;只有 build 模式被明確觸發時才產生 pptx。
4. **圖片要語意到位,不可硬塞**。先讀懂每張 `_assets` 圖在講什麼,只在圖片真正支撐該頁訊息時才放,並在圖說寫清楚「這張圖說明什麼」。配不上就不要放,寧缺勿濫。
5. **外部論點一律附來源連結**。市場數字、競品、趨勢都要有 URL,並在倒數第二頁放「市場洞察來源」。
6. **每次版面都要不同,但不脫離模板風格**。用不同的版面變體、頁型組合與故事切法,讓兩份簡報不會長得一樣;封面固定沿用模板原始封面結構(見下方「封面」說明),不要另外設計封面樣式。
7. **不要自己手寫 python-pptx**,只產出 JSON deck spec,交給 `scripts/deck_builder.py` 渲染。
8. 所有數字、成果、引述都要能追溯到專案檔或外部來源,不得虛構。**不要在簡報任何地方放賽事/活動名稱字樣**(例如比賽名稱),頁尾留空即可。

先讀 `references/deck-spec-schema.md`(所有頁型與欄位)、`references/storytelling.md`(故事線與版面變化,含「先寫目的」原則)、`references/discovery-schema.md`、`references/outline-schema.md`。

---

## Mode A — discovery（研究 + 產生問題）

後端會給你:專案 slug/名稱、知識庫各路徑、`_assets` 路徑、以及 discovery.json 的輸出路徑。

### A1. 完整讀取專案
讀 `{slug}.md`、`record-{slug}/` 下所有 `.md`、`supplements-{slug}/` 下所有 `.md`。抓出:專案在做什麼、目前進度與成熟度、已有的數據/成果、目標客戶線索、技術選型。以日期最新者為現狀。

**同時讀取既有的分析報告(若存在),作為簡報素材的重要來源,不要重新做一次相同的分析**:
- `swot-{slug}/` — 用 Glob 列出其中所有 `{timestamp}.md`(如 `20260708-171521.md`),**只取檔名時間戳記最新的一份**讀取,取得已驗證過的優劣勢/機會/威脅與競品定位。
- `market-{slug}/` — 同樣只取**最新一份**,取得已整理好的市場行銷角度素材(效益量化、目標客群、定位)。
- `tech-{slug}/` — 同樣只取**最新一份**,取得已整理好的技術亮點、架構、選型說明。

這幾份報告通常已附「外部依據」或「外部 insights 來源：<標題> — <URL>」標記——**這些既有來源可以直接沿用**到 discovery.json 的 `research_brief` / `market`,不需要重新查證一次;但若報告中的數字沒有附來源,就不要當成有依據的外部研究引用。若某資料夾不存在或是空的,略過即可,不算資料缺失。

### A2. 建立圖片語意清單
用 Glob 列出 `_assets/` 實際存在的圖片(png/jpg/gif),並掃描 markdown 中對這些圖的引用與上下文(含 A1 讀到的 swot/market/tech 報告),對每張可用圖記錄:`{ file, desc(這張圖在講什麼), topic(屬於哪個主題) }`。看不懂或無上下文的圖不要列入。

### A3. 深入市場 / 技術研究(附來源)
先確認 A1 讀到的 swot/market/tech 報告是否已涵蓋以下面向;**缺的部分**再用 web 搜尋做**深入**研究補齊(競品、市場規模、趨勢、關鍵技術),逐條記錄來源標題與 URL。至少涵蓋:
- 市場規模 / 成長動能(附數字來源)
- 2–4 個主要競品或替代方案(附官方連結)與差異化
- 產業趨勢 / 技術方向
- 與本專案相關的關鍵技術背景
資料不足就標「資料有限」,不要用推測填。

### A4. 依專案動態產生關鍵問題
根據 A1–A3 的理解,**針對這個專案量身**設計 3–5 個要反問使用者的問題,用來決定簡報的方向。問題要具體,選項要貼合這個專案。每題 type 為:
- `single`:單選,附 2–4 個 `options`(每個 `{label, value}`)。
- `multi`:多選,附 options。
- `open`:開放填答,附 `placeholder`。
至少涵蓋:主要**受眾**、簡報**目標/最想讓觀眾記住的一句話**、要**強調的重點**、**篇幅**。(視覺風格改由前端直接讓使用者選,不需在此設計問題。)

### A5. 輸出 discovery.json
依 `references/discovery-schema.md` 寫出完整 JSON 到後端指定路徑,包含 `research_brief`、`market`、`image_inventory`、`questions`。**這是本模式唯一產出**,不要生成 pptx、不要寫大綱。

---

## Mode B — outline（故事大綱,必經的使用者確認關卡）

後端會給你:discovery.json 路徑、**使用者對每題的回答**、使用者選的**視覺風格**、
outline.json 的輸出路徑。**若這是重新設計**(使用者給了回饋),後端也會給你上一版 outline.json
路徑與使用者的回饋文字。

### B1. 消化研究、回答與回饋
讀 discovery.json,對照使用者回答,定出受眾、核心訊息、要強調的重點、篇幅(頁數)。
若是重新設計,先讀上一版 outline.json 與使用者回饋,搞清楚上一版**具體哪裡不夠打動人心**
(太像流水帳?訊息不聚焦?開場沒有鉤子?結尾沒有記憶點?)。

### B2. 先寫整份簡報的完整目的
在設計任何一頁之前,先寫 `deck_purpose`:對誰、要改變什麼認知或促成什麼行動、為什麼是
現在。這句話要具體到能指導後面每一頁的取捨——如果一頁的內容對這個目的沒有貢獻,那頁
就不該存在。

### B3. 逐頁設計:先寫目的,再寫這頁要講什麼
依 `references/storytelling.md` 的故事線(鉤子→痛點→洞察→解法→佐證→效益→行動→來源),
對**每一頁**依序:
1. 先寫 `purpose`(完整句子,回答:為何存在/在故事線裡做什麼工作/接住什麼帶出什麼)。
2. 目的想清楚了,才寫這頁的 `one_liner`(這頁要傳達的一句話訊息)與建議頁型 `type`。

**封面固定用 `cover`,目的固定是「在數秒內建立這份簡報的位階與野心,承接無、帶出第一個
故事鉤子」,不需重新設計封面本身的呈現方式(deck_builder 會忠實重現模板原始封面)。**

### B4. 自我檢視:這是不是一篇完整的故事?
逐頁讀一遍自己寫的大綱,誠實回答並寫進 `self_check`:
- 是否有清楚的鉤子、轉折洞察、與結尾的記憶點/行動呼籲?
- 頁與頁之間 `connects_from` / `connects_to` 是否真的成立,還是勉強接上?
- 有沒有拿掉也不影響理解的頁面(流水帳訊號)?有就刪除或合併。
- 條列頁佔比是否過高?過高就把部分內容換成 `quote`/`big_number`/`process` 等頁型。
不通過就回 B3 修正,直到 `self_check` 誠實填 true 為止。

### B5. 輸出 outline.json
依 `references/outline-schema.md` 寫出完整 JSON 到指定路徑。**這是本模式唯一產出,
不要寫 deck spec、不要呼叫 deck_builder、不要產生 pptx。** 完成後回報:deck_purpose、
核心訊息、逐頁大綱摘要(一頁一句話 + 目的一句話)、self_check 結果。使用者會在畫面上
看到這份大綱並決定確認或要求重新設計。

---

## Mode C — build（依已核准的大綱生成 pptx)

只有在使用者已經**確認**大綱後,後端才會觸發這個模式。後端會給你:discovery.json 路徑、
**已核准的 outline.json 路徑**、視覺風格、版面變化種子(layoutSeed)、spec/pptx/preview 輸出路徑。

### C1. 讀取已核准大綱
讀 outline.json,逐頁取用 `purpose` 與 `one_liner`——這是你寫 spec 內容的依據,**不要偏離
已核准的目的重新發揮**;若某頁要更具體的文字/數據/圖片,依 purpose 的方向去 discovery.json
與專案原始檔案裡找,不要換掉這頁本來要做的工作。

### C2. 語意配對圖片
把 discovery.json 的 image_inventory 對應到 outline 各頁:哪一頁該放哪張圖、為什麼、圖說
怎麼寫。流程/架構/示意圖 → `image_full`;真實照片/主視覺 → `hero_image`(裁切填滿);多張
成果 → `image_grid`。**配不上語意的圖一律不放。**

### C3. 決定版面組合(每次不同)
- 設 `meta.style` 為使用者選的風格值(professional/vivid/minimal/warm)。
- 設 `meta.layoutSeed` 為後端給的值。
- 主動變換版面變體(見 `references/deck-spec-schema.md`「版面變體」):bullets 的
  `variant: list/cards` 與 `imageSide`、stats 的 `variant: row/grid`、two_column 的
  `variant: panels/divider`。多數頁不要設 `accent`(留空吃 style 主色)。
- **封面一律用 `cover` 類型,只給 `title`/`domain`/`team`/`date`,不要加 variant 或任何賽事字樣**
  (deck_builder 固定用模板原始封面呈現)。

### C4. 寫 deck spec
依 `references/deck-spec-schema.md`,把 outline 的每一頁轉成對應的 spec 頁面:
- `pages[i].purpose` 決定這頁該用什麼頁型與強調什麼;`one_liner` 是標題或核心句的基礎。
- 內文引用外部數字時,句末附「（來源：<標題> — <URL>）」。
- 每頁一個核心訊息,標題精煉;bullets 2–4 點,先粗體 heading 再一句說明——不要為了填滿
  版面硬湊點數。
- 圖片欄位一律 `_assets/檔名`,且必須是 image_inventory 裡真實存在的。
- 倒數第二頁放 `sources`(引用來源);最後一頁 `closing`。

### C5. 渲染
```bash
python3 <skill>/scripts/deck_builder.py \
  --spec <輸出>/<ts>.spec.json \
  --template <skill>/references/template.pptx \
  --assets-root /home/node/.openclaw/workspace/project-insights \
  --out <輸出>/<ts>.pptx
```
檢查 stdout:`missing_images` 非空 → 換成真實存在的圖或該頁改純文字,重跑。

### C6. 預覽
```bash
python3 <skill>/scripts/render_preview.py --pptx <輸出>/<ts>.pptx --out-dir <輸出>/<ts>/
```

### C7. 回報
回報:pptx 路徑與頁數、逐頁如何對應到已核准大綱的目的、實際用了哪些 `_assets` 圖(用在
哪頁、為何)、引用了哪些外部來源、這次採用的版面/配色變化。

---

## 注意事項
- 中文自動套微軟正黑體;版面、配色、圖片縮放、模板風格、頁碼隱藏都由 deck_builder 處理。
- 不要修改 `references/template.pptx`。
- 若某資訊無外部佐證,誠實標「資料有限」,不要編造連結或數字。
- **絕不可跳過 Mode B 直接做 Mode C**;即使使用者的問題回答看起來很明確,也要先產出大綱
  讓使用者確認。

## References
- `references/discovery-schema.md` — discovery.json(研究摘要、圖片清單、動態問題)格式。
- `references/outline-schema.md` — outline.json(先寫目的、逐頁大綱、自我檢視)格式,Mode B 核心。
- `references/deck-spec-schema.md` — 所有頁型與欄位、封面規則、版面變體。
- `references/storytelling.md` — 「先寫目的」原則、故事線結構、避免流水帳、版面變化、圖片語意配對。
- `references/slide-catalog.md` — 頁型選用與模板對照。
- `references/template.pptx` — ADVANTECH 參考模板(只讀)。
- `scripts/deck_builder.py` / `scripts/render_preview.py` — 渲染與預覽。
