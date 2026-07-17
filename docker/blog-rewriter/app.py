from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from pipeline import run_pipeline

app = FastAPI(title="clawpm-blog-rewriter")


class RewriteRequest(BaseModel):
    source_text: str


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/rewrite")
def rewrite(req: RewriteRequest):
    if not req.source_text or not req.source_text.strip():
        raise HTTPException(status_code=400, detail="source_text is required")
    try:
        return run_pipeline(req.source_text)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
