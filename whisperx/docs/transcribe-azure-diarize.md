# 技術文件：transcribe_azure_diarize.py

> Azure MAI-Transcribe 逐字稿 + pyannote 語者分離（實驗性整合腳本）
> 檔案位置：[whisperx/scripts/transcribe_azure_diarize.py](../scripts/transcribe_azure_diarize.py)

---

## 目錄

1. [背景與動機](#1-背景與動機)
2. [核心問題與解法](#2-核心問題與解法)
3. [整體流程](#3-整體流程)
4. [模組相依關係](#4-模組相依關係)
5. [關鍵函式說明](#5-關鍵函式說明)
6. [長音訊記憶體策略](#6-長音訊記憶體策略)
7. [輸出格式](#7-輸出格式)
8. [安裝與環境需求](#8-安裝與環境需求)
9. [使用方式](#9-使用方式)
10. [CLI 參數](#10-cli-參數)
11. [已知限制與風險](#11-已知限制與風險)
12. [除錯提示](#12-除錯提示)

---

## 1. 背景與動機

專案中已有兩支獨立腳本：

| 腳本 | 轉錄引擎 | 語者分離 | 逐字時間戳 |
|------|---------|---------|-----------|
| `transcribe_azure.py` | Azure MAI-Transcribe | ❌ 官方不支援 | ❌ 只有 phrase 級（常整段僅 1 個 phrase） |
| `transcribe_diarize.py` | WhisperX（faster-whisper） | ✅ pyannote | ✅ `whisperx.assign_word_speakers` 逐字指派 |

當使用者想要「Azure 的轉錄文字品質」+「語者分離」時，兩者都無法直接滿足：
Azure 文字品質好但沒有可用的時間戳可做語者指派；WhisperX 有時間戳但轉錄引擎換成 faster-whisper，文字風格與 Azure 不同。

`transcribe_azure_diarize.py` 是針對此需求的**實驗性橋接方案**：保留 Azure 的轉錄文字，另外用 wav2vec2 強制對齊「重建」出可靠的時間戳，再套用既有的 pyannote 語者分離流程。

## 2. 核心問題與解法

| 問題 | 解法 |
|------|------|
| Azure 回傳的 phrase 時間戳不可靠（長音訊常整段一個 phrase） | 捨棄 Azure 時間戳，只留文字（依換行拆句） |
| 沒有時間戳就無法用 `whisperx.assign_word_speakers`（逐字級） | 改用 wav2vec2 CTC 模型 + `ctc-segmentation` 套件做強制對齊（forced alignment），對已知文字重建每句話的起訖時間 |
| 長音訊（30–60 分鐘以上）wav2vec2 推論記憶體/attention 開銷過大 | 用 `ctc_segmentation.get_partitions` 把音訊切成多個 chunk 分別推論，再用 `delete_overlap_list` 拼接 log 機率序列 |
| 逐字級語者指派需要 word-level 時間戳，這裡只有句子級時間戳 | 改用「句子級」時間重疊比對：句子與語者區段重疊時間最長者勝出，概念上是 `whisperx.assign_word_speakers` 的句子級簡化版 |

## 3. 整體流程

```
                 ┌─────────────────────────┐
                 │ Step 1: Azure 轉錄        │
                 │ call_azure_transcribe()  │──▶ 逐字稿文字（捨棄時間戳）
                 └─────────────────────────┘
                             │
                             ▼
                 ┌─────────────────────────┐
                 │ Step 2: 強制對齊          │
                 │ align_sentences_chunked()│──▶ [(start, end, conf, text), ...]
                 │ （wav2vec2 + ctc-seg）    │
                 └─────────────────────────┘
                             │
                 ┌─────────────────────────┐
                 │ Step 3: 語者分離          │
                 │ run_diarization()        │──▶ diarize_segments（pyannote）
                 │ （沿用 transcribe_diarize）│
                 └─────────────────────────┘
                             │
                             ▼
                 ┌─────────────────────────┐
                 │ Step 4: 時間重疊指派語者   │
                 │ assign_speakers_to_      │──▶ [(speaker, start, end, text), ...]
                 │ sentences()              │
                 └─────────────────────────┘
                             │
                             ▼
                 build_transcript_md() ──▶ <basename>_逐字稿.md
```

四個 Step 各自獨立計時（`_StepTimer`，由 `ENABLE_TIMING=1` 環境變數開啟），對應 [transcribe_azure_diarize.py:474-533](../scripts/transcribe_azure_diarize.py#L474-L533)。

## 4. 模組相依關係

腳本本身不重複實作 Azure 呼叫或語者分離邏輯，而是直接 import 既有兩支腳本的函式（[transcribe_azure_diarize.py:59-72](../scripts/transcribe_azure_diarize.py#L59-L72)）：

**來自 `transcribe_azure.py`：**
- `API_VERSION`、`build_definition`、`call_azure_transcribe`、`make_s2t_converter`、`parse_terms`

**來自 `transcribe_diarize.py`：**
- `_StepTimer`、`TIMING_ENABLED`、`format_timestamp`、`get_device`、`normalize_speaker_labels`

這代表：Azure API 的重試/逾時邏輯、簡轉繁邏輯、裝置偵測、語者標籤正規化（含聲紋比對命名）等行為，三支腳本完全共用同一套實作，維護時只需改一處。

## 5. 關鍵函式說明

### `extract_sentences(azure_result) -> list`
[transcribe_azure_diarize.py:85-104](../scripts/transcribe_azure_diarize.py#L85-L104)

從 Azure 回應中只取文字、不取時間戳：優先讀 `phrases[]`，依換行拆成一句一行；若沒有 `phrases` 則退回讀 `combinedPhrases[]`。

### `load_ctc_model(language, device)`
[transcribe_azure_diarize.py:107-120](../scripts/transcribe_azure_diarize.py#L107-L120)

載入 `Wav2Vec2ForCTC` + `Wav2Vec2Processor`。模型 ID 對照表 `ALIGN_MODELS`（[transcribe_azure_diarize.py:76-79](../scripts/transcribe_azure_diarize.py#L76-L79)）刻意與 WhisperX `alignment.py` 的 `DEFAULT_ALIGN_MODELS_HF` 保持一致，目前僅支援 `zh`、`en`。新增語言需在此字典補上對應的 wav2vec2 CTC 模型。

### `compute_logprobs_chunked(audio, model, processor, device, max_len_s=20.0, overlap_frames=4)`
[transcribe_azure_diarize.py:123-177](../scripts/transcribe_azure_diarize.py#L123-L177)

對一段音訊做 wav2vec2 推論，回傳 log 機率矩陣（frames × vocab）。用 `ctc_segmentation.get_partitions` 依 `max_len_s` 切成多個 chunk 分別推論，再依 `delete_overlap_list` 刪除重疊 frame 後 `np.concatenate` 成一條完整序列。內建一組診斷輸出：若拼接後影格數遠低於理論值（`samples / 320`），會逐一列出每個 partition 的輸入樣本數與實際輸出影格數，方便定位是哪一段音訊讓 wav2vec2 輸出異常。

### `align_sentences(sentences, lpz, processor) -> list`
[transcribe_azure_diarize.py:180-211](../scripts/transcribe_azure_diarize.py#L180-L211)

呼叫 `ctc_segmentation` 套件，用已知文字對 log 機率序列做強制對齊，回傳每句的 `(start_s, end_s, confidence, text)`。因套件已知邊界 bug（`determine_utterance_segments` 存取 `timings[index+1]` 可能越界），此函式會把 `utt_begin_indices` clamp 到 `len(timings)-2`。

### `_even_distribute(sentences, duration_s) -> list`
[transcribe_azure_diarize.py:214-230](../scripts/transcribe_azure_diarize.py#L214-L230)

對齊失敗時的退路：依每句字數比例，把整批句子平均分配在該段音訊時長內，`confidence` 固定為 `0.0` 標示為估計值（非真實對齊結果）。

### `align_sentences_chunked(sentences, audio, model, processor, device, batch_size=80, padding_seconds=45.0, max_chunk_seconds=20.0) -> list`
[transcribe_azure_diarize.py:233-326](../scripts/transcribe_azure_diarize.py#L233-L326)

真正對外呼叫的對齊入口，見 [第 6 節](#6-長音訊記憶體策略)。

### `run_diarization(audio_path, audio, device, num_speakers=None, speaker_dir=None)`
[transcribe_azure_diarize.py:329-365](../scripts/transcribe_azure_diarize.py#L329-L365)

直接沿用 `transcribe_diarize.py` 的做法：用 `whisperx.diarize.DiarizationPipeline`（需 `HF_TOKEN`）跑語者分離；若提供 `speaker_dir`，額外呼叫 `speaker_db.match_diarized_speakers` 做聲紋比對，取得 `{SPEAKER_00: "Alice"}` 之類的姓名對應（比對失敗不中斷流程，僅印警告）。

### `assign_speakers_to_sentences(aligned_sentences, diarize_segments) -> list`
[transcribe_azure_diarize.py:368-390](../scripts/transcribe_azure_diarize.py#L368-L390)

句子級版本的 `whisperx.assign_word_speakers`：對每句話，找出與 pyannote 語者區段重疊時間最長者作為該句語者；若完全無重疊（強制對齊誤差或語者分離漏段），退而求其次，改用「句子中點」離哪個語者區段最近來決定。

### `build_transcript_md(...)`
[transcribe_azure_diarize.py:393-430](../scripts/transcribe_azure_diarize.py#L393-L430)

輸出格式比照 `transcribe_diarize.py`：相鄰同語者的句子自動合併為一段，附上該段起訖時間與語者標籤。

## 6. 長音訊記憶體策略

`align_sentences_chunked` 是這支腳本相較於「直接呼叫 compute_logprobs_chunked + align_sentences」多出的一層封裝，原因記在函式 docstring（[transcribe_azure_diarize.py:238-253](../scripts/transcribe_azure_diarize.py#L238-L253)）：

- 若對「整段音訊」一次算出完整 log 機率矩陣，`wav2vec2-large-xlsr-53-chinese` 詞彙表高達 3503 個 token，3 小時會議（≈540,000 frames）光矩陣就要 7.5GB+，實測曾在 15GB RAM 主機把單一 process 撐到 11.3GB 而被 OOM killer 砍掉。
- 解法：**不對整段音訊算 logprobs**，而是先依「字數比例」粗估每一批句子（預設 `--align-batch-sentences 80` 句）對應的原始音訊時間範圍，只切「音訊樣本」（非切 logprobs），每批各自跑 `compute_logprobs_chunked` + `align_sentences` 後立即釋放（`del` + `gc.collect()` + `torch.cuda.empty_cache()`）。
- 每批音訊切片前後各加 `--align-padding-seconds`（預設 45 秒）緩衝，避免句子邊界剛好落在切片邊緣導致對齊失真。
- 單一批次對齊失敗（例如 `ctc_segmentation` 回溯失敗）不會中斷整個任務，改用 `_even_distribute` 平均分配時間戳讓流程跑完，並印出警告。

三層 chunk 概念容易混淆，整理如下：

| 層級 | 對應參數 | 目的 |
|------|---------|------|
| 對齊批次（sentence batch） | `--align-batch-sentences`（預設 80 句） | 避免整段音訊的 logprobs 矩陣同時存在記憶體中 |
| 每批次的音訊緩衝 | `--align-padding-seconds`（預設 45 秒） | 避免句子被切在音訊邊界上 |
| wav2vec2 推論 chunk | `--max-chunk-seconds`（預設 20 秒） | 避開 transformer attention 對長序列的記憶體問題（`compute_logprobs_chunked` 內部） |

## 7. 輸出格式

```
<output_dir>/<basename>/<basename>_逐字稿.md
```

範例：

```markdown
# 逐字稿 - meeting-2026-03-11

**語言:** zh
**總時長:** 01:00:00
**語者人數:** 3
**轉錄引擎:** Azure MAI-Transcribe + pyannote 語者分離（時間戳為 wav2vec2 強制對齊重建，僅供參考）

---

**[00:00:05 → 00:00:32] Speaker 1:**
大家好，今天我們來討論第一季的業績報告。
```

與 `transcribe_diarize.py` 輸出格式一致，差異只在標頭多一行「轉錄引擎」註記，明確告知時間戳來源是重建值。

## 8. 安裝與環境需求

在既有 `transcribe_azure.py` / `transcribe_diarize.py` 依賴之外，額外需要：

```bash
pip install ctc-segmentation transformers --break-system-packages
```

環境變數（與既有腳本共用）：

| 變數 | 用途 |
|------|------|
| `AZURE_SPEECH_ENDPOINT` / `AZURE_SPEECH_KEY` | Azure 轉錄（同 `transcribe_azure.py`） |
| `HF_TOKEN` | pyannote 語者分離（同 `transcribe_diarize.py`），需接受 `pyannote/speaker-diarization-community-1` 使用條款 |
| `ENABLE_TIMING` | 設 `1`/`true`/`yes` 開啟各 Step 計時輸出 |

## 9. 使用方式

```bash
# 基本用法
python3 transcribe_azure_diarize.py meeting.mp3 --output-dir ./out --lang zh

# 指定語者人數 + 逐字風格
python3 transcribe_azure_diarize.py meeting.mp3 --num-speakers 3 --style verbatim

# 帶入聲紋庫（自動比對真實姓名，用法同 transcribe_diarize.py）
python3 transcribe_azure_diarize.py meeting.mp3 --speaker-dir ./speaker_profiles/engineering

# 長會議：調整批次大小以控制記憶體峰值
python3 transcribe_azure_diarize.py long_meeting.wav \
  --align-batch-sentences 40 --align-padding-seconds 60 --max-chunk-seconds 15
```

## 10. CLI 參數

| 參數 | 型別/預設 | 說明 |
|------|----------|------|
| `audio_file` | 必填 | 音訊檔路徑（wav / mp3 / flac） |
| `--output-dir` | `.` | 輸出根目錄 |
| `--lang` | `zh` | 語言代碼，需在 `ALIGN_MODELS` 中有對應對齊模型 |
| `--model` | `mai-transcribe-1.5` | `mai-transcribe-1.5` / `mai-transcribe-1` |
| `--style` | `default` | `default` / `verbatim`（同 `transcribe_azure.py`） |
| `--terms` | 無 | 專有名詞，逗點分隔（phraseList 偏誤） |
| `--num-speakers` | 無（自動偵測） | 指定語者人數 |
| `--speaker-dir` | 無 | 聲紋庫資料夾（同 `transcribe_diarize.py` / `speaker_db.py` 格式） |
| `--device` | `auto` | `auto` / `cpu` / `cuda` / `mps` |
| `--no-traditional` | flag | 停用簡轉繁 |
| `--endpoint` / `--key` | 無 | 覆蓋 `AZURE_SPEECH_ENDPOINT` / `AZURE_SPEECH_KEY` |
| `--max-chunk-seconds` | `20.0` | wav2vec2 單次推論 chunk 長度上限 |
| `--align-batch-sentences` | `80` | 每批對齊的句子數上限（越小越省記憶體，呼叫次數越多） |
| `--align-padding-seconds` | `45.0` | 每批對齊時，音訊切片前後緩衝秒數 |

## 11. 已知限制與風險

腳本開頭的 docstring 已明確標註「實驗性質」，重點摘錄：

- **對齊品質取決於 wav2vec2 中文模型的字元辨識能力**，在雜訊多、口音重的會議錄音上可能不準；一旦對齊偏移，語者指派也會跟著錯。
- **語者指派是句子級，不是逐字級**：整句話只會被指派給單一語者，若一句話中間換人說話（少見但可能發生於被打斷的對話）無法反映。
- **未在真實會議錄音上完整驗證**：使用前務必先用小段音檔測試，人工抽查重建時間戳與語者指派的準確度。
- **對齊失敗會靜默降級**：`_even_distribute` 退路只保證流程跑完、不代表時間戳準確，僅在 stderr 印警告，須留意 log 是否出現「強制對齊失敗」字樣。
- **MAI-Transcribe 本身限制沿用**：音檔需 < 300MB，僅支援 wav/mp3/flac，`phraseList`/`verbatim` 僅 `mai-transcribe-1.5` 支援（見 [transcribe_azure.py](../scripts/transcribe_azure.py)）。

## 12. 除錯提示

- **懷疑對齊品質差**：加上 `ENABLE_TIMING=1` 觀察各 Step 耗時是否合理；並檢查輸出逐字稿中時間戳是否單調遞增、有無大段時間集中在同一句（可能代表對齊在某段崩掉）。
- **`lpz 拼接後僅 X 影格，遠少於理論值` 診斷訊息**（[compute_logprobs_chunked](../scripts/transcribe_azure_diarize.py#L157-L176)）：代表某個 partition 的 wav2vec2 輸出影格數遠低於預期，會列出每個 partition 明細，可用來定位是哪一段音訊有問題（例如靜音段、雜訊段）。
- **OOM / 記憶體吃緊**：調小 `--align-batch-sentences` 與 `--max-chunk-seconds`；也可觀察 `align_sentences_chunked` 是否確實在每批次後 `gc.collect()` + `torch.cuda.empty_cache()` 生效。
- **語者分離相關問題**（`HF_TOKEN` 錯誤、聲紋比對失敗等）：排查方式與 `transcribe_diarize.py` / `transcribe_api.py` 共用，可參考 [deploy-transcribe-api.md 第 12 節](./deploy-transcribe-api.md#12-常見問題排查)。
