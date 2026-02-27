#!/bin/bash
set -e

# ============================================================
# Postfix 容器入口脚本
# - 动态从数据库加载域名到 virtual_domains
# - 配置 catch-all 收件
# ============================================================

echo "==> Starting Postfix mail receiver..."

# 设置权限
chmod +x /usr/local/bin/mail-receiver

# 生成初始虚拟域名列表（至少包含默认域名，实际值由环境变量注入）
echo "${SMTP_HOSTNAME:-mail.example.com}     OK" > /etc/postfix/virtual_domains

# 定期从 API 拉取域名列表的 cron 脚本
cat > /usr/local/bin/sync-domains.sh << 'SCRIPT'
#!/bin/bash
# 从 API 获取域名列表并更新 Postfix 虚拟域名
# ★ 注意：这里的 api:8080 是 Docker 内部通信地址。
# 如果你修改了 API 容器内端口（.env 的 API_PORT），
# 需要把下面的 8080 改成对应的新端口。
DOMAINS=$(curl -sf http://api:8080/internal/domains 2>/dev/null || echo "")
if [ -n "$DOMAINS" ]; then
    echo "$DOMAINS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for d in data.get('domains', []):
    if d.get('is_active', False):
        print(f\"{d['domain']}     OK\")
" > /etc/postfix/virtual_domains.new
    if [ -s /etc/postfix/virtual_domains.new ]; then
        mv /etc/postfix/virtual_domains.new /etc/postfix/virtual_domains
        postmap /etc/postfix/virtual_domains
        postfix reload 2>/dev/null || true
    fi
fi
SCRIPT
chmod +x /usr/local/bin/sync-domains.sh

# 初始 postmap
postmap /etc/postfix/virtual_domains

# 启动 cron 定期同步域名（每 60 秒）
(while true; do sleep 60; /usr/local/bin/sync-domains.sh; done) &

# 更新 main.cf 中的主机名（由环境变量 SMTP_HOSTNAME 注入）
postconf -e "myhostname=${SMTP_HOSTNAME:-mail.example.com}"
postconf -e "virtual_mailbox_domains=hash:/etc/postfix/virtual_domains"
postconf -e "virtual_transport=mailreceiver:"

# 启动 Postfix（前台运行）
exec postfix start-fg
