#!/usr/bin/env python3
"""
mail-receiver: Postfix pipe 程序
从 stdin 读取原始邮件，解析后通过 HTTP POST 发送给 Go API 的内部投递接口。
使用 Python 因为 email 标准库对 MIME 解析最成熟。
"""

import sys
import os
import email
import email.policy
import json
import urllib.request
import urllib.error

# ★ API_URL：指向 Go API 容器的地址。
# 默认 http://api:8080，"api" 是 Docker 内部服务名，"8080" 是容器内端口。
# 如果你修改了 .env 中的 API_PORT（比如改成 9000），
# 需要在 docker-compose.yml 的 postfix.environment 中添加：
#   API_URL: http://api:9000
# 或者直接修改下面这行的默认值 "http://api:8080" → "http://api:9000"
API_URL = os.environ.get("API_URL", "http://api:8080")


def main():
    # 从命令行参数获取收件人
    if len(sys.argv) < 2:
        print("Usage: mail-receiver <recipient>", file=sys.stderr)
        sys.exit(1)

    recipient = sys.argv[1].lower().strip()

    # 从 stdin 读取原始邮件
    raw = sys.stdin.read()
    if not raw:
        sys.exit(0)

    # 解析 MIME 邮件
    msg = email.message_from_string(raw, policy=email.policy.default)

    sender = msg.get("From", "")
    subject = msg.get("Subject", "")
    body_text = ""
    body_html = ""

    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            if ct == "text/plain" and not body_text:
                body_text = part.get_content()
            elif ct == "text/html" and not body_html:
                body_html = part.get_content()
    else:
        ct = msg.get_content_type()
        content = msg.get_content()
        if ct == "text/html":
            body_html = content
        else:
            body_text = content

    # 发送到 API
    payload = json.dumps(
        {
            "recipient": recipient,
            "sender": sender,
            "subject": subject,
            "body_text": body_text if isinstance(body_text, str) else str(body_text),
            "body_html": body_html if isinstance(body_html, str) else str(body_html),
            "raw": raw,
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        f"{API_URL}/internal/deliver",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
            if result.get("status") == "delivered":
                sys.exit(0)
            # discarded (unknown recipient) - still exit 0 so Postfix doesn't bounce
            sys.exit(0)
    except urllib.error.URLError as e:
        print(f"Error delivering mail: {e}", file=sys.stderr)
        # 返回 75 = tempfail，Postfix 会稍后重试
        sys.exit(75)


if __name__ == "__main__":
    main()
