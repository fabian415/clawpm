import re
import os
import pypinyin
import json


# parse rewritten text to get title and content
def parse_rewritten_text(markdown_text):
    if re.match(r'^\s*```markdown\s*\n', markdown_text):
        # remove the first line of markdown code block
        markdown_text = re.sub(r'^\s*```markdown\s*\n', '', markdown_text)
        # remove the last line of markdown code block
        markdown_text = re.sub(r'\s*```\s*$', '', markdown_text)

    lines = markdown_text.splitlines()
    title = None
    title_index = -1

    for i, line in enumerate(lines):
        # ignore blank lines, find the first line that starts with #
        if line.strip() and line.strip().startswith('#'):
            title = line.strip()
            title_index = i
            break

    if title:
        print(f"find title: {title}")
        # remove the title line, create new text content
        new_lines = lines[title_index+1:]
        new_content = '\n'.join(new_lines)
        # remove # in the title
        title = title.replace("# ", "").strip()

    return title, new_content

# parse category response
def parse_meta_response(response):
    json_pattern = r'```json\s*([\s\S]*?)\s*```'
    match = re.search(json_pattern, response)

    if match:
        # 提取純 JSON 部分
        json_str = match.group(1)
    else:
        # 如果沒有找到標記，可能是直接返回的 JSON 字符串
        json_str = response

    # 解析 JSON 字符串
    try:
        meta_obj = json.loads(json_str)
        return meta_obj

    except json.JSONDecodeError as e:
        print(f"parse JSON error: {e}")
        return None

def add_disclaimer_block(content, disclaimer_text_file):
    """
    Add a disclaimer block to the content.
    """
    # read disclaimer text
    with open(disclaimer_text_file, "r", encoding="utf-8") as f:
        disclaimer_text = f.read()
    # Add markup tokens
    disclaimer_block = (
        ">"
        f"{disclaimer_text}\n"
    )
    return disclaimer_block + content

def add_hugo_header(title, content, timestamp, meta_json):
    """
    Create Hugo header block.
    """
    # hugo timestamp format:
    # e.g.2025-03-12T13:57:46+08:00
    hugo_timestamp = timestamp.strftime("%Y-%m-%dT%H:%M:%S+08:00")

    try:
        hugo_category = meta_json.get('categories', [])
        hugo_tags = meta_json.get('tags', [])
    except Exception as e:
        print(f"Error parsing category: {e}")
        hugo_category = []
        hugo_tags = []

    hugo_category_str = str(hugo_category).replace("'", '"')
    hugo_tags_str = str(hugo_tags).replace("'", '"')
    print(f"[add_hugo_header] categories: {hugo_category_str}")
    print(f"[add_hugo_header] tags: {hugo_tags_str}")

    # 處理標題中的單引號 - 在 YAML 中單引號需要用兩個單引號來轉義
    title = title.replace("'", "''")
    hugo_category_str = hugo_category_str.replace("'", "''")
    hugo_tags_str = hugo_tags_str.replace("'", "''")

    hugo_header = (
        "---\n"
        f"title: \'{title}\'\n"
        f"date: {hugo_timestamp}\n"
        f"categories: {hugo_category_str}\n"
        f"tags: {hugo_tags_str}\n"
        "draft: false\n"
        "---\n\n"
    )
    return hugo_header + content

def chinese_to_pinyin(text):
    """
    Convert Chinese characters to pinyin with hyphens between words.
    """
    # 將中文轉換為拼音，並使用連字符分隔
    pinyin_list = pypinyin.lazy_pinyin(text, style=pypinyin.NORMAL)
    # 將拼音列表用連字符連接
    return "-".join(pinyin_list)

COMMENT_IDENTIFIER = "MD_IMG_PATH_ORIGINAL"

def get_filename_only(path):
    """
    从路径中提取文件名部分
    """
    # 如果路径以http或https开头，则保持原样
    if path.startswith('http://') or path.startswith('https://'):
        return path, False

    # 否则只保留文件名部分
    filename = os.path.basename(path)
    return filename, True

def parse_line_for_images(line):
    """
    解析单行文本中的图片语法
    返回所有匹配的[(开始位置, 结束位置, alt文本, 图片路径)]
    """
    results = []
    i = 0

    while i < len(line):
        # 寻找图片语法的开始
        if line[i:i+2] == '![':
            start_pos = i
            i += 2

            # 解析 Alt text (处理可能的嵌套括号)
            alt_text = ""
            bracket_depth = 1  # 我们已经进入了一个[

            while i < len(line) and bracket_depth > 0:
                if line[i] == '[':
                    bracket_depth += 1
                elif line[i] == ']':
                    bracket_depth -= 1

                if bracket_depth > 0:
                    alt_text += line[i]
                i += 1

            # 检查图片语法是否完整
            if i < len(line) and line[i] == '(':
                i += 1

                # 解析图片路径 (处理可能的嵌套括号)
                image_path = ""
                paren_depth = 1  # 我们已经进入了一个(

                while i < len(line) and paren_depth > 0:
                    if line[i] == '(':
                        paren_depth += 1
                    elif line[i] == ')':
                        paren_depth -= 1

                    if paren_depth > 0:
                        image_path += line[i]
                    i += 1

                end_pos = i
                results.append((start_pos, end_pos, alt_text, image_path))
            else:
                # 没有找到完整的图片语法，继续搜索
                i += 1
        else:
            i += 1

    return results

def convert_image_path(content):
    """
    处理整个Markdown文件的内容，將原始圖片路徑記錄放在文件末尾
    参数: file_content - 完整的Markdown文件内容
    返回: 处理后的文件内容和路徑映射
    """
    # 按行分割
    lines = content.split('\n')
    result_lines = []
    path_mapping = []
    path_comments = []  # 收集所有圖片路徑註釋，最後添加到文件末尾
    i = 0

    while i < len(lines):
        line = lines[i]

        # 解析当前行中的所有图片
        image_matches = parse_line_for_images(line)

        if not image_matches:
            # 如果没有图片，直接添加这一行
            result_lines.append(line)
            i += 1
            continue

        # 处理行内的所有图片（从后向前，避免位置偏移）
        modified_line = line
        for start_pos, end_pos, alt_text, image_path in reversed(image_matches):
            # 检查并修改路径
            new_path, was_modified = get_filename_only(image_path)

            if was_modified:
                new_path = chinese_to_pinyin(new_path)
                # 创建新的标签
                new_tag = f'![{alt_text}]({new_path})'

                # 替换原来的标签
                modified_line = modified_line[:start_pos] + new_tag + modified_line[end_pos:]

                # 準備帶有識別符號的注釋行（將在文件末尾添加）
                comment_line = f'<!-- {COMMENT_IDENTIFIER}: {alt_text}|{image_path} -->'
                path_comments.append(comment_line)
                path_mapping.append((image_path, new_path))

        # 添加修改后的行
        result_lines.append(modified_line)
        i += 1

    # 在文件末尾添加一個分隔線和所有圖片路徑註釋
    if path_comments:
        result_lines.append("\n<!-- MD_IMG_PATH_ORIGINAL_MAPPING_TABLE_START -->")
        result_lines.append("<!-- ------------------- -->")
        result_lines.extend(path_comments)
        result_lines.append("\n<!-- MD_IMG_PATH_ORIGINAL_MAPPING_TABLE_END -->")

    # 重新组合成文本
    return '\n'.join(result_lines), path_mapping
