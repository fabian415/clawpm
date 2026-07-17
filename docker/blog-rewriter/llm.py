import os
# llm.py
from llm_client import LLMClient


def initialize_llm(llm_name: str):
    """
    傳回一個 LLMClient 實例，供後續 chat()。
    llm_name 規則：
        • gpt-3.5-turbo        → OpenAI
        • azure-xxxxx          → Azure
        • gemini-xxxxx         → Google
    """
    if llm_name.startswith("azure-"):
        provider = "azure"
        model = llm_name.removeprefix("azure-")
    elif llm_name.startswith("gemini-"):
        provider = "google"
        model = llm_name.removeprefix("gemini-")
    else:  # 預設走 OpenAI
        provider = "openai"
        model = llm_name

    client = LLMClient(provider, model)
    print(f"[LLM] {llm_name} ready (provider={provider})")
    return client


def invoke_llm(llm_client: LLMClient, prompt_template: str, input_text: str):
    """把 promptTemplate+input_text 串成最終 prompt，丟給 chat()，回傳字串"""
    from utilty_prompt import build_prompt  # 避免循環引用

    prompt = build_prompt(prompt_template, input_text=input_text)
    return llm_client.chat(prompt)
