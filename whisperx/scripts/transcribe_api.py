#!/usr/bin/env python3
"""
transcribe_api.py - WhisperX 語音轉錄 + 語者分離 API 服務

非同步任務流程：
  1. POST /transcribe  → 上傳音訊，立即回傳 job_id（HTTP 202）
  2. GET  /jobs/{id}   → 輪詢工作狀態（pending / running / done / failed）
  3. GET  /jobs/{id}/result → 下載完成的 Markdown 逐字稿

環境變數：
    HF_TOKEN        Hugging Face token（語者分離必要）
    PUNCT_BACKEND   標點補強後端：funasr / deepmulti / none（預設自動選擇）
    API_KEY         API 驗證金鑰（未設定則不驗證）
    UPLOAD_DIR      上傳暫存目錄（預設：/app/uploads）
    OUTPUT_DIR      輸出根目錄（預設：/app/outputs）
    MAX_FILE_MB     單檔上傳限制（預設：500 MB）
    JOB_TTL_HOURS   工作保留時間（預設：48 小時）
    JOB_TIMEOUT_SECONDS 超時秒數（預設：6 小時）
"""

import json
import os
import re
import shutil
import signal
import sqlite3
import sys
import threading
import uuid
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timedelta
from enum import Enum
from pathlib import Path
from typing import List, Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.openapi.utils import get_openapi
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# 設定
# ---------------------------------------------------------------------------

WHISPER_MODELS = [
    "tiny", "base", "small", "medium",
    "large-v1", "large-v2", "large-v3", "large-v3-turbo",
    "distil-large-v2", "distil-large-v3",
]
DEFAULT_WHISPER_MODEL = "large-v3"

UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", "/app/uploads"))
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", "/app/outputs"))
SPEAKER_DIR = Path(os.environ.get("SPEAKER_DIR", "/app/speaker_profiles"))
MAX_FILE_MB = int(os.environ.get("MAX_FILE_MB", "500"))
JOB_TTL_HOURS = int(os.environ.get("JOB_TTL_HOURS", "48"))
JOB_TIMEOUT_SECONDS = int(os.environ.get("JOB_TIMEOUT_SECONDS", str(6 * 60 * 60)))
API_KEY = os.environ.get("API_KEY", "")

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
SPEAKER_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTENSIONS = {".mp3", ".mp4", ".wav", ".m4a", ".ogg", ".flac", ".webm", ".aac"}

# ---------------------------------------------------------------------------
# 工作狀態管理（檔案型，容器重啟後仍保留）
# ---------------------------------------------------------------------------

JOBS_DIR = OUTPUT_DIR / "_jobs"
JOBS_DIR.mkdir(parents=True, exist_ok=True)
JOBS_DB = Path(os.environ.get("JOBS_DB", str(JOBS_DIR / "jobs.sqlite3")))

_jobs_lock = threading.Lock()
_queue_cv = threading.Condition()
_worker_stop = threading.Event()
_worker_thread: Optional[threading.Thread] = None
_active_procs: dict = {}  # job_id -> subprocess.Popen（正在執行轉錄的子行程）
_pending_cancels: set = set()  # job_ids：Popen 前收到 DELETE，等 proc 啟動後立即殺
_procs_lock = threading.Lock()
NOUN_TERM_PATTERN = re.compile(r"^[\w .-]+$")
MAX_TERMS = int(os.environ.get("MAX_TERMS", "48"))
TEAM_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")


class JobStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


# ---------------------------------------------------------------------------
# Pydantic Models（用於 Swagger 文件）
# ---------------------------------------------------------------------------

class JobRecord(BaseModel):
    """轉錄工作的完整狀態記錄"""

    job_id: str = Field(
        description="工作唯一識別碼（UUID v4）",
        examples=["550e8400-e29b-41d4-a716-446655440000"],
    )
    status: JobStatus = Field(
        description="工作狀態：pending / running / done / failed"
    )
    created_at: str = Field(
        description="工作建立時間（ISO 8601 UTC）",
        examples=["2026-03-11T10:00:00Z"],
    )
    updated_at: str = Field(
        description="最後更新時間（ISO 8601 UTC）",
        examples=["2026-03-11T10:08:30Z"],
    )
    audio_filename: str = Field(
        description="原始音訊檔名",
        examples=["meeting-2026-03-11.mp3"],
    )
    language: str = Field(
        description="指定的語言代碼",
        examples=["zh"],
    )
    device: str = Field(
        description="使用的運算裝置",
        examples=["cuda"],
    )
    num_speakers: Optional[int] = Field(
        default=None,
        description="指定的語者人數（null 表示自動偵測）",
        examples=[3],
    )
    add_punctuation: bool = Field(
        description="是否啟用標點補強"
    )
    model: str = Field(
        default=DEFAULT_WHISPER_MODEL,
        description="使用的 Whisper 模型名稱",
        examples=["large-v3"],
    )
    terms: List[str] = Field(
        default_factory=list,
        description="本次轉錄任務使用的專有名詞清單",
        examples=[["WhisperX", "NVIDIA", "Openclaw"]],
    )
    team: Optional[str] = Field(
        default=None,
        description="聲紋庫群組（Team 名稱，英文）",
        examples=["engineering"],
    )
    duration_seconds: Optional[float] = Field(
        default=None,
        description="音訊總時長（秒），完成後才有值",
        examples=[3600.0],
    )
    num_speakers_detected: Optional[int] = Field(
        default=None,
        description="實際偵測到的語者人數，完成後才有值",
        examples=[3],
    )
    output_path: Optional[str] = Field(
        default=None,
        description="容器內逐字稿檔案路徑（僅供參考）",
    )
    error: Optional[str] = Field(
        default=None,
        description="失敗時的錯誤訊息",
    )


class TranscribeResponse(BaseModel):
    """POST /transcribe 的回應"""

    job_id: str = Field(
        description="工作唯一識別碼，後續用此 ID 查詢狀態",
        examples=["550e8400-e29b-41d4-a716-446655440000"],
    )
    status: JobStatus = Field(
        description="初始狀態，固定為 pending"
    )
    message: str = Field(
        description="說明訊息",
        examples=["任務已建立，請使用 GET /jobs/{job_id} 查詢進度。"],
    )

class TermsLimitResponse(BaseModel):
    """GET /transcribe/terms-limit 的回應"""

    max_terms: int = Field(
        description="每次 POST /transcribe 可傳入的 terms 專有名詞數量上限",
        examples=[30],
    )
    warning: str = Field(
        description="超過上限時的風險說明",
        examples=["terms 過多會讓 ASR hotwords/prompt 變長，可能增加記憶體使用量並造成 OOM；請精簡本次任務真正需要的專有名詞。"],
    )


class JobListResponse(BaseModel):
    """GET /jobs 的回應"""

    total: int = Field(description="工作總數", examples=[5])
    jobs: List[JobRecord] = Field(description="工作清單（依建立時間倒序）")


class DeleteResponse(BaseModel):
    """DELETE /jobs/{job_id} 的回應"""

    message: str = Field(
        description="刪除結果說明",
        examples=["工作 550e8400-e29b-41d4-a716-446655440000 已刪除。"],
    )


class HealthResponse(BaseModel):
    """GET /health 的回應"""

    status: str = Field(description="服務狀態", examples=["ok"])
    gpu: bool = Field(description="是否偵測到 GPU")
    gpu_name: Optional[str] = Field(
        default=None,
        description="GPU 型號",
        examples=["NVIDIA GeForce RTX 3090"],
    )
    gpu_memory_gb: Optional[float] = Field(
        default=None,
        description="GPU 顯示記憶體（GB）",
        examples=[24.0],
    )
    hf_token_set: bool = Field(description="HF_TOKEN 是否已設定")
    punct_backend: str = Field(description="標點補強後端（funasr / deepmulti / none / auto）")


class ErrorResponse(BaseModel):
    """錯誤回應"""

    detail: str = Field(description="錯誤訊息", examples=["找不到工作 550e8400..."])


class SpeakerProfile(BaseModel):
    """已註冊的 Speaker 聲紋資訊"""

    name: str = Field(description="Speaker 名稱", examples=["Alice"])
    source_file: str = Field(description="註冊時使用的音檔名稱", examples=["alice.wav"])
    dim: int = Field(description="Embedding 向量維度", examples=[512])
    has_audio: bool = Field(default=False, description="是否有可試聽的聲紋音檔")


class SpeakerListResponse(BaseModel):
    """GET /speakers 的回應"""

    total: int = Field(description="已註冊 Speaker 人數", examples=[3])
    speakers: List[SpeakerProfile] = Field(description="Speaker 清單（依名稱排序）")


class EnrollResponse(BaseModel):
    """POST /speakers/{team}/enroll 的回應"""

    name: str = Field(description="已註冊的 Speaker 名稱", examples=["Alice"])
    message: str = Field(description="說明訊息", examples=["Speaker Alice 已在 Team engineering 中註冊成功。"])


class TeamListResponse(BaseModel):
    """GET /teams 的回應"""

    total: int = Field(description="已建立的 Team 數量", examples=[2])
    teams: List[str] = Field(description="Team 名稱清單（依字母排序）", examples=[["engineering", "sales"]])


# ---------------------------------------------------------------------------
# Job 讀寫工具
# ---------------------------------------------------------------------------

def _job_file(job_id: str) -> Path:
    return JOBS_DIR / f"{job_id}.json"


@contextmanager
def _db_connect():
    conn = sqlite3.connect(JOBS_DB, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    try:
        yield conn
    finally:
        conn.close()


def init_jobs_db():
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    with _jobs_lock, _db_connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                job_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                started_at TEXT,
                audio_filename TEXT NOT NULL,
                audio_path TEXT,
                language TEXT NOT NULL,
                device TEXT NOT NULL,
                model TEXT NOT NULL DEFAULT 'large-v3',
                num_speakers INTEGER,
                add_punctuation INTEGER NOT NULL,
                terms TEXT NOT NULL DEFAULT '',
                duration_seconds REAL,
                num_speakers_detected INTEGER,
                output_path TEXT,
                error TEXT
            )
            """
        )
        columns = [row["name"] for row in conn.execute("PRAGMA table_info(jobs)").fetchall()]
        if "terms" not in columns:
            conn.execute("ALTER TABLE jobs ADD COLUMN terms TEXT NOT NULL DEFAULT ''")
        if "model" not in columns:
            conn.execute("ALTER TABLE jobs ADD COLUMN model TEXT NOT NULL DEFAULT 'large-v3'")
        if "team" not in columns:
            conn.execute("ALTER TABLE jobs ADD COLUMN team TEXT")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at)")


def _validate_team_name(team: str) -> str:
    if not team or not TEAM_NAME_PATTERN.fullmatch(team):
        raise HTTPException(
            status_code=400,
            detail="team 名稱只能包含英文字母、數字、底線（_）和連字號（-）。",
        )
    return team


def _parse_terms_csv(value: Optional[str]) -> List[str]:
    if not value:
        return []
    return [term.strip() for term in value.split(",") if term.strip()]


def _validate_terms_csv(value: Optional[str]) -> List[str]:
    terms = _parse_terms_csv(value)
    if len(terms) > MAX_TERMS:
        raise HTTPException(
            status_code=422,
            detail=(
                f"terms cannot exceed {MAX_TERMS} terms. "
                "Too many terms can make ASR hotwords/prompt too large, increase memory usage, and may cause OOM. "
                "Please keep only the proper nouns needed for this transcription job."
            ),
        )
    seen = set()
    normalized = []
    for term in terms:
        if not NOUN_TERM_PATTERN.fullmatch(term):
            raise HTTPException(
                status_code=422,
                detail="terms can only contain letters, numbers, spaces, '_', '-', and '.'",
            )
        if term not in seen:
            seen.add(term)
            normalized.append(term)
    return normalized


def _terms_to_csv(terms: List[str]) -> str:
    return ", ".join(terms)


def _row_to_job(row: sqlite3.Row) -> JobRecord:
    keys = row.keys()
    return JobRecord(
        job_id=row["job_id"],
        status=JobStatus(row["status"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        audio_filename=row["audio_filename"],
        language=row["language"],
        device=row["device"],
        model=row["model"] if "model" in keys else DEFAULT_WHISPER_MODEL,
        num_speakers=row["num_speakers"],
        add_punctuation=bool(row["add_punctuation"]),
        terms=_parse_terms_csv(row["terms"] if "terms" in keys else ""),
        team=row["team"] if "team" in keys else None,
        duration_seconds=row["duration_seconds"],
        num_speakers_detected=row["num_speakers_detected"],
        output_path=row["output_path"],
        error=row["error"],
    )


def _record_values(record: JobRecord, audio_path: Optional[Path] = None) -> dict:
    return {
        "job_id": record.job_id,
        "status": record.status.value,
        "created_at": record.created_at,
        "updated_at": record.updated_at,
        "audio_filename": record.audio_filename,
        "audio_path": str(audio_path) if audio_path else None,
        "language": record.language,
        "device": record.device,
        "model": record.model,
        "num_speakers": record.num_speakers,
        "add_punctuation": 1 if record.add_punctuation else 0,
        "terms": _terms_to_csv(record.terms),
        "team": record.team,
        "duration_seconds": record.duration_seconds,
        "num_speakers_detected": record.num_speakers_detected,
        "output_path": record.output_path,
        "error": record.error,
    }


def enqueue_job(record: JobRecord, audio_path: Path):
    with _jobs_lock, _db_connect() as conn:
        conn.execute(
            """
            INSERT INTO jobs (
                job_id, status, created_at, updated_at, audio_filename, audio_path,
                language, device, model, num_speakers, add_punctuation, terms, team, duration_seconds,
                num_speakers_detected, output_path, error
            )
            VALUES (
                :job_id, :status, :created_at, :updated_at, :audio_filename, :audio_path,
                :language, :device, :model, :num_speakers, :add_punctuation, :terms, :team, :duration_seconds,
                :num_speakers_detected, :output_path, :error
            )
            """,
            _record_values(record, audio_path),
        )
    with _queue_cv:
        _queue_cv.notify()


def save_job(record: JobRecord):
    values = _record_values(record)
    values["started_at"] = _now_iso() if record.status == JobStatus.RUNNING else None
    with _jobs_lock, _db_connect() as conn:
        conn.execute(
            """
            UPDATE jobs
            SET status = :status,
                updated_at = :updated_at,
                started_at = COALESCE(started_at, :started_at),
                audio_filename = :audio_filename,
                language = :language,
                device = :device,
                model = :model,
                num_speakers = :num_speakers,
                add_punctuation = :add_punctuation,
                terms = :terms,
                team = :team,
                duration_seconds = :duration_seconds,
                num_speakers_detected = :num_speakers_detected,
                output_path = :output_path,
                error = :error
            WHERE job_id = :job_id
            """,
            values,
        )


def load_job(job_id: str) -> Optional[JobRecord]:
    with _jobs_lock, _db_connect() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
    return _row_to_job(row) if row else None


def list_jobs() -> List[JobRecord]:
    with _jobs_lock, _db_connect() as conn:
        rows = conn.execute("SELECT * FROM jobs ORDER BY created_at DESC").fetchall()
    return [_row_to_job(row) for row in rows]


def delete_job_record(job_id: str):
    with _jobs_lock, _db_connect() as conn:
        conn.execute("DELETE FROM jobs WHERE job_id = ?", (job_id,))


def _mark_stale_running_failed(conn: sqlite3.Connection, now: str):
    timeout_cutoff = (datetime.utcnow() - timedelta(seconds=JOB_TIMEOUT_SECONDS)).isoformat() + "Z"
    conn.execute(
        """
        UPDATE jobs
        SET status = ?, updated_at = ?, error = ?
        WHERE status = ? AND started_at IS NOT NULL AND started_at < ?
        """,
        (
            JobStatus.FAILED.value,
            now,
            f"Job exceeded timeout of {JOB_TIMEOUT_SECONDS} seconds.",
            JobStatus.RUNNING.value,
            timeout_cutoff,
        ),
    )


def _claim_next_job() -> Optional[tuple[JobRecord, Path]]:
    now = _now_iso()
    with _jobs_lock, _db_connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            _mark_stale_running_failed(conn, now)
            running_count = conn.execute(
                "SELECT COUNT(*) FROM jobs WHERE status = ?",
                (JobStatus.RUNNING.value,),
            ).fetchone()[0]
            if running_count:
                conn.execute("COMMIT")
                return None

            row = conn.execute(
                "SELECT * FROM jobs WHERE status = ? ORDER BY created_at LIMIT 1",
                (JobStatus.PENDING.value,),
            ).fetchone()
            if not row:
                conn.execute("COMMIT")
                return None
            if not row["audio_path"]:
                conn.execute(
                    "UPDATE jobs SET status = ?, updated_at = ?, error = ? WHERE job_id = ?",
                    (
                        JobStatus.FAILED.value,
                        now,
                        "Queued audio path is missing; this legacy job cannot be resumed.",
                        row["job_id"],
                    ),
                )
                conn.execute("COMMIT")
                return None

            conn.execute(
                "UPDATE jobs SET status = ?, updated_at = ?, started_at = ?, error = NULL WHERE job_id = ?",
                (JobStatus.RUNNING.value, now, now, row["job_id"]),
            )
            row = conn.execute("SELECT * FROM jobs WHERE job_id = ?", (row["job_id"],)).fetchone()
            conn.execute("COMMIT")
            return _row_to_job(row), Path(row["audio_path"])
        except Exception:
            conn.execute("ROLLBACK")
            raise


def _migrate_json_jobs():
    for f in JOBS_DIR.glob("*.json"):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            record = JobRecord(**data)
            with _jobs_lock, _db_connect() as conn:
                exists = conn.execute("SELECT 1 FROM jobs WHERE job_id = ?", (record.job_id,)).fetchone()
                if exists:
                    continue
                conn.execute(
                    """
                    INSERT INTO jobs (
                        job_id, status, created_at, updated_at, audio_filename, audio_path,
                        language, device, model, num_speakers, add_punctuation, terms, duration_seconds,
                        num_speakers_detected, output_path, error
                    )
                    VALUES (
                        :job_id, :status, :created_at, :updated_at, :audio_filename, :audio_path,
                        :language, :device, :model, :num_speakers, :add_punctuation, :terms, :duration_seconds,
                        :num_speakers_detected, :output_path, :error
                    )
                    """,
                    _record_values(record),
                )
        except Exception:
            pass


def _recover_interrupted_jobs():
    now = _now_iso()
    with _jobs_lock, _db_connect() as conn:
        conn.execute(
            """
            UPDATE jobs
            SET status = ?, updated_at = ?, started_at = NULL, error = NULL
            WHERE status = ?
            """,
            (JobStatus.PENDING.value, now, JobStatus.RUNNING.value),
        )


def _job_worker_loop():
    while not _worker_stop.is_set():
        claimed = _claim_next_job()
        if claimed:
            record, audio_path = claimed
            _run_transcription(record.job_id, audio_path, record)
            with _queue_cv:
                _queue_cv.notify_all()
            continue
        with _queue_cv:
            _queue_cv.wait(timeout=5)


def start_job_worker():
    global _worker_thread
    if _worker_thread and _worker_thread.is_alive():
        return
    _worker_stop.clear()
    _worker_thread = threading.Thread(target=_job_worker_loop, name="transcription-queue-worker", daemon=True)
    _worker_thread.start()


def stop_job_worker():
    _worker_stop.set()
    with _queue_cv:
        _queue_cv.notify_all()
    if _worker_thread and _worker_thread.is_alive():
        _worker_thread.join(timeout=10)


def _now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


# ---------------------------------------------------------------------------
# 核心轉錄邏輯（呼叫 transcribe_diarize.py）
# ---------------------------------------------------------------------------

def _parse_md_metadata(transcript_path: Path) -> tuple:
    """從 Markdown 逐字稿標頭解析 (duration_seconds, num_speakers)。"""
    duration_seconds = None
    num_speakers = None
    try:
        for line in transcript_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("**總時長:**"):
                ts = line.split("**總時長:**")[-1].strip()
                parts = ts.split(":")
                if len(parts) == 3:
                    duration_seconds = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
            elif line.startswith("**語者人數:**"):
                num_speakers = int(line.split("**語者人數:**")[-1].strip())
    except Exception:
        pass
    return duration_seconds, num_speakers


def _run_transcription(job_id: str, audio_path: Path, record: JobRecord):
    """以獨立 subprocess 執行轉錄，結束後 GPU 記憶體完全釋放。"""
    import subprocess

    record.status = JobStatus.RUNNING
    record.updated_at = _now_iso()
    save_job(record)

    script_path = Path(__file__).parent / "transcribe_diarize.py"
    # subprocess 輸出到 OUTPUT_DIR/job_id，
    # transcribe_diarize.py 會在其下建立 <stem>/<stem>_逐字稿.md
    out_base = OUTPUT_DIR / job_id
    out_base.mkdir(parents=True, exist_ok=True)

    cmd = [
        sys.executable, str(script_path),
        str(audio_path),
        "--output-dir", str(out_base),
        "--lang", record.language,
        "--device", record.device,
        "--model", record.model,
    ]
    if record.num_speakers:
        cmd += ["--num-speakers", str(record.num_speakers)]
    if record.terms:
        cmd += ["--terms", _terms_to_csv(record.terms)]
    if not record.add_punctuation:
        cmd.append("--no-punctuation")
    if record.team:
        team_dir = SPEAKER_DIR / record.team
        if team_dir.exists() and any(team_dir.glob("*.json")):
            cmd += ["--speaker-dir", str(team_dir)]

    log_path = out_base / "subprocess.log"

    # 若在 Popen 之前就收到 DELETE，直接放棄
    with _procs_lock:
        if job_id in _pending_cancels:
            _pending_cancels.discard(job_id)
            raise RuntimeError("Job was cancelled before subprocess started.")

    print(f"[{job_id}] 啟動 subprocess: {' '.join(cmd)}", flush=True)

    try:
        with open(log_path, "w", encoding="utf-8") as log_f:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                env=os.environ.copy(),
                start_new_session=True,
            )
            # 登記後立即檢查是否在 Popen 期間收到 DELETE
            with _procs_lock:
                if job_id in _pending_cancels:
                    _pending_cancels.discard(job_id)
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                        print(f"[{job_id}] 已於啟動後立即 kill（race-cancel），pgid={proc.pid}", flush=True)
                    except (ProcessLookupError, OSError) as e:
                        print(f"[{job_id}] killpg race-cancel 失敗: {e}", flush=True)
                    raise RuntimeError("Job was cancelled during subprocess startup.")
                _active_procs[job_id] = proc
                print(f"[{job_id}] subprocess 已登記，pid={proc.pid}", flush=True)

            _verbose = os.environ.get("VERBOSE_LOGS", "1").lower() in ("1", "true", "yes")

            def _tee():
                for line in proc.stdout:
                    if _verbose:
                        sys.stdout.write(f"[{job_id}] {line}")
                        sys.stdout.flush()
                    log_f.write(line)
                    log_f.flush()

            tee_thread = threading.Thread(target=_tee, daemon=True)
            tee_thread.start()
            try:
                proc.wait(timeout=JOB_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except (ProcessLookupError, OSError):
                    pass
                tee_thread.join(timeout=5)
                raise
            tee_thread.join()

        print(f"[{job_id}] subprocess 結束，returncode={proc.returncode}", flush=True)

        if proc.returncode != 0:
            last_lines = log_path.read_text(encoding="utf-8", errors="replace")[-1000:]
            raise RuntimeError(f"subprocess 退出碼 {proc.returncode}\n{last_lines}")

        # transcribe_diarize.py 輸出路徑：<out_base>/<stem>/<stem>_逐字稿.md
        transcript_path = out_base / audio_path.stem / f"{audio_path.stem}_逐字稿.md"
        if not transcript_path.exists():
            raise RuntimeError(f"找不到輸出檔案：{transcript_path}")

        duration_seconds, num_speakers_detected = _parse_md_metadata(transcript_path)

        record.status = JobStatus.DONE
        record.output_path = str(transcript_path)
        record.duration_seconds = duration_seconds
        record.num_speakers_detected = num_speakers_detected
        record.updated_at = _now_iso()

    except subprocess.TimeoutExpired:
        record.status = JobStatus.FAILED
        record.error = f"Job exceeded timeout of {JOB_TIMEOUT_SECONDS} seconds."
        record.updated_at = _now_iso()

    except Exception as e:
        record.status = JobStatus.FAILED
        record.error = str(e)
        record.updated_at = _now_iso()

    finally:
        with _procs_lock:
            _active_procs.pop(job_id, None)
            _pending_cancels.discard(job_id)
        try:
            audio_path.unlink(missing_ok=True)
        except Exception:
            pass
        save_job(record)


# ---------------------------------------------------------------------------
# FastAPI 應用
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """啟動時清理過期工作"""
    init_jobs_db()
    _migrate_json_jobs()
    _recover_interrupted_jobs()
    cutoff = datetime.utcnow() - timedelta(hours=JOB_TTL_HOURS)
    for record in list_jobs():
        try:
            created = datetime.fromisoformat(record.created_at.rstrip("Z"))
            if created < cutoff:
                out_dir = OUTPUT_DIR / record.job_id
                if out_dir.exists():
                    shutil.rmtree(out_dir, ignore_errors=True)
                delete_job_record(record.job_id)
        except Exception:
            pass
    start_job_worker()
    try:
        yield
    finally:
        stop_job_worker()


ALLOWED_ENROLL_EXTENSIONS = {".mp3", ".mp4", ".wav", ".m4a", ".ogg", ".flac", ".webm", ".aac"}

app = FastAPI(
    title="WhisperX 語音轉錄 API",
    description="""
## 概述

將音訊上傳後，由後端以 WhisperX 進行：
1. **語音辨識**（Whisper large-v3）
2. **詞對齊**（force alignment）
3. **語者分離**（Pyannote speaker diarization）
4. **標點補強**（Groq API，可選）

最終輸出帶有時間戳記與語者標籤的 **Markdown 逐字稿**。

## 認證

請在所有請求的 Header 中帶入：
```
X-API-Key: <your-api-key>
```
若服務端未設定 `API_KEY` 環境變數，則不需認證。

## 非同步流程

```
POST /transcribe → 取得 job_id
       ↓
GET /jobs/{job_id}  （每 15 秒輪詢）
       ↓ status == "done"
GET /jobs/{job_id}/result  → 下載 Markdown
```
""",
    version="1.0.0",
    openapi_tags=[
        {"name": "轉錄", "description": "提交音訊並管理轉錄任務"},
        {"name": "工作管理", "description": "查詢、列出、刪除工作"},
        {"name": "聲紋庫", "description": "Speaker 聲紋註冊與管理"},
        {"name": "系統", "description": "健康檢查與服務狀態"},
    ],
    lifespan=lifespan,
)


# ---- 驗證 ----

def verify_api_key(x_api_key: Optional[str] = Header(default=None, description="API 金鑰")):
    if not API_KEY:
        return
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key header.")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get(
    "/health",
    tags=["系統"],
    summary="服務健康檢查",
    description="回傳服務狀態、GPU 資訊及必要環境變數的設定情況。此端點不需認證。",
    response_model=HealthResponse,
)
def health():
    info: dict = {"status": "ok", "gpu": False, "gpu_name": None, "gpu_memory_gb": None}
    try:
        import torch
        if torch.cuda.is_available():
            info["gpu"] = True
            info["gpu_name"] = torch.cuda.get_device_name(0)
            info["gpu_memory_gb"] = round(
                torch.cuda.get_device_properties(0).total_memory / 1e9, 1
            )
    except Exception:
        pass
    info["hf_token_set"] = bool(os.environ.get("HF_TOKEN"))
    info["punct_backend"] = os.environ.get("PUNCT_BACKEND", "auto")
    return info


@app.get(
    "/transcribe/terms-limit",
    tags=["頧?"],
    summary="查詢每次轉錄可傳入的 terms 上限",
    description="回傳 POST /transcribe 的 terms 專有名詞數量上限。超過上限會回傳 422，避免 hotwords/prompt 過長造成記憶體壓力或 OOM。",
    response_model=TermsLimitResponse,
    responses={
        200: {"description": "terms 上限與風險說明", "model": TermsLimitResponse},
        401: {"description": "API Key ?航炊", "model": ErrorResponse},
    },
    dependencies=[Depends(verify_api_key)],
)
def get_terms_limit():
    return TermsLimitResponse(
        max_terms=MAX_TERMS,
        warning=(
            "terms 過多會讓 ASR hotwords/prompt 變長，可能增加記憶體使用量並造成 OOM；"
            "請精簡本次任務真正需要的專有名詞。"
        ),
    )


@app.post(
    "/transcribe",
    tags=["轉錄"],
    summary="上傳音訊，啟動轉錄任務",
    description="""
上傳音訊檔案後，服務立即回傳 `job_id`（HTTP 202），轉錄在背景非同步執行。

**支援格式**：mp3、mp4、wav、m4a、ogg、flac、webm、aac

**注意**：由於 GPU 記憶體限制，同一時間只處理一個任務，多個請求會依序排隊執行。
""",
    response_model=TranscribeResponse,
    status_code=202,
    responses={
        202: {"description": "任務已建立", "model": TranscribeResponse},
        400: {"description": "檔案格式錯誤或檔案為空", "model": ErrorResponse},
        401: {"description": "API Key 錯誤", "model": ErrorResponse},
        413: {"description": "檔案超過大小限制", "model": ErrorResponse},
        422: {"description": "terms 數量超過上限或格式錯誤，可能造成 hotwords/prompt 過長與 OOM 風險", "model": ErrorResponse},
    },
    dependencies=[Depends(verify_api_key)],
)
async def transcribe(
    audio: UploadFile = File(
        ...,
        description="音訊檔（mp3 / wav / m4a / mp4 / ogg / flac / webm / aac）",
    ),
    lang: str = Form(
        default="zh",
        description="語言代碼。常用值：`zh`（繁/簡中）、`en`（英）、`ja`（日）、`auto`（自動偵測）",
    ),
    device: str = Form(
        default="auto",
        description="運算裝置。`auto` 會自動選擇 cuda > mps > cpu",
    ),
    num_speakers: Optional[int] = Form(
        default=None,
        description="預先指定語者人數（1–10）。不填則由 Pyannote 自動偵測，建議在已知人數時填入以提升準確率",
        ge=1,
        le=10,
    ),
    no_punctuation: bool = Form(
        default=False,
        description="設為 `true` 可跳過 Groq 標點補強（加快速度，但輸出無標點）",
    ),
    terms: Optional[str] = Form(
        default=None,
        description="本次轉錄任務使用的專有名詞，多個詞以逗點分隔，可不填。例如：WhisperX, NVIDIA, Openclaw",
    ),
    model: str = Form(
        default=DEFAULT_WHISPER_MODEL,
        description=f"Whisper 模型名稱（預設：{DEFAULT_WHISPER_MODEL}）。可選：{', '.join(WHISPER_MODELS)}",
    ),
    team: Optional[str] = Form(
        default=None,
        description="聲紋庫群組名稱（英文，含英數字、底線、連字號）。不填則不使用聲紋比對。例如：engineering",
    ),
):
    if model not in WHISPER_MODELS:
        raise HTTPException(
            status_code=422,
            detail=f"不支援的模型：{model}。可選：{', '.join(WHISPER_MODELS)}",
        )

    suffix = Path(audio.filename or "").suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"不支援的檔案格式：{suffix or '（無副檔名）'}。支援：{', '.join(sorted(ALLOWED_EXTENSIONS))}",
        )

    parsed_terms = _validate_terms_csv(terms)
    if team:
        _validate_team_name(team)

    job_id = str(uuid.uuid4())
    upload_path = UPLOAD_DIR / f"{job_id}{suffix}"

    chunk_size = 1024 * 1024
    total = 0
    max_bytes = MAX_FILE_MB * 1024 * 1024
    with open(upload_path, "wb") as f:
        while chunk := await audio.read(chunk_size):
            total += len(chunk)
            if total > max_bytes:
                upload_path.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=413,
                    detail=f"檔案超過上限 {MAX_FILE_MB} MB。",
                )
            f.write(chunk)

    if total == 0:
        upload_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="上傳檔案為空。")

    record = JobRecord(
        job_id=job_id,
        status=JobStatus.PENDING,
        created_at=_now_iso(),
        updated_at=_now_iso(),
        audio_filename=audio.filename or upload_path.name,
        language=lang,
        device=device,
        model=model,
        num_speakers=num_speakers,
        add_punctuation=not no_punctuation,
        terms=parsed_terms,
        team=team,
    )
    enqueue_job(record, upload_path)

    return JSONResponse(
        status_code=202,
        content=TranscribeResponse(
            job_id=job_id,
            status=JobStatus.PENDING,
            message="任務已建立，請使用 GET /jobs/{job_id} 查詢進度。",
        ).model_dump(),
    )


@app.get(
    "/jobs/{job_id}",
    tags=["工作管理"],
    summary="查詢工作狀態",
    description="""
回傳工作的完整狀態記錄。建議每 **15 秒**輪詢一次。

**狀態說明**：
- `pending`：排隊等待中
- `running`：轉錄進行中
- `done`：完成，可呼叫 `/jobs/{job_id}/result` 下載逐字稿
- `failed`：失敗，錯誤訊息在 `error` 欄位
""",
    response_model=JobRecord,
    responses={
        200: {"description": "工作狀態", "model": JobRecord},
        401: {"description": "API Key 錯誤", "model": ErrorResponse},
        404: {"description": "找不到工作", "model": ErrorResponse},
    },
    dependencies=[Depends(verify_api_key)],
)
def get_job(job_id: str):
    record = load_job(job_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"找不到工作 {job_id}")
    return record


@app.get(
    "/jobs/{job_id}/result",
    tags=["工作管理"],
    summary="下載逐字稿 Markdown",
    description="""
工作狀態為 `done` 時，下載帶有時間戳記與語者標籤的 Markdown 逐字稿。

**回應格式**：`text/markdown; charset=utf-8`（檔案下載）

**逐字稿格式範例**：
```markdown
# 逐字稿 - meeting-2026-03-11

**語言:** zh
**總時長:** 01:00:00
**語者人數:** 3

---

**[00:00:05 → 00:00:32] Speaker 1:**
大家好，今天我們來討論第一季的業績報告。

**[00:00:33 → 00:01:10] Speaker 2:**
好的，根據數據顯示，本季營收成長了 15%。
```
""",
    responses={
        200: {"description": "Markdown 逐字稿檔案", "content": {"text/markdown": {}}},
        401: {"description": "API Key 錯誤", "model": ErrorResponse},
        404: {"description": "找不到工作", "model": ErrorResponse},
        409: {"description": "工作尚未完成", "model": ErrorResponse},
        410: {"description": "逐字稿檔案已被刪除", "model": ErrorResponse},
    },
    dependencies=[Depends(verify_api_key)],
)
def get_result(job_id: str):
    record = load_job(job_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"找不到工作 {job_id}")
    if record.status != JobStatus.DONE:
        raise HTTPException(
            status_code=409,
            detail=f"工作尚未完成（目前狀態：{record.status}）。",
        )
    path = Path(record.output_path)
    if not path.exists():
        raise HTTPException(status_code=410, detail="逐字稿檔案已被刪除。")
    return FileResponse(
        path=str(path),
        media_type="text/markdown; charset=utf-8",
        filename=path.name,
    )


@app.delete(
    "/jobs/{job_id}",
    tags=["工作管理"],
    summary="刪除工作",
    description="刪除工作記錄及對應的逐字稿輸出目錄，釋放磁碟空間。",
    response_model=DeleteResponse,
    responses={
        200: {"description": "刪除成功", "model": DeleteResponse},
        401: {"description": "API Key 錯誤", "model": ErrorResponse},
        404: {"description": "找不到工作", "model": ErrorResponse},
    },
    dependencies=[Depends(verify_api_key)],
)
def delete_job(job_id: str):
    record = load_job(job_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"找不到工作 {job_id}")

    with _procs_lock:
        proc = _active_procs.pop(job_id, None)
        if proc is None and record.status == JobStatus.RUNNING:
            _pending_cancels.add(job_id)
            print(f"[{job_id}] DELETE 到達時 proc 尚未登記，加入 pending_cancels", flush=True)

    if proc is not None:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
            print(f"[{job_id}] killpg({proc.pid}, SIGKILL) 已送出", flush=True)
        except (ProcessLookupError, OSError) as e:
            print(f"[{job_id}] killpg 失敗: {e}", flush=True)

    delete_job_record(job_id)
    out_dir = OUTPUT_DIR / job_id
    if out_dir.exists():
        shutil.rmtree(out_dir, ignore_errors=True)

    return DeleteResponse(message=f"工作 {job_id} 已刪除。")


@app.get(
    "/jobs",
    tags=["工作管理"],
    summary="列出所有工作",
    description="""
列出所有工作，依建立時間倒序排列。可用 `status` 參數篩選。

**status 可用值**：`pending`、`running`、`done`、`failed`
""",
    response_model=JobListResponse,
    responses={
        200: {"description": "工作清單", "model": JobListResponse},
        401: {"description": "API Key 錯誤", "model": ErrorResponse},
    },
    dependencies=[Depends(verify_api_key)],
)
def list_all_jobs(
    status: Optional[str] = None,
):
    records = list_jobs()
    if status:
        records = [r for r in records if r.status == status]
    return JobListResponse(total=len(records), jobs=records)


# ---------------------------------------------------------------------------
# 聲紋庫 Routes
# ---------------------------------------------------------------------------

@app.get(
    "/teams",
    tags=["聲紋庫"],
    summary="列出所有 Team",
    description="列出聲紋庫中所有已建立的 Team（即 SPEAKER_DIR 下的子資料夾）。",
    response_model=TeamListResponse,
    responses={
        200: {"description": "Team 清單", "model": TeamListResponse},
        401: {"description": "API Key 錯誤", "model": ErrorResponse},
    },
    dependencies=[Depends(verify_api_key)],
)
def list_teams():
    if not SPEAKER_DIR.exists():
        return TeamListResponse(total=0, teams=[])
    teams = sorted([d.name for d in SPEAKER_DIR.iterdir() if d.is_dir()])
    return TeamListResponse(total=len(teams), teams=teams)


@app.post(
    "/speakers/{team}/enroll",
    tags=["聲紋庫"],
    summary="註冊 Speaker 聲紋（含 Team）",
    description="""
上傳 **10–15 秒**單人錄音，提取聲紋 embedding 並存入指定 Team 的聲紋庫。

- `team` 名稱只能包含英文字母、數字、底線（`_`）和連字號（`-`）。
- 同一 Team 下的聲紋彼此隔離，不同 Team 間不共用。
- 後續轉錄任務帶入相同 `team` 參數時，將自動比對該 Team 的聲紋庫。

**建議錄音條件**：
- 安靜環境、清晰發音
- 10–15 秒（太短會影響準確率）
- 與實際會議使用的麥克風相同或相近

**注意**：若在同一 Team 下使用相同 Speaker 名稱重複上傳，將**覆蓋**既有聲紋資料。
""",
    response_model=EnrollResponse,
    status_code=201,
    responses={
        201: {"description": "註冊成功", "model": EnrollResponse},
        400: {"description": "檔案格式錯誤、名稱無效或 team 名稱非英文", "model": ErrorResponse},
        401: {"description": "API Key 錯誤", "model": ErrorResponse},
        500: {"description": "聲紋提取失敗（HF_TOKEN 未設定或模型載入失敗）", "model": ErrorResponse},
    },
    dependencies=[Depends(verify_api_key)],
)
async def enroll_speaker(
    team: str,
    audio: UploadFile = File(
        ...,
        description="10–15 秒單人錄音（wav / mp3 / m4a 等）",
    ),
    name: str = Form(
        ...,
        description="Speaker 名稱（英文或中文，不含 / \\ . 等特殊字元）",
        examples=["Alice"],
    ),
    device: str = Form(
        default="auto",
        description="提取 embedding 使用的裝置（auto / cpu / cuda）",
    ),
):
    _validate_team_name(team)

    import re as _re
    if not name or not _re.match(r'^[\w一-鿿\- ]+$', name):
        raise HTTPException(
            status_code=400,
            detail="名稱無效：僅允許英數字、中文、底線、連字號、空格。",
        )

    suffix = Path(audio.filename or "").suffix.lower()
    if suffix not in ALLOWED_ENROLL_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"不支援的格式：{suffix}。支援：{', '.join(sorted(ALLOWED_ENROLL_EXTENSIONS))}",
        )

    hf_token = os.environ.get("HF_TOKEN", "")
    if not hf_token:
        raise HTTPException(status_code=500, detail="HF_TOKEN 未設定，無法載入 pyannote/embedding 模型。")

    team_dir = SPEAKER_DIR / team
    team_dir.mkdir(parents=True, exist_ok=True)

    enroll_path = UPLOAD_DIR / f"enroll_{team}_{name}{suffix}"
    content = await audio.read()
    if not content:
        raise HTTPException(status_code=400, detail="上傳檔案為空。")
    enroll_path.write_bytes(content)

    try:
        resolved_device = device
        if device == "auto":
            try:
                import torch
                resolved_device = "cuda" if torch.cuda.is_available() else "cpu"
            except ImportError:
                resolved_device = "cpu"

        old_profile_path = team_dir / f"{name}.json"
        if old_profile_path.exists():
            try:
                old_data = json.loads(old_profile_path.read_text(encoding="utf-8"))
                old_audio = old_data.get("source_file", "")
                if old_audio:
                    (team_dir / old_audio).unlink(missing_ok=True)
            except Exception:
                pass

        from speaker_db import enroll_speaker as _enroll
        _enroll(
            name=name,
            audio_path=enroll_path,
            speaker_dir=team_dir,
            hf_token=hf_token,
            device=resolved_device,
        )

        audio_dest = team_dir / f"{name}{suffix}"
        shutil.move(str(enroll_path), str(audio_dest))

        profile_path = team_dir / f"{name}.json"
        profile_data = json.loads(profile_path.read_text(encoding="utf-8"))
        profile_data["source_file"] = audio_dest.name
        profile_path.write_text(json.dumps(profile_data, ensure_ascii=False, indent=2), encoding="utf-8")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"聲紋提取失敗：{e}")
    finally:
        enroll_path.unlink(missing_ok=True)

    return JSONResponse(
        status_code=201,
        content=EnrollResponse(
            name=name,
            message=f"Speaker {name} 已在 Team {team} 中註冊成功。",
        ).model_dump(),
    )


@app.get(
    "/speakers/{team}",
    tags=["聲紋庫"],
    summary="列出 Team 內已註冊的 Speaker",
    description="列出指定 Team 聲紋庫中所有已註冊的 Speaker（不含 embedding 向量）。",
    response_model=SpeakerListResponse,
    responses={
        200: {"description": "Speaker 清單", "model": SpeakerListResponse},
        400: {"description": "team 名稱格式錯誤", "model": ErrorResponse},
        401: {"description": "API Key 錯誤", "model": ErrorResponse},
    },
    dependencies=[Depends(verify_api_key)],
)
def list_speakers(team: str):
    _validate_team_name(team)
    from speaker_db import list_speaker_profiles
    speakers = list_speaker_profiles(SPEAKER_DIR / team)
    return SpeakerListResponse(total=len(speakers), speakers=speakers)


_AUDIO_MEDIA_TYPES = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".webm": "audio/webm",
    ".aac": "audio/aac",
    ".mp4": "audio/mp4",
}


@app.get(
    "/speakers/{team}/{name}/audio",
    tags=["聲紋庫"],
    summary="試聽 Speaker 聲紋音檔",
    description="串流播放指定 Team 中 Speaker 註冊時上傳的聲紋音檔，供前端試聽使用。",
    responses={
        200: {"description": "音訊串流", "content": {"audio/*": {}}},
        400: {"description": "team 名稱格式錯誤", "model": ErrorResponse},
        401: {"description": "API Key 錯誤", "model": ErrorResponse},
        404: {"description": "找不到 Speaker 或無音檔", "model": ErrorResponse},
    },
    dependencies=[Depends(verify_api_key)],
)
def get_speaker_audio(team: str, name: str):
    _validate_team_name(team)
    team_dir = SPEAKER_DIR / team
    profile_path = team_dir / f"{name}.json"
    if not profile_path.exists():
        raise HTTPException(status_code=404, detail=f"找不到 Speaker：{name}（Team：{team}）")

    try:
        data = json.loads(profile_path.read_text(encoding="utf-8"))
    except Exception:
        raise HTTPException(status_code=500, detail="讀取聲紋資料失敗。")

    source_file = data.get("source_file", "")
    audio_path = team_dir / source_file if source_file else None
    if not source_file or not audio_path.exists():
        raise HTTPException(status_code=404, detail=f"Speaker {name} 沒有可試聽的音檔。")

    media_type = _AUDIO_MEDIA_TYPES.get(audio_path.suffix.lower(), "application/octet-stream")
    return FileResponse(path=audio_path, media_type=media_type, filename=source_file)


@app.delete(
    "/speakers/{team}/{name}",
    tags=["聲紋庫"],
    summary="刪除 Speaker 聲紋",
    description="從指定 Team 的聲紋庫中移除指定 Speaker 的聲紋資料。",
    response_model=DeleteResponse,
    responses={
        200: {"description": "刪除成功", "model": DeleteResponse},
        400: {"description": "team 名稱格式錯誤", "model": ErrorResponse},
        401: {"description": "API Key 錯誤", "model": ErrorResponse},
        404: {"description": "找不到 Speaker", "model": ErrorResponse},
    },
    dependencies=[Depends(verify_api_key)],
)
def delete_speaker(team: str, name: str):
    _validate_team_name(team)
    from speaker_db import delete_speaker as _delete
    if not _delete(name, SPEAKER_DIR / team):
        raise HTTPException(status_code=404, detail=f"找不到 Speaker：{name}（Team：{team}）")
    return DeleteResponse(message=f"Speaker {name} 已從 Team {team} 的聲紋庫刪除。")

# ---------------------------------------------------------------------------
# 自訂 OpenAPI schema，補上 API Key security scheme
# ---------------------------------------------------------------------------

def custom_openapi():
    if app.openapi_schema:
        return app.openapi_schema
    schema = get_openapi(
        title=app.title,
        version=app.version,
        description=app.description,
        routes=app.routes,
        tags=app.openapi_tags,
    )
    schema["components"]["securitySchemes"] = {
        "ApiKeyAuth": {
            "type": "apiKey",
            "in": "header",
            "name": "X-API-Key",
            "description": "使用環境變數 API_KEY 設定的 API key。",
        }
    }
    schema["security"] = [{"ApiKeyAuth": []}]
    app.openapi_schema = schema
    return schema


app.openapi = custom_openapi


# 直接執行
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "transcribe_api:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8000")),
        workers=1,
        log_level="info",
    )
