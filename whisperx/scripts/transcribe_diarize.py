#!/usr/bin/env python3
"""
transcribe_diarize.py - 使用 WhisperX 進行語音轉錄 + 語者分離（Speaker Diarization）

功能：
    - 轉錄音訊為文字（Whisper ASR）
    - 辨識並區分不同說話者（Pyannote Diarization）
    - 輸出帶有語者標籤的逐字稿：Speaker 1, Speaker 2, ...
    - 使用 Groq API 為逐字稿補上標點符號（可選）

Usage:
    python3 transcribe_diarize.py <audio_file> [--output-dir <dir>] [--lang <language>]
    python3 transcribe_diarize.py <audio_file> [--output-dir <dir>] [--lang <language>] [--device cpu] [--num-speakers 3]

Output:
    <output_dir>/<basename>/<basename>_逐字稿.md

==============================================================
安裝步驟（首次使用）：
==============================================================
1. 安裝 ffmpeg：
       sudo apt-get install -y ffmpeg

2. 安裝 Python 套件：
       pip install whisperx groq --break-system-packages

3. 建立 Hugging Face Token（Read 權限）：
       https://huggingface.co/settings/tokens

4. 接受 pyannote 模型使用條款（必須登入 HF 帳號後點 Agree）：
       https://huggingface.co/pyannote/speaker-diarization-community-1

5. 設定環境變數：
       export HF_TOKEN=hf_xxxxxxxx
       export GROQ_API_KEY=gsk_xxxxxxxx   # 標點補強用，可選，免費申請：https://console.groq.com

注意：pyannote 使用的模型為 pyannote/speaker-diarization-community-1
（非舊版 speaker-diarization-3.1，請確認接受正確的條款頁面）
==============================================================
"""

import argparse
import gc
import os
import sys
import time
from pathlib import Path

TIMING_ENABLED = os.environ.get("ENABLE_TIMING", "0").lower() in ("1", "true", "yes")


class _StepTimer:
    """各步驟計時器；TIMING_ENABLED=False 時所有方法皆為 no-op。"""

    def __init__(self, enabled: bool):
        self._enabled = enabled
        self._times: dict = {}
        self._t: float = 0.0

    def start(self):
        if self._enabled:
            self._t = time.perf_counter()

    def record(self, name: str) -> float:
        if not self._enabled:
            return 0.0
        elapsed = time.perf_counter() - self._t
        self._times[name] = elapsed
        return elapsed

    def fmt(self, name: str) -> str:
        """回傳 '  [1.23m]' 或空字串（disabled 時）。"""
        if not self._enabled or name not in self._times:
            return ""
        return f"  [{self._times[name] / 60:.2f}m]"

    def summary(self):
        if not self._enabled or not self._times:
            return
        total = sum(self._times.values())
        print("\n========== 各步驟耗時 ==========")
        for name, elapsed in self._times.items():
            print(f"  {name}: {elapsed / 60:.2f}m  ({elapsed / total * 100:.0f}%)")
        print(f"  {'總計':12} {total / 60:.2f}m")
        print("=================================\n")


def parse_terms(terms: str = None) -> list:
    """Parse comma-separated proper nouns for a single transcription job."""
    if not terms:
        return []
    parsed = [term.strip() for term in terms.split(",") if term.strip()]
    if parsed:
        print(f"載入本次任務專有名詞：{len(parsed)} 個")
    return parsed

def get_device(preferred: str = "auto") -> str:
    """Detect best available device."""
    if preferred in ("cpu", "cuda", "mps"):
        return preferred
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"


def get_compute_type(device: str) -> str:
    """Return appropriate compute type for the device."""
    if device == "cuda":
        return "float16"
    return "int8"


def format_timestamp(seconds: float) -> str:
    """Convert seconds to HH:MM:SS format."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def normalize_speaker_labels(segments: list, name_map: dict = None) -> dict:
    """
    將 Pyannote 原始語者 ID（如 SPEAKER_00）映射為顯示名稱。

    優先順序：
      1. name_map 中有的 → 使用已註冊的 Speaker 名稱（e.g. "Alice"）
      2. 其餘 → 依首次出現順序編號（"Speaker 1", "Speaker 2", ...）

    Args:
        segments: WhisperX 輸出的 segments list，每段含 "speaker" 欄位
        name_map: 聲紋比對結果 {SPEAKER_00: "Alice"}（可選）
    """
    mapping = {}
    counter = 1
    for seg in segments:
        raw = seg.get("speaker", "UNKNOWN")
        if raw not in mapping:
            if name_map and raw in name_map:
                mapping[raw] = name_map[raw]
            else:
                mapping[raw] = f"Speaker {counter}"
                counter += 1
    return mapping


def _batch_restore_punctuation_funasr(texts: list, device: str = "cpu") -> list:
    """模型只載入一次，對所有文字做 batch 推論。"""
    import torch
    from funasr import AutoModel
    funasr_device = "cuda:0" if device == "cuda" else device
    model = AutoModel(model="ct-punc", device=funasr_device)
    results = model.generate(input=texts)
    outputs = [r["text"] if r and "text" in r else texts[i] for i, r in enumerate(results)]
    del model
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return outputs


def _batch_restore_punctuation_deepmulti(texts: list, lang: str = "zh", device: str = "cpu") -> list:
    """模型只載入一次，逐筆推論（deepmulti 不支援 batch API）。"""
    import torch
    from deepmultilingualpunctuation import PunctuationModel
    model = PunctuationModel(language=lang)
    if device != "cpu":
        torch_device = torch.device(device)
        model.pipe.model = model.pipe.model.to(torch_device)
        model.pipe.device = torch_device
    outputs = [model.restore_punctuation(t) for t in texts]
    del model
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return outputs


def batch_restore_punctuation(texts: list, lang: str = "zh", device: str = "cpu") -> list:
    """
    對所有文字做一次性標點補強（模型只載入一次）。
    回傳與輸入等長的清單。
    """
    if not texts:
        return texts

    forced = os.environ.get("PUNCT_BACKEND", "").lower()
    backends = [forced] if forced else ["funasr", "deepmulti"]

    for backend in backends:
        if backend == "none":
            return texts
        try:
            if backend == "funasr":
                return _batch_restore_punctuation_funasr(texts, device=device)
            if backend == "deepmulti":
                return _batch_restore_punctuation_deepmulti(texts, lang, device=device)
        except ImportError:
            continue
        except Exception as e:
            print(f"警告：{backend} 標點補強失敗（{e}），嘗試下一個方案。", file=sys.stderr)
            continue

    print("提示：未安裝任何標點補強套件，輸出無標點文字。", file=sys.stderr)
    print("      安裝方式：pip install funasr  或  pip install deepmultilingualpunctuation", file=sys.stderr)
    return texts


def build_transcript_md(segments: list, speaker_map: dict, audio_name: str, language: str, duration: float, add_punctuation: bool = True, device: str = "cpu") -> str:
    """產生帶語者標籤的 Markdown 逐字稿。"""

    # Phase 1: 先收集所有語者段落，不做任何推論
    groups = []  # (speaker, start, end, raw_text)
    prev_speaker = None
    buffer_text = []
    buffer_start = buffer_end = None

    for seg in segments:
        text = seg.get("text", "").strip()
        if not text:
            continue
        speaker = seg.get("speaker", "UNKNOWN")
        start = seg.get("start", 0)
        end = seg.get("end", 0)
        if speaker == prev_speaker:
            buffer_text.append(text)
            buffer_end = end
        else:
            if buffer_text and prev_speaker:
                groups.append((prev_speaker, buffer_start, buffer_end, " ".join(buffer_text)))
            prev_speaker = speaker
            buffer_text = [text]
            buffer_start = start
            buffer_end = end
    if buffer_text and prev_speaker:
        groups.append((prev_speaker, buffer_start, buffer_end, " ".join(buffer_text)))

    # Phase 2: 模型只載入一次，對所有段落做 batch 標點補強
    if add_punctuation and groups:
        raw_texts = [g[3] for g in groups]
        final_texts = batch_restore_punctuation(raw_texts, lang=language, device=device)
    else:
        final_texts = [g[3] for g in groups]

    # Phase 3: 格式化輸出
    lines = [
        f"# 逐字稿 - {audio_name}",
        "",
        f"**語言:** {language}",
        f"**總時長:** {format_timestamp(duration)}",
        f"**語者人數:** {len(speaker_map)}",
        "",
        "---",
        "",
    ]
    for (speaker, start, end, _), final_text in zip(groups, final_texts):
        label = speaker_map.get(speaker, speaker)
        lines.append(f"**[{format_timestamp(start)} → {format_timestamp(end)}] {label}:**")
        lines.append(final_text)
        lines.append("")

    return "\n".join(lines)


WHISPER_MODELS = [
    "tiny", "base", "small", "medium",
    "large-v1", "large-v2", "large-v3", "large-v3-turbo",
    "distil-large-v2", "distil-large-v3",
]
DEFAULT_MODEL = "large-v3"


def transcribe_with_diarization(
    audio_path: Path,
    language: str = "zh",
    device: str = "auto",
    num_speakers: int = None,
    speaker_dir: Path = None,
    terms: list = None,
    model_name: str = DEFAULT_MODEL
) -> tuple:
    """
    使用 WhisperX 進行轉錄 + 語者分離。
    返回 (segments, speaker_map, language, duration)
    """
    try:
        import whisperx
        import whisperx.diarize
    except ImportError:
        print("ERROR: whisperx 未安裝。請執行：pip install whisperx --break-system-packages", file=sys.stderr)
        sys.exit(1)

    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        print("ERROR: HF_TOKEN 環境變數未設定。", file=sys.stderr)
        print("       請至 https://huggingface.co/settings/tokens 申請 token", file=sys.stderr)
        print("       並接受條款：https://huggingface.co/pyannote/speaker-diarization-community-1", file=sys.stderr)
        sys.exit(1)

    resolved_device = get_device(device)
    compute_type = get_compute_type(resolved_device)

    print(f"裝置: {resolved_device}（compute_type: {compute_type}）")
    print("載入音訊...")
    audio = whisperx.load_audio(str(audio_path))
    duration = float(audio.shape[0]) / 16000
    print(f"音訊時長: {format_timestamp(duration)}")

    try:
        import torch
        _has_torch = True
    except ImportError:
        _has_torch = False

    def _free_gpu(*models):
        """刪除模型物件並清空 CUDA 快取（同時處理 CTranslate2 / PyTorch 兩種後端）。"""
        for m in models:
            try:
                # faster-whisper / CTranslate2 後端：明確卸載模型權重
                if hasattr(m, "model") and hasattr(m.model, "unload_model"):
                    m.model.unload_model()
            except Exception:
                pass
            try:
                del m
            except Exception:
                pass
        if _has_torch:
            gc.collect()
            torch.cuda.empty_cache()

    timer = _StepTimer(TIMING_ENABLED)

    # Step 1: 轉錄
    print(f"============= Step 1: 轉錄 ==================")
    print(f"載入 Whisper 模型（{model_name}）...")
    timer.start()

    term_list = terms or []
    noun_str = ", ".join(term_list)

    # initial_prompt 只保留語境句，避免 Whisper 將過長的 prompt 複誦進轉錄結果
    asr_options = {"beam_size": 10, "initial_prompt": "以下是一段中文會議錄音的逐字稿。"}
    if noun_str:
        # hotwords 負責詞彙提示（需 faster-whisper >= 1.0.2）
        asr_options["hotwords"] = noun_str

    model = whisperx.load_model(
        model_name, resolved_device, compute_type=compute_type,
        language=language if language != "auto" else None,
        asr_options=asr_options,
    )
    result = model.transcribe(audio, batch_size=8)
    detected_language = result.get("language", language)
    timer.record("Step 1 轉錄")
    print(f"轉錄完成，共 {len(result['segments'])} 段，語言：{detected_language}{timer.fmt('Step 1 轉錄')}")

    # Whisper 模型使用完畢，立即釋放（騰出空間給 align / diarize）
    _free_gpu(model)
    del model

    # Step 2: 詞對齊
    print(f"============= Step 2: 詞對齊 ==================")
    timer.start()
    try:
        print("詞對齊中...")
        model_a, metadata = whisperx.load_align_model(language_code=detected_language, device=resolved_device)
        try:
            result = whisperx.align(result["segments"], model_a, metadata, audio, resolved_device, return_char_alignments=False)
        finally:
            # 無論 align 成功或失敗都必須釋放 model_a，否則 VRAM 洩漏導致後續步驟無法上 GPU
            _free_gpu(model_a)
            del model_a
        timer.record("Step 2 詞對齊")
        print(f"詞對齊完成{timer.fmt('Step 2 詞對齊')}")
    except Exception as e:
        timer.record("Step 2 詞對齊")
        print(f"警告：詞對齊失敗（{e}），繼續...{timer.fmt('Step 2 詞對齊')}", file=sys.stderr)

    # Step 3: 語者分離
    print(f"============= Step 3: 語者分離 ==================")
    print("語者分離中...")
    timer.start()
    diarize_kwargs = {"audio": audio}
    if num_speakers:
        diarize_kwargs["num_speakers"] = num_speakers

    # pyannote 需要 torch.device 物件而非字串，明確轉換以確保 GPU 被使用
    diarize_device = torch.device(resolved_device) if _has_torch else resolved_device
    diarize_model = whisperx.diarize.DiarizationPipeline(token=hf_token, device=diarize_device)
    diarize_segments = diarize_model(**diarize_kwargs)
    _free_gpu(diarize_model)
    del diarize_model
    timer.record("Step 3 語者分離")
    print(f"語者分離完成{timer.fmt('Step 3 語者分離')}")

    # Step 4: 指派語者
    print(f"============= Step 4: 指派語者 ==================")
    timer.start()
    result = whisperx.assign_word_speakers(diarize_segments, result)
    segments = result.get("segments", [])
    timer.record("Step 4 指派語者")
    print(f"指派語者完成{timer.fmt('Step 4 指派語者')}")

    # Step 5: 聲紋比對（若有聲紋庫）
    print(f"============= Step 5: 聲紋比對 ==================")
    timer.start()
    name_map = {}
    if speaker_dir and speaker_dir.exists():
        print("聲紋比對中...")
        try:
            from speaker_db import match_diarized_speakers
            name_map = match_diarized_speakers(
                diarize_segments=diarize_segments,
                audio=audio,
                speaker_dir=speaker_dir,
                hf_token=hf_token,
                device=resolved_device,
            )
        except Exception as e:
            print(f"警告：聲紋比對失敗（{e}），使用預設 Speaker 編號。", file=sys.stderr)
    timer.record("Step 5 聲紋比對")
    print(f"聲紋比對完成{timer.fmt('Step 5 聲紋比對')}")

    speaker_map = normalize_speaker_labels(segments, name_map=name_map)
    print(f"辨識到 {len(speaker_map)} 位語者：{list(speaker_map.values())}")

    timer.summary()

    return segments, speaker_map, detected_language, duration


def main():
    parser = argparse.ArgumentParser(
        description="WhisperX 轉錄 + 語者分離，輸出帶 Speaker 標籤的 Markdown 逐字稿。"
    )
    parser.add_argument("audio_file", help="音訊檔路徑（mp3, mp4, wav, m4a 等）")
    parser.add_argument("--output-dir", default=".", help="輸出根目錄（預設：當前目錄）")
    parser.add_argument("--lang", default="zh", help="語言代碼（預設：zh；設 auto 自動偵測）")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda", "mps"],
                        help="運算裝置（預設：auto 自動選擇）")
    parser.add_argument("--num-speakers", type=int, default=None,
                        help="指定語者人數（選填；不指定則自動偵測）")
    parser.add_argument("--no-punctuation", action="store_true",
                        help="跳過標點補強步驟（預設：自動補標點)")
    parser.add_argument("--terms", default=None,
                        help="本次任務使用的專有名詞，多個詞以逗點分隔")
    parser.add_argument("--speaker-dir", default=None,
                        help="聲紋庫目錄路徑（選填；設定後啟用聲紋比對功能）")
    parser.add_argument("--model", default=DEFAULT_MODEL, choices=WHISPER_MODELS,
                        help=f"Whisper 模型名稱（預設：{DEFAULT_MODEL}）；可選：{', '.join(WHISPER_MODELS)}")
    args = parser.parse_args()

    audio_path = Path(args.audio_file).resolve()
    if not audio_path.exists():
        print(f"ERROR: 找不到檔案：{audio_path}", file=sys.stderr)
        sys.exit(1)

    basename = audio_path.stem

    output_dir = Path(args.output_dir) / basename
    output_dir.mkdir(parents=True, exist_ok=True)
    print(f"建立資料夾: {output_dir}")

    speaker_dir = Path(args.speaker_dir) if args.speaker_dir else None
    resolved_device = get_device(args.device)

    segments, speaker_map, language, duration = transcribe_with_diarization(
        audio_path,
        language=args.lang,
        device=resolved_device,
        num_speakers=args.num_speakers,
        speaker_dir=speaker_dir,
        terms=parse_terms(args.terms),
        model_name=args.model
    )

    add_punct = not args.no_punctuation

    if add_punct:
        print("標點補強中（使用本地模型）...")

    punct_timer = _StepTimer(TIMING_ENABLED)
    punct_timer.start()
    md_content = build_transcript_md(segments, speaker_map, basename, language, duration, add_punctuation=add_punct, device=resolved_device)
    punct_timer.record("Step 6 標點補強")
    if add_punct:
        print(f"標點補強完成{punct_timer.fmt('Step 6 標點補強')}")
    punct_timer.summary()

    transcript_path = output_dir / f"{basename}_逐字稿.md"
    transcript_path.write_text(md_content, encoding="utf-8")

    speaker_legend = "\n".join([f"  {v}: {k}" for k, v in speaker_map.items()])
    print("\n完成！")
    print(f"  逐字稿: {transcript_path}")
    print(f"\n語者對應：\n{speaker_legend}")
    print("\n提示：語者代號為自動辨識，請人工確認是否對應正確。")


if __name__ == "__main__":
    main()
