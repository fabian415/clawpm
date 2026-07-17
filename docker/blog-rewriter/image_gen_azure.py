import os
import base64
from pathlib import Path
from openai import AzureOpenAI
from PIL import Image

def resize_fix_width_inplace(output_path: str, target_w: int = 1024) -> None:
    p = Path(output_path)

    with Image.open(p) as im:
        im = im.convert("RGB")
        src_w, src_h = im.size

        if src_w <= target_w:
            return

        scale = target_w / src_w
        target_h = int(round(src_h * scale))

        im = im.resize((target_w, target_h), Image.LANCZOS)
        im.save(p, format="PNG")

def generate_image(prompt: str, output_path: str) -> None:
    client = AzureOpenAI(
        api_key=os.environ["AZURE_OPENAI_API_KEY"],
        azure_endpoint=os.environ["AZURE_OPENAI_ENDPOINT"],
        api_version="2025-01-01-preview",
        timeout=120.0,
        max_retries=1,
    )

    deployment = "gpt-image-1.5"

    result = client.images.generate(
        model=deployment,          # Azure: deployment name
        prompt=prompt,
        size="auto",
        quality="medium",
        background="auto",
        moderation="auto",
        output_compression=100,
        output_format="png",
        n=1,
    )

    b64_json = result.data[0].b64_json
    image_bytes = base64.b64decode(b64_json)

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(image_bytes)

    resize_fix_width_inplace(output_path, target_w=1024)
