from pathlib import Path
from typing import Any


def load_prompt_template(path: str | Path) -> str:
    """讀指定檔案，回傳字串（不做任何處理）。"""
    return Path(path).read_text(encoding="utf-8")


def build_prompt(template: str, **vars: Any) -> str:
    """
    使用 ``str.format()`` 將變數填入模板。
    - 未提供的佔位符會觸發 `KeyError`，可在呼叫端自行 try/except。
    - 若模板中有字面大括號而**不想被替換**，請寫成 `{{` / `}}`。

    範例：
        prompt = build_prompt(tmpl, input_text=article, author="Ada")
    """
    return template.format(**vars)
