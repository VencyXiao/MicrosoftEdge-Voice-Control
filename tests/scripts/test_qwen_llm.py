# -*- coding: utf-8 -*-
"""
Qwen（通义千问）指令解析 API 测试脚本
用法：python tests/scripts/test_qwen_llm.py <dashscopeApiKey> [模型名]
调用百炼 OpenAI 兼容模式接口，验证语音指令能否被解析为合法 JSON 动作。
"""
import json
import sys
import urllib.request

SYSTEM_PROMPT = """你是浏览器语音助手的指令解析器。把用户的语音文本解析为 JSON 指令数组，只能输出 JSON，不要多余文字。
支持的 action：
- scroll: 参数 direction("up"/"down"/"top"/"bottom"), amount(像素,默认500)
- search: 参数 query, where("page"|"new_tab")
- clean_ads: 无参数
- open_page: 参数 url
无法识别输出 {"actions":[]}"""

CASES = [
    ("帮我下滑一点", {"scroll"}),
    ("清理页面全部广告", {"clean_ads"}),
    ("下滑然后搜一下天气", {"scroll", "search"}),
    ("打开哔哩哔哩", {"open_page"}),
    ("滚动到页面顶部再把广告关了", {"scroll", "clean_ads"}),
]


def call_qwen(api_key: str, model: str, text: str, max_retry: int = 5) -> dict:
    """调用百炼兼容模式 chat/completions，429 限流时指数退避重试"""
    import time
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.1,
    }).encode()
    for attempt in range(max_retry):
        req = urllib.request.Request(
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            data=body,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
            return json.loads(data["choices"][0]["message"]["content"])
        except urllib.error.HTTPError as e:
            # 打印响应体，区分限流/欠费/未开通等原因
            detail = e.read().decode(errors="ignore")[:300]
            if e.code == 429 and attempt < max_retry - 1:
                print(f"  ... 429 详情: {detail}")
                wait = 3 * (attempt + 1)  # 限流退避：3s/6s/9s...
                print(f"  ... 等待 {wait}s 后重试")
                time.sleep(wait)
                continue
            raise RuntimeError(f"HTTP {e.code}: {detail}")


def main():
    if len(sys.argv) < 2:
        print("用法: python test_qwen_llm.py <dashscopeApiKey> [model]")
        sys.exit(1)
    api_key, model = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "qwen-turbo"
    passed = 0
    for text, expect in CASES:
        try:
            result = call_qwen(api_key, model, text)
            actions = {a.get("action") for a in result.get("actions", [])}
            ok = expect.issubset(actions)
            passed += ok
            print(f"[{'PASS' if ok else 'FAIL'}] {text} -> {result.get('actions')} (期望含 {expect})")
        except Exception as e:
            print(f"[FAIL] {text} -> 异常: {e}")
        import time
        time.sleep(2)  # 用例间隔，降低触发限流的概率
    print(f"\n结果: {passed}/{len(CASES)} 通过")
    sys.exit(0 if passed == len(CASES) else 1)


if __name__ == "__main__":
    main()
