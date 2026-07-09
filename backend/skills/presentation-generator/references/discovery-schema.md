# discovery.json Schema（Mode A 產出）

discovery 模式唯一的產出。前端會用它顯示「研究摘要 + 反問使用者的問題」。
寫到後端指定的 `*.discovery.json` 路徑。

**`research_brief` / `market` 的資料來源優先順序**:先看專案既有的 `swot-{slug}/`、
`market-{slug}/`、`tech-{slug}/`(各取最新一份)裡有沒有已經整理好、附了來源標記的洞察——
有的話直接沿用那些 `point`/`source`/`url`,不要重新查證一次;只有這些既有報告沒涵蓋到
的面向,才用 web 搜尋補齊。

```json
{
  "planId": "20260709-153000",
  "project": "Robotic Suite",

  "research_brief": [
    { "point": "Physical AI / 模擬到現實(sim-to-real)導入需求上升,企業要的是可複製的 workflow 而非單一模型。",
      "source": "NVIDIA Isaac 開發者文件", "url": "https://developer.nvidia.com/isaac/sim" },
    { "point": "競品多聚焦單機示範,缺少從資料錄製到實機部署的端到端交付。",
      "source": "某產業報告", "url": "https://example.com/report" }
  ],

  "market": {
    "size": "（市場規模與成長率,附數字來源;無資料寫 '資料有限'）",
    "trends": ["趨勢 1", "趨勢 2"],
    "competitors": [
      { "name": "競品 A", "note": "定位/差異", "url": "https://..." }
    ]
  },

  "image_inventory": [
    { "file": "_assets/isaac-overview.png", "desc": "Web-based Isaac Sim 連線架構(Browser↔NVIDIA↔simulation)", "topic": "架構" },
    { "file": "_assets/robot-arm.jpg", "desc": "實機機器手臂運作照片", "topic": "Demo" }
  ],

  "questions": [
    { "id": "audience", "question": "這份簡報主要要說服誰?",
      "type": "single",
      "options": [
        { "label": "高層決策者(要 ROI 與策略)", "value": "exec" },
        { "label": "技術評審(要架構與可行性)", "value": "tech" },
        { "label": "潛在客戶(要痛點與效益)", "value": "customer" }
      ],
      "hint": "受眾決定用詞深淺與強調重點" },

    { "id": "takeaway", "question": "希望觀眾看完只記住哪一句話?",
      "type": "open", "placeholder": "例如:Robotic Suite 讓 Physical AI 從 Demo 走向可交付" },

    { "id": "emphasis", "question": "最想強調哪些面向?(可複選)",
      "type": "multi",
      "options": [
        { "label": "市場機會 / 商業效益", "value": "biz" },
        { "label": "技術架構 / 可行性", "value": "arch" },
        { "label": "實際成果 / Demo", "value": "demo" },
        { "label": "落地路線 / 擴展", "value": "scale" }
      ] },

    { "id": "tone", "question": "偏好的語氣與視覺風格?",
      "type": "single",
      "options": [
        { "label": "沉穩專業(數據導向)", "value": "pro" },
        { "label": "生動活潑(故事導向)", "value": "vivid" },
        { "label": "精煉高層(少字大重點)", "value": "exec" }
      ] },

    { "id": "length", "question": "預計頁數?",
      "type": "single",
      "options": [
        { "label": "精簡 8–10 頁", "value": "8" },
        { "label": "標準 12 頁", "value": "12" },
        { "label": "完整 14–16 頁", "value": "15" }
      ] }
  ]
}
```

## 規則
- `questions` 一律 3–5 題,**依這個專案動態設計**,選項要貼合專案(不要泛用罐頭)。至少涵蓋:受眾、核心訊息、強調重點、語氣風格、篇幅。
- `type` 只能是 `single` / `multi` / `open`。`single`/`multi` 必須附 `options`(每個含 `label`、`value`);`open` 建議附 `placeholder`。
- `research_brief` 每條都要有 `url`(找不到可信來源就不要列該條)。
- `image_inventory` 只列 `_assets/` 底下**真實存在且看得懂語意**的圖。
- 這是 discovery 模式**唯一**產出,不要在這個模式生成 pptx。
