# llm_client.py
"""
當前支援：
  • OpenAI ChatCompletion
  • Azure OpenAI ChatCompletion
  • Google Gemini (Vertex AI)
"""
from typing import Literal
import os
from openai import OpenAI, AzureOpenAI
try:
    import google.generativeai as genai
except ImportError:
    genai = None


class LLMClient:
    def __init__(self, provider: Literal["openai", "azure", "google"], model: str):
        self.provider = provider.lower()
        self.model = model

        if self.provider == "openai":
            self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

        elif self.provider == "azure":
            self.client = AzureOpenAI(
                api_key=os.getenv("AZURE_OPENAI_API_KEY"),
                azure_endpoint=os.getenv("AZURE_OPENAI_ENDPOINT"),
                api_version="2025-01-01-preview",
            )

        elif self.provider == "google":
            if genai is None:
                raise ImportError("pip install google-generativeai")
            genai.configure(api_key=os.getenv("GOOGLE_API_KEY"))
            self.model = genai.GenerativeModel(self.model)   # 直接保留
        else:
            raise ValueError(f"未知 provider：{provider}")

    # 單回合聊天
    def chat(self, prompt: str, *, temperature: float = 0.7, timeout: int = 60) -> str:
        if self.provider in {"openai", "azure"}:
            # 新版呼叫方式：client.chat.completions.create
            rsp = self.client.chat.completions.create(
                model=self.model,                # Azure 這裡填「部署名稱」
                messages=[{"role": "user", "content": prompt}],
                temperature=temperature,
                top_p=0.9,
                timeout=timeout,                 # 仍可保留；也可改用 client.with_options
            )
            print(f"prompt_tokens: {rsp.usage.prompt_tokens}")
            print(f"completion_tokens: {rsp.usage.completion_tokens}")
            print(f"total_tokens: {rsp.usage.total_tokens}")
            return rsp.choices[0].message.content.strip()

        elif self.provider == "google":
            rsp = self.model.generate_content(
                prompt,
                generation_config=dict(
                    temperature=temperature,
                    top_p=0.9,
                    max_output_tokens=32768,
                ),
            )
            meta = rsp.usage_metadata or {}
            print(f"prompt_tokens: {meta.get('prompt_tokens', 0)}")
            print(f"completion_tokens: {meta.get('completion_tokens', 0)}")
            print(f"total_tokens: {meta.get('total_tokens', 0)}")
            return rsp.text.strip()
