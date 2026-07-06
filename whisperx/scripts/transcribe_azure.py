#!/usr/bin/env python3
"""
transcribe_azure.py - 使用 Azure Speech「LLM Speech API」的 MAI-Transcribe 模型進行語音轉錄

功能：
    - 透過 Azure Fast Transcription 端點（transcriptions:transcribe）呼叫 mai-transcribe-1.5
    - 支援 phraseList（專有名詞偏誤）與 transcribeStyle（verbatim 逐字風格）
    - 輸出帶時間戳記的 Markdown 逐字稿（格式與 transcribe_diarize.py / transcribe_gemini.py 一致）

⚠️ 重要限制（Azure MAI-Transcribe 官方文件）：
    - 「不支援語者分離（diarization）」，因此輸出不含 Speaker 1 / Speaker 2 標籤，
      僅有時間軸分段。若需語者分離請改用 transcribe_diarize.py（WhisperX）。
    - 音檔大小需 < 300 MB，格式僅支援 WAV、MP3、FLAC。
    - phraseList 與 transcribeStyle 只有 mai-transcribe-1.5 支援（mai-transcribe-1 不支援）。
    - 目前為 public preview 功能。

Usage:
    python3 transcribe_azure.py <audio_file> [--output-dir <dir>] [--lang <code>]
    python3 transcribe_azure.py <audio_file> --style verbatim --terms "Robotic, OEM, Fabian"
    python3 transcribe_azure.py <audio_file> --model mai-transcribe-1.5 --lang auto

Output:
    <output_dir>/<basename>/<basename>_逐字稿.md

==============================================================
安裝步驟（首次使用）：
==============================================================
1. 安裝 Python 套件：
       pip install requests opencc-python-reimplemented
   （opencc 用於簡轉繁；未安裝時會保留簡體並警告，可加 --no-traditional 停用）

2. 在 Azure Portal 建立 Microsoft Foundry（Speech）資源，取得 endpoint 與 key。

3. 設定環境變數：
       export AZURE_SPEECH_ENDPOINT=https://<your-resource>.cognitiveservices.azure.com/
       export AZURE_SPEECH_KEY=<your-speech-resource-key>

   （亦可用 --endpoint / --key 參數覆蓋環境變數）
==============================================================
"""

import argparse
import json
import os
import sys
from pathlib import Path

# API 版本與端點路徑（依 Azure 文件；2025-10-15 起支援 enhancedMode / mai-transcribe）
API_VERSION = "2025-10-15"
TRANSCRIBE_PATH = "/speechtotext/transcriptions:transcribe"

# 支援的模型與音檔限制
SUPPORTED_MODELS = ["mai-transcribe-1.5", "mai-transcribe-1"]
DEFAULT_MODEL = "mai-transcribe-1.5"
SUPPORTED_EXTENSIONS = {".wav", ".mp3", ".flac"}
MAX_FILE_MB = 300

# 上傳音檔的 MIME 對應
_AUDIO_MEDIA_TYPES = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
}


def format_timestamp(seconds: float) -> str:
    """將秒數轉為 HH:MM:SS 格式。"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def parse_terms(terms: str = None) -> list:
    """解析逗號分隔的專有名詞清單（用於 phraseList 偏誤）。"""
    if not terms:
        return []
    parsed = [term.strip() for term in terms.split(",") if term.strip()]
    if parsed:
        print(f"載入本次任務專有名詞：{len(parsed)} 個")
    return parsed


def make_s2t_converter():
    """
    回傳一個「簡體 → 繁體（台灣用語）」轉換函式。

    MAI-Transcribe 的中文輸出為簡體（Azure 的 `zh` 即 Chinese simplified，
    無繁體選項），此處以 OpenCC s2twp 轉為台灣繁體並套用慣用詞轉換。
    若未安裝 OpenCC，回傳 None（呼叫端保留原始簡體並警告）。
    """
    try:
        from opencc import OpenCC
    except ImportError:
        return None
    cc = OpenCC("s2twp")
    return cc.convert


def build_definition(model: str, locales: list, style: str, phrases: list) -> dict:
    """
    組出 Azure transcriptions:transcribe 端點的 definition 物件。

    可用欄位（依 Azure 文件）：
      - enhancedMode.enabled  : 啟用 LLM Speech / enhanced 模式（mai 模型必填）
      - enhancedMode.model    : mai-transcribe-1.5 或 mai-transcribe-1
      - enhancedMode.transcribeStyle : "verbatim"（保留贅字/口語）或省略（可讀性優化，預設）
      - locales               : 強制單一語言，如 ["zh"]；省略則為多語言自動模式
      - phraseList.phrases    : 專有名詞偏誤清單（僅 mai-transcribe-1.5 支援）

    註：MAI-Transcribe 不支援 diarization（語者分離）與 prompt-tuning。
    """
    enhanced = {"enabled": True, "model": model}
    # transcribeStyle 與 phraseList 僅 mai-transcribe-1.5 支援
    if model == "mai-transcribe-1.5" and style == "verbatim":
        enhanced["transcribeStyle"] = "verbatim"

    definition = {"enhancedMode": enhanced}

    if locales:
        definition["locales"] = locales

    if phrases and model == "mai-transcribe-1.5":
        definition["phraseList"] = {"phrases": phrases}
    elif phrases:
        print(f"警告：模型 {model} 不支援 phraseList，已忽略專有名詞。", file=sys.stderr)

    return definition


def call_azure_transcribe(
    audio_path: Path,
    endpoint: str,
    api_key: str,
    definition: dict,
    timeout: int = 600,
) -> dict:
    """
    呼叫 Azure Fast Transcription 端點，回傳解析後的 JSON。

    以 multipart/form-data 上傳：
      - audio      : 音檔
      - definition : JSON 字串
    """
    try:
        import requests
    except ImportError:
        print("ERROR: requests 未安裝。請執行：pip install requests", file=sys.stderr)
        sys.exit(1)

    url = f"{endpoint.rstrip('/')}{TRANSCRIBE_PATH}?api-version={API_VERSION}"
    media_type = _AUDIO_MEDIA_TYPES.get(audio_path.suffix.lower(), "application/octet-stream")

    print(f"上傳音訊至 Azure（{audio_path.name}）...")
    print(f"  端點：{url}")
    print(f"  definition：{json.dumps(definition, ensure_ascii=False)}")

    with open(audio_path, "rb") as f:
        files = {"audio": (audio_path.name, f, media_type)}
        data = {"definition": json.dumps(definition, ensure_ascii=False)}
        headers = {"Ocp-Apim-Subscription-Key": api_key}
        try:
            resp = requests.post(url, headers=headers, files=files, data=data, timeout=timeout)
        except requests.exceptions.RequestException as e:
            print(f"ERROR: 呼叫 Azure API 失敗：{e}", file=sys.stderr)
            sys.exit(1)

    if resp.status_code != 200:
        print(f"ERROR: Azure API 回傳 HTTP {resp.status_code}", file=sys.stderr)
        print(resp.text[:2000], file=sys.stderr)
        sys.exit(1)

    try:
        return resp.json()
    except ValueError:
        print("ERROR: 無法解析 Azure 回應為 JSON。", file=sys.stderr)
        print(resp.text[:2000], file=sys.stderr)
        sys.exit(1)


def build_transcript_md(
    result: dict,
    audio_name: str,
    language: str,
    model: str,
    style: str,
    convert=None,
) -> str:
    """
    由 Azure 回應產生 Markdown 逐字稿。

    Azure 回應結構：
      - durationMilliseconds : 音訊總長度（毫秒）
      - combinedPhrases[]    : {channel, text} 完整合併文字
      - phrases[]            : {offsetMilliseconds, durationMilliseconds, text, locale, ...}
                               （MAI-Transcribe 無 speaker 欄位）

    註：MAI-Transcribe 實測通常「整段音訊只回傳一個 phrase」，其 text 內以換行
    分隔每一句話（無逐句時間戳）。因此本函式會把 phrase 內的文字依換行拆成
    一句一行輸出，僅在 phrase 層級標註時間範圍，避免整段擠成一塊難以閱讀。
    """
    # 未提供轉換器時以原字串回傳（不做簡繁轉換）
    if convert is None:
        convert = lambda s: s

    duration_ms = result.get("durationMilliseconds", 0)
    duration_s = duration_ms / 1000.0 if duration_ms else 0.0
    phrases = result.get("phrases", []) or []
    combined = result.get("combinedPhrases", []) or []

    # 判斷是否為「單一 phrase 涵蓋整段」的情況（此時 phrase 時間範圍等於全片長，
    # 標註時間範圍沒有意義，直接輸出句子即可）
    single_full = len(phrases) == 1

    lines = [
        f"# 逐字稿 - {audio_name}",
        "",
        f"**語言:** {language}",
        f"**總時長:** {format_timestamp(duration_s) if duration_s else '不明'}",
        f"**轉錄引擎:** Azure {model}",
        f"**轉錄風格:** {style}",
        "",
        "> ⚠️ MAI-Transcribe 不支援語者分離，本逐字稿無 Speaker 標籤。",
        "",
        "---",
        "",
    ]

    if phrases:
        for seg in phrases:
            text = (seg.get("text") or "").strip()
            if not text:
                continue
            # phrase 內的文字可能含換行，代表多句話；拆成一句一行
            sentences = [ln.strip() for ln in text.splitlines() if ln.strip()]
            if not single_full:
                start = seg.get("offsetMilliseconds", 0) / 1000.0
                dur = seg.get("durationMilliseconds", 0) / 1000.0
                end = start + dur
                lines.append(f"**[{format_timestamp(start)} → {format_timestamp(end)}]**")
            # 每句話各自成段，方便後續人工校對與語者標註
            for sentence in sentences:
                lines.append(convert(sentence))
                lines.append("")
    elif combined:
        # 無分段資訊時退回輸出合併文字
        lines.append("> ⚠️ 回應未包含分段資訊，輸出合併文字：")
        lines.append("")
        for block in combined:
            text = (block.get("text") or "").strip()
            if text:
                lines.append(convert(text))
                lines.append("")
    else:
        lines.append("> ⚠️ Azure 未回傳任何轉錄結果。")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="使用 Azure MAI-Transcribe 轉錄音訊，輸出帶時間戳記的 Markdown 逐字稿（不含語者分離）。"
    )
    parser.add_argument("audio_file", help="音訊檔路徑（wav / mp3 / flac，需 < 300 MB）")
    parser.add_argument("--output-dir", default=".", help="輸出根目錄（預設：當前目錄）")
    parser.add_argument(
        "--lang", default="zh",
        help="語言代碼（預設：zh；設 auto 則多語言自動模式，不強制單一語言）",
    )
    parser.add_argument(
        "--model", default=DEFAULT_MODEL, choices=SUPPORTED_MODELS,
        help=f"MAI-Transcribe 模型（預設：{DEFAULT_MODEL}）；可選：{', '.join(SUPPORTED_MODELS)}",
    )
    parser.add_argument(
        "--style", default="default", choices=["default", "verbatim"],
        help="轉錄風格（預設：default 可讀性優化；verbatim 保留贅字口語，僅 mai-transcribe-1.5 支援）",
    )
    parser.add_argument(
        "--terms", default=None,
        help="本次任務使用的專有名詞，多個詞以逗點分隔（phraseList 偏誤，僅 mai-transcribe-1.5 支援）",
    )
    parser.add_argument(
        "--no-traditional", action="store_true",
        help="停用簡轉繁（預設會將簡體輸出轉為台灣繁體；需安裝 opencc-python-reimplemented）",
    )
    parser.add_argument(
        "--endpoint", default=None,
        help="Azure Speech 端點（預設讀取環境變數 AZURE_SPEECH_ENDPOINT）",
    )
    parser.add_argument(
        "--key", default=None,
        help="Azure Speech 金鑰（預設讀取環境變數 AZURE_SPEECH_KEY）",
    )
    parser.add_argument(
        "--timeout", type=int, default=600,
        help="HTTP 請求逾時秒數（預設：600）",
    )
    args = parser.parse_args()

    endpoint = args.endpoint or os.environ.get("AZURE_SPEECH_ENDPOINT")
    api_key = args.key or os.environ.get("AZURE_SPEECH_KEY")
    if not endpoint:
        print("ERROR: 未提供 Azure 端點。請設定環境變數 AZURE_SPEECH_ENDPOINT 或使用 --endpoint。", file=sys.stderr)
        sys.exit(1)
    if not api_key:
        print("ERROR: 未提供 Azure 金鑰。請設定環境變數 AZURE_SPEECH_KEY 或使用 --key。", file=sys.stderr)
        sys.exit(1)

    audio_path = Path(args.audio_file).resolve()
    if not audio_path.exists():
        print(f"ERROR: 找不到檔案：{audio_path}", file=sys.stderr)
        sys.exit(1)

    suffix = audio_path.suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        print(
            f"ERROR: 不支援的格式：{suffix or '（無副檔名）'}。"
            f"MAI-Transcribe 僅支援：{', '.join(sorted(SUPPORTED_EXTENSIONS))}",
            file=sys.stderr,
        )
        sys.exit(1)

    size_mb = audio_path.stat().st_size / (1024 * 1024)
    if size_mb > MAX_FILE_MB:
        print(f"ERROR: 音檔 {size_mb:.1f} MB 超過上限 {MAX_FILE_MB} MB。", file=sys.stderr)
        sys.exit(1)

    basename = audio_path.stem
    output_dir = Path(args.output_dir) / basename
    output_dir.mkdir(parents=True, exist_ok=True)
    print(f"建立資料夾: {output_dir}")

    # lang=auto → 多語言模式（不帶 locales）；否則強制單一語言
    locales = [] if args.lang.lower() == "auto" else [args.lang]
    phrases = parse_terms(args.terms)

    definition = build_definition(args.model, locales, args.style, phrases)

    result = call_azure_transcribe(
        audio_path=audio_path,
        endpoint=endpoint,
        api_key=api_key,
        definition=definition,
        timeout=args.timeout,
    )

    num_phrases = len(result.get("phrases", []) or [])
    print(f"轉錄完成，共 {num_phrases} 段")

    # 簡轉繁（MAI-Transcribe 中文輸出為簡體；預設轉台灣繁體）
    convert = None
    if not args.no_traditional:
        convert = make_s2t_converter()
        if convert is None:
            print(
                "警告：未安裝 OpenCC，保留簡體輸出。"
                "如需簡轉繁請執行：pip install opencc-python-reimplemented",
                file=sys.stderr,
            )
        else:
            print("簡轉繁：已啟用（s2twp 台灣繁體）")

    md_content = build_transcript_md(
        result,
        audio_name=basename,
        language=args.lang,
        model=args.model,
        style=args.style,
        convert=convert,
    )

    transcript_path = output_dir / f"{basename}_逐字稿.md"
    transcript_path.write_text(md_content, encoding="utf-8")

    # 同時保留原始 JSON，方便除錯與二次處理
    raw_path = output_dir / f"{basename}_azure_raw.json"
    raw_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n完成！")
    print(f"  逐字稿: {transcript_path}")
    print(f"  原始回應: {raw_path}")
    print("\n提示：MAI-Transcribe 不做語者分離，如需區分說話者請改用 transcribe_diarize.py。")


if __name__ == "__main__":
    main()
