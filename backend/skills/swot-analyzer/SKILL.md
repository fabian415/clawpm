---
name: swot-analyzer
description: 針對專案或產品執行 SWOT 分析、競品分析與產業趨勢研究，嚴格區分會議事實層與外部 insights 層，所有外部資料都必須附參考連結。適用情境：使用者要求「做 SWOT」、「分析競爭者」、「研究市場趨勢」、「補充外部洞察」、「產業定位分析」，或由 project-insight-synthesizer 觸發以補充外部 insights 並整併進專案知識庫。
---

# SWOT Analyzer

## Overview
針對指定專案或產品，以外部資料為依據執行系統性 SWOT 分析、競品掃描與產業趨勢研究。所有產出必須嚴格分層：**會議事實**不得混入**外部 insights**，每一條外部洞察都必須附上可驗證的來源連結。

若是由 `project-insight-synthesizer` 觸發，本 Skill 產出的 SWOT 區塊將整併進既有專案 Markdown；若為獨立呼叫，則輸出獨立報告。

## 輸入

| 欄位 | 必要性 | 說明 |
|------|--------|------|
| 專案名稱 / 產品名稱 | 必要 | 分析對象 |
| 會議事實摘要 | 選擇性 | 由 meeting-transcription 或 project-insight-synthesizer 傳入；作為 SWOT 的內部事實基礎 |
| 分析範疇 | 選擇性 | 指定要做哪些面向：SWOT、競品、產業趨勢、市場規模，可多選；未指定則預設執行完整 SWOT 含初步競品掃描 |
| 輸出目標 | 選擇性 | `standalone`（獨立報告）或 `merge`（整併進既有專案 Markdown） |

## Workflow

### Step 1: 確認分析範疇
依使用者需求，確認本次要執行的分析類型：
- **SWOT**：優勢、劣勢、機會、威脅四象限
- **競品分析**：主要競爭者比較、差異化定位
- **產業趨勢**：市場規模、成長動能、技術發展方向
- **完整外部洞察**：以上全部

若無特別指定，預設執行完整 SWOT（含初步競品掃描）。

### Step 2: 確認並隔離會議事實
若有傳入會議事實（逐字稿、會議記錄、專案 Markdown），先提取：
- 已知的優勢、能力、差異化論述
- 已知的風險、弱點、限制
- 已知的客戶反饋、市場機會
- 已知的競爭威脅、替代方案

這些作為 SWOT 的**內部事實基礎**，標記來源日期。不可在此步驟混入外部推論。

### Step 3: 執行外部研究
對每個分析面向，使用可靠外部來源進行研究。可接受與避免的來源類型見 `references/external-insights-policy.md`。

搜尋優先順序：
1. 官方網站 / 官方技術文件
2. 競品官方產品頁與功能說明
3. 研究機構報告（Gartner、IDC、Forrester 等）
4. 正規科技 / 財經媒體
5. 開源專案 repo 與 docs

若無法找到足夠可信資料，直接標記「外部資料不足」，不以推測填補。

### Step 4: 合成 SWOT 矩陣
將會議事實與外部研究合併，但**必須區分來源層**。

每個 SWOT 項目格式：
```
- [項目描述]
  - 會議依據：來源：2026-04-15 逐字稿（若有）
  - 外部依據：外部 insights 來源：<標題> — <URL>
```

若某項目純來自外部研究，直接附外部來源。
若某項目純來自會議，附 `來源：[日期] 逐字稿/會議記錄`。

### Step 5: 整理競品分析（若適用）
- 列出主要競品或替代方案
- 比較關鍵能力維度（功能、定價、市場、技術）
- 標明差異化定位
- 每個競品描述都需附官方來源 URL

若外部資料不足，明確寫：「外部資料不足，暫不做完整競品分析，以下為現有資訊的局部觀察。」

### Step 6: 整理產業趨勢（若適用）
- 市場規模與成長率（附數字來源與日期）
- 主要技術驅動力
- 監管 / 合規趨勢
- 客戶採購行為變化

每項數字或判斷都要附來源日期與 URL。

### Step 7: 輸出報告
依 `輸出目標` 決定格式：

- `standalone`：輸出完整 Markdown 報告至 `project-insights/swot-<project-slug>.md`
- `merge`（由 project-insight-synthesizer 觸發）：回傳結構化 SWOT 區塊，由 project-insight-synthesizer 負責縫合進專案檔

## 輸出格式

### 獨立報告（standalone）
輸出至 `project-insights/swot-<project-slug>.md`：

```markdown
# <專案名稱> SWOT 分析

> 分析日期：YYYY-MM-DD
> 以下分析為外部市場洞察與會議事實交叉整理，非本次會議直接結論。

## 執行摘要
[3-5 句話概括主要洞察]

## SWOT 矩陣

### 優勢 Strengths
- [項目]
  - 外部依據：外部 insights 來源：<標題> — <URL>

### 劣勢 Weaknesses
- ...

### 機會 Opportunities
- ...

### 威脅 Threats
- ...

## 競品分析（若適用）
| 競品 | 關鍵能力 | 差異點 | 來源 |
|------|---------|--------|------|
...

## 產業趨勢（若適用）
...

## 資料可信度評估
- 外部資料完整性：高 / 中 / 低
- 主要不確定性：[列出]
- 建議追蹤的資料缺口：[列出]

## 來源索引
| # | 標題 | URL | 日期 |
|---|------|-----|------|
...
```

### 整併輸出（merge，回傳給 project-insight-synthesizer）
回傳以下結構化內容供 project-insight-synthesizer 縫合：
- `swot_block`：四象限各項目與來源
- `competitive_block`：競品比較表（若有）
- `industry_block`：產業趨勢要點（若有）
- `sources`：完整來源列表
- `confidence`：high / medium / low
- `notes`：資料缺口、高不確定性的說明

## 分層規則（Citation Rules）

### 會議事實層
- 標記格式：`來源：2026-04-15 逐字稿` 或 `來源：2026-04-15 會議記錄`
- 只能寫入逐字稿、會議記錄、使用者直接提供的文件中明確出現的資訊

### 外部 Insights 層
- 標記格式：`外部 insights 來源：<標題> — <URL>`
- 適用於：SWOT 推論、競品特徵、市場數字、產業趨勢、優劣勢判斷
- **任何不是會議原文直接提到的推論，都必須歸類為外部 insights，不可偽裝成會議結論**

### 資料不足時的處理
若無法取得足夠可信資料：
- 明確寫「外部資料不足，暫不做完整分析」
- 或只寫局部觀察，但仍附現有來源
- 不可用無來源推測填補

## 回報給使用者
完成後回報：
1. 執行了哪些分析類型（SWOT / 競品 / 產業趨勢）
2. 主要洞察（2-3 點）
3. 資料完整性評估（高 / 中 / 低）
4. 主要不確定性或資料缺口
5. 哪些內容來自會議事實，哪些來自外部研究
6. 輸出檔案位置（standalone 模式）或整併狀態（merge 模式）

## Integration with project-insight-synthesizer
若由 `project-insight-synthesizer` 觸發，遵守以下銜接方式：
1. project-insight-synthesizer 在 Step 4 判斷是否需要 SWOT / 外部 insights
2. 若需要，觸發本 Skill 並傳入：專案名稱、會議事實摘要、輸出目標 `merge`
3. 本 Skill 完成分析後回傳結構化 SWOT 區塊
4. project-insight-synthesizer 將其整併進專案 Markdown 的「外部洞察」章節，並保留來源標記

## References
### references/external-insights-policy.md
規範 SWOT、競品、產業資料與額外建議如何與會議原文分層，並要求所有外部 insights 必須附參考連結，列出可接受與應避免的外部來源類型。
