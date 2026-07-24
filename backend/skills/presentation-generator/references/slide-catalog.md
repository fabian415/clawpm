# Slide Catalog — 頁型選用指南與模板對照

參考模板 `AI_Agent_Innovation_Contest_2026_Template.pptx` 的 9 頁骨架,對應到本 skill
的頁型如下。你不必照抄 9 頁,而是依使用者要求的頁數與角度,從這些頁型中選配。

| 模板原頁 | 用途 | 建議頁型 |
|---|---|---|
| 1 封面 | Project Title / Domain / Team / Date | `cover` |
| 2 目錄 | Agenda / TOC | `toc` |
| 3+9 Executive Summary | 專案總覽:Data Input→AI Agent→Delivery→Resources→AI Platform | `summary` |
| 4 架構圖(含多圖) | Data Input / AI Agents / Delivery 架構 | `image_full` 或 `image_grid`(用真架構圖) |
| 5 分隔頁 | 章節導引 | `section` |
| 6 Business Scenario & Pain Point | User Role / Current Workflow / Pain Points / KPI Gap | `bullets` 或 `two_column` |
| 7 DEMO | Demo / 成果截圖 | `section` + `image_grid` |
| 8 Feasibility & Scaling | Deployment / Risk / Roadmap | `bullets` + `roadmap` |
| — 量化效益 | ROI、轉換率、節省工時 | `stats`(最吸睛,務必用真數據) |

## 一份 12 頁的建議編排(範例)

1. `cover` — 封面
2. `toc` — 目錄
3. `summary` — Executive Summary
4. `section` — 「商業場景與痛點」分隔
5. `bullets` — 痛點(配一張現況圖)
6. `two_column` — Before / After 對照
7. `section` — 「解決方案與架構」分隔
8. `image_full` — 系統架構圖(真圖)
9. `stats` — 量化效益
10. `image_grid` — Demo 實際畫面(多張真截圖)
11. `roadmap` — 落地與擴展藍圖
12. `closing` — Thank You

## 「生動活潑、吸引觀眾」的做法

- **多用圖**:痛點、Demo、架構、成果盡量配 `_assets` 真圖;文字頁與圖片頁交錯,避免整份都是條列。
- **善用 stats**:把散在文件裡的數字(轉換率、時間、金額、比例)抽出來做成大字卡。
- **accent 輪替**:章節與卡片用不同 accent 色(green/blue/gold/pink),讓節奏活潑但仍統一。
- **標題精煉**:標題用短句或提問,細節放副標與內文;每頁一個核心訊息。
- **少即是多**:每頁 bullets ≤ 5 條,每條先粗體 heading 再一句說明。

## 絕對不要

- ❌ 引用不存在的圖片檔名(deck_builder 會報錯)。
- ❌ 虛構數據或成果;數字要能追溯到 `{slug}.md` / `record-*` / `supplements-*`。
- ❌ 把整段長文貼進一頁;請拆解、摘要、重點化。
