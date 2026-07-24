#!/usr/bin/env python3
"""
transcribe_azure_diarize.py - Azure MAI-Transcribe 逐字稿 + 語者分離（實驗性）

背景：
    MAI-Transcribe（transcribe_azure.py）官方文件明確表示不支援 diarization，
    且只回傳 phrase 級時間戳（長音訊常整段只回傳一個 phrase，句子之間完全
    沒有時間戳）。因此無法比照 transcribe_diarize.py 用
    whisperx.assign_word_speakers 做逐字語者指派。

做法（此腳本嘗試解決上述限制）：
    1. 呼叫 Azure，取得「文字品質已知正確」的逐字稿（依換行拆成句子，
       但捨棄其不可靠的 phrase 時間戳）
    2. 用 wav2vec2 CTC 模型（與 WhisperX 對齊步驟用的模型相同）+
       ctc-segmentation 套件，對整段音訊做強制對齊（forced alignment），
       重新算出每一句話的起訖時間——不依賴 Azure 提供的時間戳
       * 長音訊（30~60 分鐘）用 ctc_segmentation.get_partitions 切成多個
         chunk 分別跑 wav2vec2，避開 transformer attention 對超長序列的
         記憶體問題，再依 delete_overlap_list 拼接成一條完整的 log 機率序列
    3. 用 pyannote（沿用 transcribe_diarize.py 的 DiarizationPipeline）對
       整段音訊做語者分離，取得語者時間段
    4. 依「時間重疊」把步驟 2 重建出時間的句子指派給步驟 3 的語者
       （重疊時間最長者勝出，概念上等同 whisperx.assign_word_speakers，
       只是顆粒度是「句子」而非「字」）

⚠️ 實驗性質：
    - 需額外安裝 ctc-segmentation、transformers（wav2vec2 CTC 模型）
    - forced alignment 品質取決於 wav2vec2 中文模型的字元辨識能力，
      在有雜訊/口音很重的會議錄音上可能不夠準
    - 尚未在真實會議錄音上完整驗證，使用前務必先在小段測試音檔上跑過，
      確認重建時間戳與語者指派的準確度是否可接受

Usage:
    python3 transcribe_azure_diarize.py <audio_file> [--output-dir <dir>] [--lang zh]
    python3 transcribe_azure_diarize.py <audio_file> --num-speakers 3 --style verbatim

Output:
    <output_dir>/<basename>/<basename>_逐字稿.md

==============================================================
安裝步驟（在既有 transcribe_azure.py / transcribe_diarize.py 依賴之外）：
==============================================================
    pip install ctc-segmentation transformers --break-system-packages

環境變數：與 transcribe_azure.py（AZURE_SPEECH_ENDPOINT / AZURE_SPEECH_KEY）
         及 transcribe_diarize.py（HF_TOKEN）相同。
==============================================================
"""

import argparse
import os
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from transcribe_azure import (  # noqa: E402
    API_VERSION,
    build_definition,
    call_azure_transcribe,
    make_s2t_converter,
    parse_terms,
)
from transcribe_diarize import (  # noqa: E402
    _StepTimer,
    TIMING_ENABLED,
    format_timestamp,
    get_device,
    normalize_speaker_labels,
)

# 與 WhisperX alignment.py 的 DEFAULT_ALIGN_MODELS_HF 對齊，
# 確保跟 transcribe_diarize.py 用的是同一顆對齊模型（品質/行為一致）
ALIGN_MODELS = {
    "zh": "jonatasgrosman/wav2vec2-large-xlsr-53-chinese-zh-cn",
    "en": "jonatasgrosman/wav2vec2-large-xlsr-53-english",
}
# wav2vec2 標準下採樣率：16kHz 音訊每 320 個 sample 對應 1 個輸出 frame（20ms/frame）
SAMPLES_TO_FRAMES_RATIO = 320
FRAME_DURATION_S = SAMPLES_TO_FRAMES_RATIO / 16000  # 0.02s


def extract_sentences(azure_result: dict) -> list:
    """
    從 Azure 回應中取出句子清單（捨棄不可靠的 phrase 時間戳，
    只保留文字；時間戳改由 Step 2 的強制對齊重建）。
    """
    sentences = []
    for phrase in azure_result.get("phrases", []) or []:
        text = (phrase.get("text") or "").strip()
        if not text:
            continue
        for line in text.splitlines():
            line = line.strip()
            if line:
                sentences.append(line)
    if not sentences:
        for block in azure_result.get("combinedPhrases", []) or []:
            text = (block.get("text") or "").strip()
            if text:
                sentences.extend(s.strip() for s in text.splitlines() if s.strip())
    return sentences


def load_ctc_model(language: str, device: str):
    """載入 wav2vec2 CTC 模型 + processor（與 WhisperX 對齊步驟同款模型）。"""
    from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

    model_id = ALIGN_MODELS.get(language)
    if not model_id:
        print(f"ERROR: 沒有語言 {language} 對應的 CTC 對齊模型，可在 ALIGN_MODELS 補上。", file=sys.stderr)
        sys.exit(1)

    print(f"載入強制對齊模型：{model_id}")
    processor = Wav2Vec2Processor.from_pretrained(model_id)
    model = Wav2Vec2ForCTC.from_pretrained(model_id).to(device)
    model.eval()
    return model, processor


def compute_logprobs_chunked(audio: np.ndarray, model, processor, device: str,
                              max_len_s: float = 20.0, overlap_frames: int = 4) -> np.ndarray:
    """
    將長音訊切成多個 chunk 分別跑 wav2vec2，避開 transformer attention
    對超長序列（30~60 分鐘）的記憶體問題，再拼接成一條完整的 log 機率序列。
    """
    import torch
    from ctc_segmentation import get_partitions

    t = len(audio)
    part = get_partitions(
        t=t, max_len_s=max_len_s, fs=16000,
        samples_to_frames_ratio=SAMPLES_TO_FRAMES_RATIO,
        overlap=overlap_frames,
    )

    chunks = []
    partition_stats = []  # 診斷用：每個 partition 的 (輸入樣本數, 實際輸出影格數)
    with torch.no_grad():
        for start, end in part["partitions"]:
            segment = audio[start:end] if end is not None else audio[start:]
            inputs = processor(segment, sampling_rate=16000, return_tensors="pt")
            input_values = inputs.input_values.to(device)
            logits = model(input_values).logits[0]  # (frames, vocab)
            logprobs = torch.log_softmax(logits, dim=-1).cpu().numpy()
            chunks.append(logprobs)
            partition_stats.append((len(segment), logprobs.shape[0]))

    lpz = np.concatenate(chunks, axis=0)
    # 刪除 overlap 區間重複計算的 frame，避免同一段音訊被算兩次機率
    delete_idx = [i for i in part["delete_overlap_list"] if 0 <= i < len(lpz)]
    if delete_idx:
        lpz = np.delete(lpz, sorted(set(delete_idx)), axis=0)

    # 診斷：若拼接後的影格數遠少於音訊長度的理論值（samples / SAMPLES_TO_FRAMES_RATIO），
    # 代表某些 partition 實際輸出的影格數遠低於預期（例如 wav2vec2 對該段內容的
    # 下採樣行為與 SAMPLES_TO_FRAMES_RATIO 假設不符），逐一印出每個 partition 的
    # 樣本數/理論影格數/實際影格數，方便定位是哪個 partition 出問題。
    expected_total = t // SAMPLES_TO_FRAMES_RATIO
    if expected_total > 0 and len(lpz) < expected_total * 0.5:
        print(
            f"    診斷：lpz 拼接後僅 {len(lpz)} 影格，遠少於理論值 {expected_total}"
            f"（輸入 {t} samples），逐一 partition 明細：",
            file=sys.stderr,
        )
        for idx, (in_samples, out_frames) in enumerate(partition_stats):
            expected = in_samples // SAMPLES_TO_FRAMES_RATIO
            flag = "  <== 異常" if expected > 0 and out_frames < expected * 0.5 else ""
            print(
                f"      partition {idx}: 輸入 {in_samples} samples（理論 {expected} 影格），"
                f"實際輸出 {out_frames} 影格{flag}",
                file=sys.stderr,
            )

    return lpz


def align_sentences(sentences: list, lpz: np.ndarray, processor) -> list:
    """
    用 ctc-segmentation 對已知句子清單做強制對齊，回傳
    [(start_s, end_s, confidence, text), ...]。
    """
    from ctc_segmentation import (
        CtcSegmentationParameters,
        ctc_segmentation,
        determine_utterance_segments,
        prepare_text,
    )

    vocab = processor.tokenizer.get_vocab()
    char_list = [None] * len(vocab)
    for ch, idx in vocab.items():
        char_list[idx] = ch

    config = CtcSegmentationParameters(char_list=char_list)
    config.index_duration = FRAME_DURATION_S
    config.blank = processor.tokenizer.pad_token_id or 0

    ground_truth_mat, utt_begin_indices = prepare_text(config, sentences)
    timings, char_probs, state_list = ctc_segmentation(config, lpz, ground_truth_mat)
    # ctc-segmentation 的 determine_utterance_segments 會用 timings[index + 1]，
    # 當文字太多、影格太少導致對齊把某句起始壓到最後一格時，會 IndexError
    # （套件已知邊界 bug）。先把索引 clamp 到 len(timings) - 2，避免越界。
    max_index = len(timings) - 2
    if max_index >= 0:
        utt_begin_indices = np.minimum(utt_begin_indices, max_index)
    segments = determine_utterance_segments(config, utt_begin_indices, char_probs, timings, sentences)

    return [(start, end, conf, text) for (start, end, conf), text in zip(segments, sentences)]


def _even_distribute(sentences: list, duration_s: float) -> list:
    """
    對齊失敗時的退路：依字數比例，把整批句子平均分配在這段音訊時間內。
    回傳 [(start_s, end_s, conf, text), ...]，時間相對於這段音訊起點；
    conf 設為 0.0，表示是估計值而非真實對齊結果。
    """
    if not sentences:
        return []
    char_counts = [max(1, len(s)) for s in sentences]
    total = sum(char_counts)
    results = []
    cursor = 0.0
    for text, c in zip(sentences, char_counts):
        seg = duration_s * (c / total)
        results.append((cursor, cursor + seg, 0.0, text))
        cursor += seg
    return results


def align_sentences_chunked(
    sentences: list, audio: np.ndarray, model, processor, device: str,
    batch_size: int = 80, padding_seconds: float = 45.0, max_chunk_seconds: float = 20.0,
) -> list:
    """
    分批處理長會議錄音的強制對齊。

    原本的作法是先對「整段音訊」跑 compute_logprobs_chunked，得到單一
    完整的 logprobs 矩陣（frames × vocab_size）後，才切片給 ctc_segmentation
    對齊。但 wav2vec2-large-xlsr-53-chinese 的字元詞彙表高達 3503 個
    token，長會議（例如 3 小時 ≈ 540000 frames）光是完整 logprobs 矩陣
    就要 7.5GB+，逐 chunk 累積在 list 裡等待 concatenate 時峰值更高，
    曾在 15GB RAM 主機上把單一 process 撐到 11.3GB 而被系統 OOM killer
    砍掉（compute_logprobs_chunked 本身雖已把「wav2vec2 推論」切 chunk
    處理，但輸出的完整 logprobs 陣列仍是一次性攢完整段音訊）。

    因此改為：依字數比例，先粗估每批句子對應的「原始音訊」時間範圍
    （只切音訊樣本，不是切 logprobs），只對這一小段音訊呼叫
    compute_logprobs_chunked + align_sentences，用完即釋放。
    全程不會有涵蓋整段錄音長度的 logprobs 矩陣同時存在於記憶體中。
    """
    total_sentences = len(sentences)
    if total_sentences == 0:
        return []

    char_counts = [len(s) for s in sentences]
    cum_chars = []
    running = 0
    for c in char_counts:
        running += c
        cum_chars.append(running)
    total_chars = cum_chars[-1] or 1

    total_samples = len(audio)
    padding_samples = int(padding_seconds * 16000)

    results = []
    batch_starts = list(range(0, total_sentences, batch_size))
    for batch_idx, i in enumerate(batch_starts):
        j = min(i + batch_size, total_sentences)
        batch_sentences = sentences[i:j]

        start_frac = (cum_chars[i - 1] / total_chars) if i > 0 else 0.0
        end_frac = cum_chars[j - 1] / total_chars

        sample_start = max(0, int(start_frac * total_samples) - padding_samples)
        sample_end = min(total_samples, int(end_frac * total_samples) + padding_samples)
        if sample_end <= sample_start:
            sample_end = min(total_samples, sample_start + 16000)

        print(
            f"  對齊批次 {batch_idx + 1}/{len(batch_starts)}"
            f"（句 {i + 1}-{j}/{total_sentences}，"
            f"音訊 {sample_start / 16000:.0f}s-{sample_end / 16000:.0f}s）"
        )
        audio_slice = audio[sample_start:sample_end]
        slice_seconds = len(audio_slice) / 16000.0
        try:
            lpz_batch = compute_logprobs_chunked(
                audio_slice, model, processor, device, max_len_s=max_chunk_seconds,
            )
            # 影格帳自檢：lpz 影格對應的秒數應與音訊長度相符；差太多代表
            # chunk 拼接/overlap 刪除把影格算掉了，對齊幾乎必然失敗。
            lpz_seconds = len(lpz_batch) * FRAME_DURATION_S
            if slice_seconds > 0 and lpz_seconds < slice_seconds * 0.5:
                print(
                    f"    警告：批次 {batch_idx + 1} log 機率影格僅 {lpz_seconds:.0f}s，"
                    f"遠少於音訊 {slice_seconds:.0f}s（影格帳可疑），對齊可能不準。",
                    file=sys.stderr,
                )
            batch_result = align_sentences(batch_sentences, lpz_batch, processor)
            del lpz_batch
        except Exception as e:
            # 單一批次對齊失敗（例如 ctc-segmentation 回溯失敗）不應拖垮整個任務，
            # 退回用字數比例平均分配時間戳，讓流程能跑完。
            print(
                f"    警告：批次 {batch_idx + 1} 強制對齊失敗（{e}），"
                f"改用字數比例平均分配時間戳。",
                file=sys.stderr,
            )
            batch_result = _even_distribute(batch_sentences, slice_seconds)
        del audio_slice

        import gc
        gc.collect()
        if device == "cuda":
            import torch
            torch.cuda.empty_cache()

        offset_s = sample_start / 16000.0
        for start, end, conf, text in batch_result:
            results.append((start + offset_s, end + offset_s, conf, text))

    return results


def run_diarization(audio_path: Path, audio: np.ndarray, device: str, num_speakers: int = None,
                     speaker_dir: Path = None):
    """對整段音訊做語者分離，回傳 (diarize_segments, name_map)。沿用 transcribe_diarize.py 的做法。"""
    import torch
    import whisperx.diarize

    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        print("ERROR: HF_TOKEN 環境變數未設定（語者分離需要）。", file=sys.stderr)
        print("       請至 https://huggingface.co/settings/tokens 申請", file=sys.stderr)
        sys.exit(1)

    print("語者分離中...")
    diarize_kwargs = {"audio": audio}
    if num_speakers:
        diarize_kwargs["num_speakers"] = num_speakers

    diarize_device = torch.device(device)
    diarize_model = whisperx.diarize.DiarizationPipeline(token=hf_token, device=diarize_device)
    diarize_segments = diarize_model(**diarize_kwargs)

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
                device=device,
            )
        except Exception as e:
            print(f"警告：聲紋比對失敗（{e}），使用預設 Speaker 編號。", file=sys.stderr)

    return diarize_segments, name_map


def assign_speakers_to_sentences(aligned_sentences: list, diarize_segments) -> list:
    """
    依時間重疊，把每句話指派給重疊時間最長的語者
    （句子級版本的 whisperx.assign_word_speakers）。
    回傳 [(speaker, start, end, text), ...]。
    """
    rows = list(diarize_segments.itertuples(index=False))
    result = []
    for start, end, _conf, text in aligned_sentences:
        best_speaker, best_overlap = "UNKNOWN", 0.0
        for row in rows:
            overlap = min(end, row.end) - max(start, row.start)
            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = row.speaker
        if best_overlap <= 0 and rows:
            # 無重疊（強制對齊誤差或語者分離漏段）：退而求其次，
            # 用句子中點最近的語者區段
            mid = (start + end) / 2
            row = min(rows, key=lambda r: min(abs(mid - r.start), abs(mid - r.end)))
            best_speaker = row.speaker
        result.append((best_speaker, start, end, text))
    return result


def build_transcript_md(labeled_sentences: list, speaker_map: dict, audio_name: str,
                         language: str, duration: float, convert=None) -> str:
    """輸出格式比照 transcribe_diarize.py：相鄰同語者句子合併為一段。"""
    if convert is None:
        convert = lambda s: s

    groups = []
    prev_speaker = None
    buffer_text, buffer_start, buffer_end = [], None, None
    for speaker, start, end, text in labeled_sentences:
        if speaker == prev_speaker:
            buffer_text.append(text)
            buffer_end = end
        else:
            if buffer_text and prev_speaker:
                groups.append((prev_speaker, buffer_start, buffer_end, buffer_text))
            prev_speaker, buffer_text, buffer_start, buffer_end = speaker, [text], start, end
    if buffer_text and prev_speaker:
        groups.append((prev_speaker, buffer_start, buffer_end, buffer_text))

    lines = [
        f"# 逐字稿 - {audio_name}",
        "",
        f"**語言:** {language}",
        f"**總時長:** {format_timestamp(duration)}",
        f"**語者人數:** {len(speaker_map)}",
        f"**轉錄引擎:** Azure MAI-Transcribe + pyannote 語者分離（時間戳為 wav2vec2 強制對齊重建，僅供參考）",
        "",
        "---",
        "",
    ]
    for speaker, start, end, texts in groups:
        label = speaker_map.get(speaker, speaker)
        lines.append(f"**[{format_timestamp(start)} → {format_timestamp(end)}] {label}:**")
        lines.append(convert(" ".join(texts)))
        lines.append("")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Azure MAI-Transcribe 轉錄 + pyannote 語者分離（強制對齊重建時間戳，實驗性）。"
    )
    parser.add_argument("audio_file", help="音訊檔路徑（wav / mp3 / flac）")
    parser.add_argument("--output-dir", default=".", help="輸出根目錄")
    parser.add_argument("--lang", default="zh", help="語言代碼（需在 ALIGN_MODELS 中有對應對齊模型）")
    parser.add_argument("--model", default="mai-transcribe-1.5", choices=["mai-transcribe-1.5", "mai-transcribe-1"])
    parser.add_argument("--style", default="default", choices=["default", "verbatim"])
    parser.add_argument("--terms", default=None, help="專有名詞，逗點分隔")
    parser.add_argument("--num-speakers", type=int, default=None)
    parser.add_argument("--speaker-dir", default=None)
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda", "mps"])
    parser.add_argument("--no-traditional", action="store_true")
    parser.add_argument("--endpoint", default=None)
    parser.add_argument("--key", default=None)
    parser.add_argument("--max-chunk-seconds", type=float, default=20.0,
                        help="強制對齊時每個 wav2vec2 推論 chunk 的長度上限（預設 20 秒）")
    parser.add_argument("--align-batch-sentences", type=int, default=80,
                        help="ctc_segmentation 對齊時每批次的句子數上限（預設 80）。"
                             "批次越小記憶體越省，但對齊呼叫次數越多")
    parser.add_argument("--align-padding-seconds", type=float, default=45.0,
                        help="每批次對齊時，依字數比例估計的音訊時間範圍前後各加的緩衝秒數（預設 45 秒）")
    args = parser.parse_args()

    endpoint = args.endpoint or os.environ.get("AZURE_SPEECH_ENDPOINT")
    api_key = args.key or os.environ.get("AZURE_SPEECH_KEY")
    if not endpoint or not api_key:
        print("ERROR: 需設定 AZURE_SPEECH_ENDPOINT / AZURE_SPEECH_KEY。", file=sys.stderr)
        sys.exit(1)

    audio_path = Path(args.audio_file).resolve()
    if not audio_path.exists():
        print(f"ERROR: 找不到檔案：{audio_path}", file=sys.stderr)
        sys.exit(1)

    basename = audio_path.stem
    output_dir = Path(args.output_dir) / basename
    output_dir.mkdir(parents=True, exist_ok=True)

    resolved_device = get_device(args.device)
    timer = _StepTimer(TIMING_ENABLED)

    # Step 1: Azure 轉錄（取得高品質文字，捨棄不可靠的 phrase 時間戳）
    print("============= Step 1: Azure 轉錄 ==================")
    timer.start()
    locales = [] if args.lang.lower() == "auto" else [args.lang]
    definition = build_definition(args.model, locales, args.style, parse_terms(args.terms))
    azure_result = call_azure_transcribe(audio_path, endpoint, api_key, definition)
    sentences = extract_sentences(azure_result)
    duration_s = (azure_result.get("durationMilliseconds", 0) or 0) / 1000.0
    timer.record("Step 1 Azure 轉錄")
    print(f"取得 {len(sentences)} 句{timer.fmt('Step 1 Azure 轉錄')}")
    if not sentences:
        print("ERROR: Azure 未回傳任何文字，無法繼續。", file=sys.stderr)
        sys.exit(1)

    # 載入音訊（wav2vec2 對齊與 pyannote 皆用同一份 16kHz 音訊）
    timer.start()
    import whisperx
    audio = whisperx.load_audio(str(audio_path))
    if not duration_s:
        duration_s = float(audio.shape[0]) / 16000
    timer.record("音訊載入")
    print(f"音訊載入完成{timer.fmt('音訊載入')}")

    # Step 2: 強制對齊，重建每句話的時間戳
    print("============= Step 2: 強制對齊（重建時間戳）==================")
    timer.start()
    ctc_model, processor = load_ctc_model(args.lang, resolved_device)
    aligned_sentences = align_sentences_chunked(
        sentences, audio, ctc_model, processor, resolved_device,
        batch_size=args.align_batch_sentences,
        padding_seconds=args.align_padding_seconds,
        max_chunk_seconds=args.max_chunk_seconds,
    )
    del ctc_model
    timer.record("Step 2 強制對齊")
    print(f"強制對齊完成{timer.fmt('Step 2 強制對齊')}")

    # Step 3: 語者分離
    print("============= Step 3: 語者分離 ==================")
    timer.start()
    speaker_dir = Path(args.speaker_dir) if args.speaker_dir else None
    diarize_segments, name_map = run_diarization(
        audio_path, audio, resolved_device,
        num_speakers=args.num_speakers, speaker_dir=speaker_dir,
    )
    timer.record("Step 3 語者分離")
    print(f"語者分離完成{timer.fmt('Step 3 語者分離')}")

    # Step 4: 依時間重疊指派語者
    print("============= Step 4: 指派語者 ==================")
    timer.start()
    labeled_sentences = assign_speakers_to_sentences(aligned_sentences, diarize_segments)
    pseudo_segments = [{"speaker": s} for s, _, _, _ in labeled_sentences]
    speaker_map = normalize_speaker_labels(pseudo_segments, name_map=name_map)
    timer.record("Step 4 指派語者")
    print(f"指派語者完成，辨識到 {len(speaker_map)} 位語者：{list(speaker_map.values())}{timer.fmt('Step 4 指派語者')}")

    timer.summary()

    # 簡轉繁
    convert = None
    if not args.no_traditional:
        convert = make_s2t_converter()
        if convert is None:
            print("警告：未安裝 OpenCC，保留簡體輸出。", file=sys.stderr)

    md_content = build_transcript_md(labeled_sentences, speaker_map, basename, args.lang, duration_s, convert=convert)
    transcript_path = output_dir / f"{basename}_逐字稿.md"
    transcript_path.write_text(md_content, encoding="utf-8")

    speaker_legend = "\n".join([f"  {v}: {k}" for k, v in speaker_map.items()])
    print("\n完成！")
    print(f"  逐字稿: {transcript_path}")
    print(f"\n語者對應：\n{speaker_legend}")
    print("\n⚠️ 提示：時間戳為強制對齊重建，語者指派為句子級（非逐字），請人工抽查準確度。")


if __name__ == "__main__":
    main()
