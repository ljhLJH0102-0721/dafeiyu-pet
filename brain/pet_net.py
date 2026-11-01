# -*- coding: utf-8 -*-
"""
pet_net.py —— 给她装上「上网查一下」的能力。

设计原则：
  · 不依赖任何 API Key（天气用 wttr.in，搜索用百度/DDG 的公开页面）
  · 只做「查事实」，不代替模型说话：查到的内容作为资料交给模型
  · 失败要静默降级，绝不能让聊天因为查不到东西而卡住

对外只有三个函数：
    weather(city=None)      -> str | None     今天/明天天气
    search(query, n=5)      -> str | None     搜索结果摘要
    research(text, city=None) -> str | None   根据一句话自动决定查什么
"""

import json
import re
import time
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0 Safari/537.36")

_TIMEOUT = 8


def _get(url, timeout=_TIMEOUT, headers=None):
    h = {"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    for enc in ("utf-8", "gbk", "gb18030"):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode("utf-8", "ignore")


# ── 天气 ─────────────────────────────────────────────────
_WEATHER_WORDS = ("天气", "气温", "多少度", "下雨", "下雨吗", "冷不冷", "热不热",
                  "穿什么", "带伞", "几度", "降温", "升温", "台风", "雾霾", "紫外线")

# 常见城市（用于从这句话里抠出地名，不用装分词库）
_CITY_HINTS = (
    "北京", "上海", "广州", "深圳", "杭州", "南京", "成都", "重庆", "武汉", "西安",
    "天津", "苏州", "长沙", "郑州", "青岛", "大连", "厦门", "福州", "济南", "合肥",
    "昆明", "贵阳", "南宁", "海口", "三亚", "哈尔滨", "长春", "沈阳", "石家庄", "太原",
    "兰州", "西宁", "银川", "乌鲁木齐", "拉萨", "呼和浩特", "南昌", "宁波", "无锡",
    "香港", "澳门", "台北", "东莞", "佛山", "珠海", "温州", "泉州", "烟台", "洛阳",
)


def extract_city(text, default=None):
    """从一句话里找城市名；找不到就用默认城市。"""
    s = text or ""
    for c in _CITY_HINTS:
        if c in s:
            return c
    # 「XX天气」这种，取 2~4 个汉字
    m = re.search(r"([\u4e00-\u9fa5]{2,4})(?:的)?(?:今天|明天|现在)?天气", s)
    if m:
        cand = m.group(1)
        for stop in ("今天", "明天", "现在", "这里", "那里", "外面", "最近", "我们"):
            cand = cand.replace(stop, "")
        if 2 <= len(cand) <= 4:
            return cand
    return default or None


def weather(city=None):
    """今天/明天天气。city 为空时按 IP 定位。"""
    try:
        url = "https://wttr.in/%s?format=j1" % urllib.parse.quote(city) if city else "https://wttr.in/?format=j1"
        data = json.loads(_get(url, timeout=10))
        cur = (data.get("current_condition") or [{}])[0]
        area = ""
        if data.get("nearest_area"):
            a = data["nearest_area"][0]
            area = (a.get("areaName") or [{}])[0].get("value", "")
            region = (a.get("region") or [{}])[0].get("value", "")
            if region and region != area:
                area = "%s%s" % (region, area)
        desc_zh = {
            "Sunny": "晴", "Clear": "晴", "Partly cloudy": "多云", "Cloudy": "阴",
            "Overcast": "阴", "Mist": "薄雾", "Fog": "雾", "Patchy rain nearby": "局部有雨",
            "Light rain": "小雨", "Moderate rain": "中雨", "Heavy rain": "大雨",
            "Light drizzle": "毛毛雨", "Patchy light rain": "零星小雨",
            "Thundery outbreaks in nearby": "附近雷阵雨", "Light snow": "小雪",
        }
        en = (cur.get("weatherDesc") or [{}])[0].get("value", "")
        desc = desc_zh.get(en, en)
        parts = []
        if area:
            parts.append(area)
        parts.append("%s°C" % cur.get("temp_C", "?"))
        parts.append("体感 %s°C" % cur.get("FeelsLikeC", "?"))
        if desc:
            parts.append(desc)
        if cur.get("humidity"):
            parts.append("湿度 %s%%" % cur["humidity"])
        wind = cur.get("windspeedKmph")
        if wind:
            parts.append("风速 %s km/h" % wind)
        line = "，".join(parts)

        # 明天
        tomorrow = ""
        w = data.get("weather") or []
        if len(w) >= 2:
            d = w[1]
            tomorrow = "；明天 %s~%s°C" % (d.get("mintempC", "?"), d.get("maxtempC", "?"))
        return "今日实时天气：" + line + tomorrow
    except Exception:
        return None


# ── 搜索 ─────────────────────────────────────────────────
_SEARCH_STOP = re.compile(r"[\s\u3000]+")


def _clean(s):
    s = re.sub(r"<.*?>", "", s or "")
    s = s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&quot;", '"')
    return _SEARCH_STOP.sub(" ", s).strip()


def _baidu(query, n=5):
    html = _get("https://www.baidu.com/s?wd=" + urllib.parse.quote(query), timeout=10)
    out = []
    # 标题
    for m in re.finditer(r'<h3[^>]*>\s*<a[^>]*>(.*?)</a>', html, re.S):
        title = _clean(m.group(1))
        if title and title not in out:
            out.append(title)
        if len(out) >= n:
            break
    # 摘要
    snips = []
    for m in re.finditer(r'class="[^"]*content-right[^"]*"[^>]*>(.*?)</span>', html, re.S):
        s = _clean(m.group(1))
        if len(s) > 12 and s not in snips:
            snips.append(s)
        if len(snips) >= n:
            break
    return out, snips


def _ddg_instant(query):
    """DuckDuckGo 即时答案：人物/概念类很好用，不需要 key。"""
    try:
        data = json.loads(_get(
            "https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q="
            + urllib.parse.quote(query), timeout=8))
        abstract = (data.get("AbstractText") or "").strip()
        if abstract:
            return abstract[:400]
        for t in (data.get("RelatedTopics") or [])[:3]:
            if isinstance(t, dict) and t.get("Text"):
                return t["Text"][:300]
    except Exception:
        pass
    return None


_CMD_PREFIX = re.compile(r"^(?:请|麻烦|帮我|帮忙)?\s*(?:你)?\s*(?:查一下|查查|搜一下|搜搜|上网查|网上查|查|搜)\s*(?:一下)?\s*")
_CMD_TAIL = re.compile(r"[，,。.！!？?]*(?:是什么|是啥|怎么样|如何|吗|呢|啊|呀|了)[？?。.!！]*$")


def clean_query(text):
    """把「帮我查一下 DeepSeek 是什么公司」洗成「DeepSeek 公司」这种能搜的查询词。"""
    s = (text or "").strip()
    s = _CMD_PREFIX.sub("", s)
    s = _CMD_TAIL.sub("", s)
    s = re.sub(r"^(?:查一下|查查|搜一下|搜搜)\s*", "", s)
    s = re.sub(r"\s+", " ", s).strip(" ，,。.！!？?")
    return s


def _wikipedia(query, n=4):
    """中文维基：百科类问题最靠谱，不需要 key，也不会被反爬拦。"""
    import json as _json
    try:
        u = ("https://zh.wikipedia.org/w/api.php?action=query&list=search&format=json"
             "&srlimit=%d&srsearch=%s" % (n, urllib.parse.quote(query)))
        d = _json.loads(_get(u, timeout=10))
        hits = (d.get("query") or {}).get("search") or []
        if not hits:
            return None
        lines = ["维基百科："]
        for h in hits[:n]:
            snippet = re.sub(r"<.*?>", "", h.get("snippet") or "")
            lines.append("- %s：%s" % (h.get("title", ""), snippet[:160]))
        # 首位词条再取一段摘要，信息量最足
        try:
            title = hits[0].get("title", "")
            su = "https://zh.wikipedia.org/api/rest_v1/page/summary/" + urllib.parse.quote(title)
            sd = _json.loads(_get(su, timeout=8))
            extract = (sd.get("extract") or "").strip()
            if extract:
                lines.append("摘要（%s）：%s" % (title, extract[:300]))
        except Exception:
            pass
        return "\n".join(lines)
    except Exception:
        return None


def search(query, n=5):
    query = clean_query(query)
    if len(query) < 2:
        return None
    """返回一段可以直接塞进提示词的资料。"""
    if not query:
        return None
    lines = []
    try:
        titles, snips = _baidu(query, n)
        if titles:
            lines.append("搜索结果：")
            for i, t in enumerate(titles[:n], 1):
                lines.append("%d. %s" % (i, t))
        if snips:
            lines.append("摘要：")
            for s in snips[:3]:
                lines.append("- " + s[:180])
    except Exception:
        pass
    if not lines:
        w = _wikipedia(query, n)
        if w:
            return w
        d = _ddg_instant(query)
        if d:
            lines.append("资料：" + d)
    return "\n".join(lines) if lines else None


# ── 该不该查 ─────────────────────────────────────────────
# 注意：不要把「今天/现在/明天」这种日常词放进来自动触发联网，
# 否则「今天好累啊」也会去搜一趟。只有明确的「查/搜」或事实类词才触发。
_INFO_WORDS = ("新闻", "最新", "汇率", "多少钱", "股价", "涨了", "跌了", "比分", "赛程",
               "是谁", "哪年", "什么时候", "星期几", "查一下", "搜一下", "帮我查",
               "帮我搜", "查查", "搜搜", "上网查", "网上查")


def looks_like_info_need(text):
    """这句话是不是在问「我不知道的、需要联网的事实」。"""
    s = (text or "").strip()
    if len(s) < 2:
        return False
    if any(w in s for w in _WEATHER_WORDS):
        return True
    return any(w in s for w in _INFO_WORDS)


def research(text, city=None):
    """一句话 → 资料。返回 str 或 None（None = 没查到/不需要查）。"""
    s = (text or "").strip()
    if not s:
        return None
    try:
        if any(w in s for w in _WEATHER_WORDS):
            got = weather(extract_city(s, city))
            if got:
                return got
    except Exception:
        pass
    if not looks_like_info_need(s):
        return None
    try:
        return search(s, 5)
    except Exception:
        return None


if __name__ == "__main__":
    import sys

    q = " ".join(sys.argv[1:]) or "今天天气怎么样"
    t0 = time.time()
    print("查询:", q)
    print("需要联网:", looks_like_info_need(q))
    print("城市:", extract_city(q))
    print("---- 结果 ----")
    print(research(q) or "（没查到）")
    print("---- 耗时 %.1f 秒 ----" % (time.time() - t0))
