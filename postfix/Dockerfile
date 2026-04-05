# ============================================================
# Postfix 收件容器
# ============================================================
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Shanghai

RUN apt-get update && apt-get install -y --no-install-recommends \
    postfix \
    python3 \
    curl \
    ca-certificates \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

# 复制配置
COPY postfix/main.cf /etc/postfix/main.cf
COPY postfix/master.cf /etc/postfix/master.cf
COPY postfix/mail-receiver.py /usr/local/bin/mail-receiver
COPY postfix/entrypoint.sh /entrypoint.sh

RUN sed -i 's/\r$//' /usr/local/bin/mail-receiver /entrypoint.sh /etc/postfix/main.cf /etc/postfix/master.cf \
    && chmod +x /usr/local/bin/mail-receiver /entrypoint.sh

# 创建虚拟域名目录
RUN touch /etc/postfix/virtual_domains

EXPOSE 25

CMD ["/entrypoint.sh"]
