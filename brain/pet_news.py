# -*- coding: utf-8 -*-
"""
pet_news.py —— 她的「时事新闻」小雷达

工作方式：
  · 每半小时（可在设置里改）去头条热榜抓一次热点
  · 按主人在设置里勾选的兴趣过滤（游戏 / 动画 / 金融 / AI / 科技 / 社会）
  · 只挑**没讲过**的，最多两条，念给主人听
  · 没有新东西就一声不吭（主人明确要求：没有新的就不聊）

为什么不调模型：
  热榜标题本身就是人话，直接念 = 0 token。要她点评再说也不迟。

对外：
    fetch_hot()                  -> [{title, url, hot}]        抓热榜
    pick(topics, seen, limit=2)  -> [{topic, title, url}]      按兴趣挑新的
    load_seen() / save_seen()    -> 去重记录（data/news_seen.json）
"""

import json
import os
import re
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
SEEN_PATH = os.path.join(DATA_DIR, "news_seen.json")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0 Safari/537.36")

# 兴趣 → 命中关键词（标题里出现任意一个就算这条属于这个方向）
TOPICS = {
    "游戏": ["游戏", "电竞", "手游", "主机", "Steam", "steam", "原神", "王者荣耀",
             "米哈游", "腾讯游戏", "任天堂", "Switch", "PS5", "英雄联盟"],
    "动画": ["动画", "动漫", "番剧", "漫画", "声优", "新番", "二次元", "手办", "漫展"],
    "金融": ["A股", "股市", "基金", "利率", "降息", "加息", "美联储", "黄金", "人民币",
             "比特币", "楼市", "汇率", "央行", "通胀", "美股", "港股", "债券"],
    "AI": ["AI", "人工智能", "大模型", "GPT", "DeepSeek", "算力", "智能体", "机器学习",
           "OpenAI", "英伟达", "推理模型"],
    "科技": ["科技", "芯片", "鸿蒙", "手机", "发布会", "操作系统", "卫星", "机器人",
             "新能源", "电动车", "自动驾驶"],
    "社会": ["政策", "教育", "医疗", "就业", "物价", "交通", "天气", "台风", "地震"],
}

TOPIC_ORDER = ["游戏", "动画", "AI", "科技", "金融", "社会"]


def _get(url, timeout=10, referer=None):
    headers = {"User-Agent": UA, "Accept": "application/json, text/plain, */*"}
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "ignore")


def fetch_hot():
    """抓头条热榜。返回 [{title, url, hot}]，失败返回空列表。"""
    out = []
    try:
        txt = _get("https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc",
                   referer="https://www.toutiao.com/")
        data = json.loads(txt)
        for it in (data.get("data") or []):
            title = (it.get("Title") or it.get("title") or "").strip()
            if not title:
                continue
            out.append({
                "title": title,
                "url": it.get("Url") or it.get("url") or "",
                "hot": int(it.get("HotValue") or it.get("hot_value") or 0),
            })
    except Exception:
        pass

    if out:
        return out

    # 备用：百度热搜
    try:
        txt = _get("https://top.baidu.com/api/board?platform=wise&tab=realtime",
                   referer="https://top.baidu.com/board")
        data = json.loads(txt)
        for card in (data.get("data", {}).get("cards") or []):
            for it in (card.get("content") or []):
                title = (it.get("word") or it.get("query") or "").strip()
                if title:
                    out.append({"title": title, "url": it.get("url") or "", "hot": 0})
    except Exception:
        pass
    return out


def _match_topic(title, topics):
    for t in TOPIC_ORDER:
        if t not in topics:
            continue
        for kw in TOPICS.get(t, []):
            if kw.lower() in title.lower():
                return t
    return None


def pick(topics, seen, limit=2, hot_items=None):
    """从热榜里挑出「感兴趣 + 没讲过」的，最多 limit 条。"""
    topics = [t for t in (topics or []) if t in TOPICS]
    if not topics:
        return []
    items = hot_items if hot_items is not None else fetch_hot()
    seen_set = set(seen or [])
    picked = []
    for it in items:
        title = it.get("title") or ""
        key = title.strip()
        if not key or key in seen_set:
            continue
        topic = _match_topic(key, topics)
        if not topic:
            continue
        picked.append({"topic": topic, "title": key, "url": it.get("url") or ""})
        seen_set.add(key)
        if len(picked) >= limit:
            break
    return picked


def load_seen():
    try:
        with open(SEEN_PATH, encoding="utf-8") as f:
            d = json.load(f)
        return list(d.get("titles") or [])
    except Exception:
        return []


def save_seen(titles):
    """只留最近 400 条，避免文件无限长。"""
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        titles = list(dict.fromkeys(titles))[-400:]
        with open(SEEN_PATH, "w", encoding="utf-8") as f:
            json.dump({"titles": titles, "at": time.time()}, f, ensure_ascii=False)
    except Exception:
        pass


def build_line(items):
    """把挑出来的新闻拼成一句她能念的话。"""
    if not items:
        return ""
    if len(items) == 1:
        return "刚看到一条%s的消息：%s。要不要我给你细说？" % (items[0]["topic"], items[0]["title"])
    a, b = items[0], items[1]
    return "刚看到两条消息，一条是%s的：%s；另一条%s：%s。想听哪条？" % (
        a["topic"], a["title"], b["topic"], b["title"])


if __name__ == "__main__":
    import sys
    topics = sys.argv[1:] or ["AI", "游戏", "金融"]
    hot = fetch_hot()
    print("热榜条数:", len(hot))
    for it in hot[:8]:
        print("   -", it["title"][:50], "| hot", it["hot"])
    seen = load_seen()
    got = pick(topics, seen)
    print("按兴趣挑到:", json.dumps(got, ensure_ascii=False, indent=2))
    print("念出来会是:", build_line(got))
