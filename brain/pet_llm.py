#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
pet_llm.py — 桌宠自己的大脑：直连模型 API，跟 DSH 无关。

为什么要单独一条通道
--------------------
以前她的"脑子"是 DSH 会话中的一个子代理（走 pet-brain 插件），代价是：

  · **排队**：主人在跑任务时她会一直等（实测一句卡 40~90 秒）
  · **串味**：她会读主人的会话日志，把主人的活当成自己的上下文
  · **耦合**：DSH 没起来 / 插件没装，她就完全没反应

现在她有自己的 API 通道：配好 base_url / model / key 就能独立工作，
职责只有两件事——**聊天** 和 **点屏幕（点击/打字）**。

配置（voice_bridge.json）
------------------------
    "llm": {
      "base_url": "https://api.z.ai/api/coding/paas/v4",
      "model": "glm-4-flash",
      "api_key_env": "ZAI_CODING_CN_API_KEY",
      "timeout_s": 30
    }

key 的解析顺序：配置里的 api_key → 环境变量 → DSH 凭证文件
（只读 `~/.dsh/.credentials.yaml` 里同名键；绝不打印）。
"""

import json
import os
import re
import time
import urllib.error
import urllib.request

DEFAULT_BASE = "https://api.z.ai/api/coding/paas/v4"
DEFAULT_MODEL = "glm-4-flash"
DEFAULT_KEY_ENV = "ZAI_CODING_CN_API_KEY"
DEFAULT_TIMEOUT = 30


def _key_from_dsh_credentials(name):
    """从 DSH 凭证文件读一个键（只返回内容，不打印、不落盘）。"""
    path = os.path.join(os.path.expanduser("~"), ".dsh", ".credentials.yaml")
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except Exception:
        return None
    m = re.search(r"^\s*%s\s*:\s*['\"]?([A-Za-z0-9_\-\.]+)" % re.escape(name), text, re.M)
    return m.group(1) if m else None


class PetLLM:
    """极简 OpenAI 兼容聊天客户端。只做一件事：给一段对话，拿一段回复。"""

    def __init__(self, cfg=None):
        cfg = cfg or {}
        self.base = (cfg.get("base_url") or DEFAULT_BASE).rstrip("/")
        self.model = cfg.get("model") or DEFAULT_MODEL
        self.key_env = cfg.get("api_key_env") or DEFAULT_KEY_ENV
        self.timeout = float(cfg.get("timeout_s") or DEFAULT_TIMEOUT)
        self._key = cfg.get("api_key") or ""

    # ── key ────────────────────────────────────────────────
    def key(self):
        if self._key:
            return self._key
        v = os.environ.get(self.key_env)
        if v:
            self._key = v
            return v
        v = _key_from_dsh_credentials(self.key_env)
        if v:
            self._key = v
            return v
        return ""

    def available(self):
        return bool(self.key())

    def describe(self):
        return "%s / %s（key：%s）" % (
            self.base,
            self.model,
            "已配置" if self.key() else "缺失",
        )

    # ── 调用 ───────────────────────────────────────────────
    def ask(self, system, user, timeout=None, temperature=0.7, max_tokens=600):
        """返回模型回复的纯文本。失败抛异常（调用方负责兜底）。"""
        key = self.key()
        if not key:
            raise RuntimeError("没有可用的 API key（配置 llm.api_key 或设 %s）" % self.key_env)

        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": user})

        body = json.dumps({
            "model": self.model,
            "messages": messages,
            "stream": False,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }, ensure_ascii=False).encode("utf-8")

        req = urllib.request.Request(
            self.base + "/chat/completions",
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "Authorization": "Bearer " + key,
            },
        )
        t0 = time.time()
        last_err = None
        data = None
        # 网络抖动（SSL EOF / 超时）重试两次：她不该因为一次抖动就哑掉
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=timeout or self.timeout) as r:
                    data = json.loads(r.read().decode("utf-8", "replace"))
                break
            except urllib.error.HTTPError as e:
                detail = ""
                try:
                    detail = e.read().decode("utf-8", "replace")[:200]
                except Exception:
                    pass
                last_err = RuntimeError("API HTTP %s：%s" % (e.code, detail or e.reason))
                if e.code and 400 <= e.code < 500 and e.code != 429:
                    raise last_err          # 客户端错误不重试
                time.sleep(0.8 * (attempt + 1))
            except Exception as e:
                last_err = RuntimeError("API 请求失败：%s" % e)
                time.sleep(0.8 * (attempt + 1))
        if data is None:
            raise last_err or RuntimeError("API 请求失败")

        elapsed = int((time.time() - t0) * 1000)
        choices = data.get("choices") or []
        if not choices:
            raise RuntimeError("API 没有返回 choices：%s" % json.dumps(data, ensure_ascii=False)[:200])
        msg = choices[0].get("message") or {}
        text = (msg.get("content") or "").strip()
        if not text:
            text = (msg.get("reasoning_content") or "").strip()
        return text, elapsed


if __name__ == "__main__":
    llm = PetLLM()
    print("配置：", llm.describe())
    if not llm.available():
        raise SystemExit(1)
    reply, ms = llm.ask("你是一只桌面宠物，回答要短。", "说一句你好")
    print("回复（%d ms）：%s" % (ms, reply))
