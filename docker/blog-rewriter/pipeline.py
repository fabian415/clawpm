import base64
import datetime
import os
import tempfile

from llm import initialize_llm, invoke_llm
from utilty_prompt import load_prompt_template
from image_gen_azure import generate_image
import utilty_article

LLM_NAME = os.environ.get("LLM_NAME", "azure-gpt-4.1")

_llm_instance = None


def _get_llm():
    global _llm_instance
    if _llm_instance is None:
        _llm_instance = initialize_llm(LLM_NAME)
    return _llm_instance


def _generate_feature_image_base64(image_prompt: str) -> str:
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    tmp_path = tmp.name
    tmp.close()
    try:
        generate_image(image_prompt, tmp_path)
        with open(tmp_path, "rb") as f:
            return base64.b64encode(f.read()).decode("ascii")
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def run_pipeline(source_text: str) -> dict:
    """
    把一篇技術文章（markdown 純文字）改寫成中/英部落格草稿 + 封面圖。
    回傳的 content_zh / content_en 已經是最終的 index.md / index.en.md 內容
    （含 Hugo frontmatter、免責聲明、圖片路徑已轉換為本地檔名）。
    """
    llm = _get_llm()
    timestamp = datetime.datetime.now()

    rewrite_prompt_template = load_prompt_template("rewriter_prompt.txt")
    translate_prompt_template = load_prompt_template("translate_to_en_prompt.txt")
    meta_prompt_template = load_prompt_template("meta_prompt.txt")

    # 1. 改寫成部落格語氣（繁中）
    rewritten_text = invoke_llm(llm, rewrite_prompt_template, source_text)

    # 2. 翻譯成英文
    translated_text = invoke_llm(llm, translate_prompt_template, rewritten_text)

    # 3. 分類 / 標籤 / 封面圖 prompt
    meta_response = invoke_llm(llm, meta_prompt_template, translated_text)
    meta_json = utilty_article.parse_meta_response(meta_response) or {}

    # 4. 拆出標題與內文
    title_zh, content_zh = utilty_article.parse_rewritten_text(rewritten_text)
    title_en, content_en = utilty_article.parse_rewritten_text(translated_text)

    # 5. 加上免責聲明
    content_zh = utilty_article.add_disclaimer_block(content_zh, "disclaimer_zh.txt")
    content_en = utilty_article.add_disclaimer_block(content_en, "disclaimer_en.txt")

    # 6. 加上 Hugo frontmatter
    content_zh = utilty_article.add_hugo_header(title_zh, content_zh, timestamp, meta_json)
    content_en = utilty_article.add_hugo_header(title_en, content_en, timestamp, meta_json)

    # 7. 圖片路徑轉換（改成本地檔名）。這個服務沒有 workspace 檔案系統的存取權，
    # 內文圖片原本大多是相對於來源技術文章的本地路徑（例如 ../_assets/xxx.png），
    # 不是可公開下載的網址，所以這裡只回傳 (原始路徑, 新檔名) 對照表，
    # 實際「從本地複製」或「真的是外部網址才下載」交給呼叫端（有 workspace 存取權）處理。
    content_zh, images_map = utilty_article.convert_image_path(content_zh)
    content_en, _ = utilty_article.convert_image_path(content_en)

    image_map = [{"original_path": orig_path, "filename": new_name} for orig_path, new_name in images_map]

    # 8. 封面圖（失敗或逾時不應讓整篇文章跟著失敗，草稿先出來，圖片之後可以再補）
    image_prompt = meta_json.get("image_prompt", "")
    feature_image_base64 = None
    if image_prompt:
        try:
            feature_image_base64 = _generate_feature_image_base64(image_prompt)
        except Exception as e:
            print(f"[pipeline] feature image generation failed: {e}")

    return {
        "title_zh": title_zh,
        "content_zh": content_zh,
        "title_en": title_en,
        "content_en": content_en,
        "meta": meta_json,
        "feature_image_base64": feature_image_base64,
        "image_map": image_map,
    }
