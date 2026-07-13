#!/usr/bin/env python3
"""
fetch_news_rss.py - 用 RSS/Atom feed 取得有明確發布時間的最新資訊。

解決 SearXNG 常見的「引擎被擋、結果不夠新」問題的另一條路：RSS 是網站
主動公開給機器讀取的內容，不會像搜尋引擎那樣被反爬蟲機制擋下，且每則
項目都自帶發布時間，天生比一般搜尋結果更能保證新鮮度。

兩種模式：
  1. 關鍵字模式（預設）：查 Google News RSS，適合「XX 公司 最新動態」
     這類新聞類查詢。
  2. Feed 模式（--feed-url）：直接讀指定的官方 RSS（例如競品官方部落格、
     產業媒體的 RSS），適合已知目標來源、要追蹤其最新發布內容的情境。

用法：
    python3 fetch_news_rss.py "台積電 財報"
    python3 fetch_news_rss.py "NVIDIA Isaac Sim" --lang en-US --region US
    python3 fetch_news_rss.py --feed-url https://example.com/blog/rss.xml

輸出：每筆項目的標題、連結、發布時間、來源，印到 stdout，供撰寫 SWOT/
競品分析/產業趨勢時直接附上來源與日期。
"""

import argparse
import sys
import urllib.parse
import xml.etree.ElementTree as ET

import requests

GOOGLE_NEWS_RSS = "https://news.google.com/rss/search"

ATOM_NS = {"atom": "http://www.w3.org/2005/Atom"}


def build_google_news_url(query: str, lang: str, region: str) -> str:
    params = {
        "q": query,
        "hl": lang,
        "gl": region,
        "ceid": f"{region}:{lang.split('-')[0]}",
    }
    return f"{GOOGLE_NEWS_RSS}?{urllib.parse.urlencode(params)}"


def parse_feed(xml_bytes: bytes, max_items: int):
    root = ET.fromstring(xml_bytes)

    items = []
    # RSS 2.0: <rss><channel><item>...
    for item in root.findall(".//item")[:max_items]:
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        pub_date = (item.findtext("pubDate") or "").strip()
        source_el = item.find("source")
        source = source_el.text.strip() if source_el is not None and source_el.text else ""
        items.append({"title": title, "link": link, "date": pub_date, "source": source})

    if items:
        return items

    # Atom: <feed><entry>...
    for entry in root.findall("atom:entry", ATOM_NS)[:max_items]:
        title = (entry.findtext("atom:title", namespaces=ATOM_NS) or "").strip()
        link_el = entry.find("atom:link", ATOM_NS)
        link = link_el.get("href", "") if link_el is not None else ""
        updated = (entry.findtext("atom:updated", namespaces=ATOM_NS) or "").strip()
        items.append({"title": title, "link": link, "date": updated, "source": ""})

    return items


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("query", nargs="?", default=None, help="搜尋關鍵字（走 Google News RSS）")
    ap.add_argument("--feed-url", default=None, help="直接指定 RSS/Atom feed 網址，忽略 query")
    ap.add_argument("--lang", default="zh-TW", help="語言（Google News 模式用），例如 zh-TW、en-US")
    ap.add_argument("--region", default="TW", help="地區（Google News 模式用），例如 TW、US")
    ap.add_argument("--max-items", type=int, default=15)
    ap.add_argument("--timeout", type=int, default=20)
    args = ap.parse_args()

    if not args.feed_url and not args.query:
        print("錯誤：請提供 query 關鍵字，或用 --feed-url 指定 RSS 網址", file=sys.stderr)
        sys.exit(1)

    url = args.feed_url or build_google_news_url(args.query, args.lang, args.region)

    try:
        resp = requests.get(
            url,
            headers={"User-Agent": "Mozilla/5.0 (compatible; ClawPM-SWOT-Analyzer/1.0)"},
            timeout=args.timeout,
        )
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"錯誤：無法抓取 RSS（{url}）：{e}", file=sys.stderr)
        sys.exit(1)

    try:
        items = parse_feed(resp.content, args.max_items)
    except ET.ParseError as e:
        print(f"錯誤：RSS/Atom 解析失敗：{e}", file=sys.stderr)
        sys.exit(1)

    if not items:
        print("(無項目 — feed 可能為空，或關鍵字沒有匹配到新聞)")
        return

    label = args.query or url
    print(f"# RSS 結果：{label}")
    print(f"來源 feed：{url}")
    print()
    for i, it in enumerate(items, 1):
        print(f"{i}. {it['title']}")
        if it["source"]:
            print(f"   來源：{it['source']}")
        if it["date"]:
            print(f"   發布時間：{it['date']}")
        print(f"   連結：{it['link']}")
        print()


if __name__ == "__main__":
    main()
