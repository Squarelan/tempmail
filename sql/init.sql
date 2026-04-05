-- ============================================================
-- TempMail 临时邮箱平台 - 数据库初始化
-- 针对高并发优化：索引、分区就绪、UUID主键
-- ============================================================

-- 启用扩展
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- 1. 账号表 (accounts)
-- ============================================================
CREATE TABLE accounts (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username                 VARCHAR(64)  NOT NULL UNIQUE,
    api_key                  VARCHAR(64)  NOT NULL UNIQUE,
    is_admin                 BOOLEAN      NOT NULL DEFAULT FALSE,
    is_active                BOOLEAN      NOT NULL DEFAULT TRUE,
    is_system                BOOLEAN      NOT NULL DEFAULT FALSE,
    permanent_mailbox_quota  INT          NOT NULL DEFAULT 5,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- API Key 查询走 B-tree 索引（认证热路径）
CREATE INDEX idx_accounts_api_key ON accounts (api_key);

-- ============================================================
-- 2. 域名池表 (domains)
-- ============================================================
CREATE TABLE domains (
    id            SERIAL PRIMARY KEY,
    domain        VARCHAR(255) NOT NULL UNIQUE,
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    status        VARCHAR(16)  NOT NULL DEFAULT 'active',  -- active / pending / disabled
    mx_checked_at TIMESTAMPTZ,                             -- 最近一次 MX 检测时间
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_domains_active ON domains (is_active) WHERE is_active = TRUE;
CREATE INDEX idx_domains_status ON domains (status) WHERE status = 'pending';

-- ============================================================
-- 3. 邮箱表 (mailboxes)
-- ============================================================
CREATE TABLE mailboxes (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id   UUID         NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    address      VARCHAR(128) NOT NULL,  -- 本地部分，如 "abc123"
    domain_id    INT          NOT NULL REFERENCES domains(id),
    full_address VARCHAR(320) NOT NULL,  -- 完整地址 "abc123@mail.xxx.xyz"
    is_catchall  BOOLEAN      NOT NULL DEFAULT FALSE,
    is_permanent BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ           DEFAULT NOW() + INTERVAL '30 minutes'
);

-- 完整地址唯一索引（收件匹配热路径）
CREATE UNIQUE INDEX idx_mailboxes_full_address ON mailboxes (full_address);

-- 按账号查邮箱列表
CREATE INDEX idx_mailboxes_account_id ON mailboxes (account_id);

-- 过期自动清理索引
CREATE INDEX idx_mailboxes_expires_at ON mailboxes (expires_at);

-- ============================================================
-- 4. 邮件表 (emails)
-- ============================================================
CREATE TABLE emails (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mailbox_id   UUID         NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    sender       VARCHAR(320) NOT NULL DEFAULT '',
    subject      VARCHAR(998) NOT NULL DEFAULT '',
    body_text    TEXT         NOT NULL DEFAULT '',
    body_html    TEXT         NOT NULL DEFAULT '',
    raw_message  TEXT         NOT NULL DEFAULT '',
    size_bytes   INT          NOT NULL DEFAULT 0,
    received_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 按邮箱查邮件（分页查询热路径）
CREATE INDEX idx_emails_mailbox_received ON emails (mailbox_id, received_at DESC);

-- ============================================================
-- 5. 初始管理员账号
-- ============================================================
INSERT INTO accounts (username, api_key, is_admin)
VALUES ('admin', 'tm_admin_' || encode(gen_random_bytes(24), 'hex'), TRUE);

INSERT INTO accounts (username, api_key, is_admin, is_active, is_system)
VALUES ('_catchall', 'tm_sys_' || encode(gen_random_bytes(24), 'hex'), FALSE, FALSE, TRUE)
ON CONFLICT (username) DO NOTHING;

-- ============================================================
-- 6. 初始域名（请在启动后通过管理后台或 API 添加实际域名）
-- ============================================================
-- INSERT INTO domains (domain) VALUES ('mail.yourdomain.com');

-- ============================================================
-- 7. 应用设置表 (app_settings)
-- ============================================================
CREATE TABLE IF NOT EXISTS app_settings (
    key        VARCHAR(64) PRIMARY KEY,
    value      TEXT        NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO app_settings (key, value) VALUES ('registration_open', 'true') ON CONFLICT DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('site_title', 'TempMail') ON CONFLICT DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('site_logo', '✉') ON CONFLICT DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('site_subtitle', '临时邮箱服务 · 安全隔离 · 按需分配') ON CONFLICT DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('smtp_server_ip', '') ON CONFLICT DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('smtp_hostname', '') ON CONFLICT DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('default_domain', '') ON CONFLICT DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('mailbox_ttl_minutes', '30') ON CONFLICT DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('max_mailboxes_per_user', '100') ON CONFLICT DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('announcement', '') ON CONFLICT DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('rate_limit_enabled', 'true') ON CONFLICT DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('unknown_recipient_policy', 'claimable') ON CONFLICT DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('catchall_admin_account_id', '') ON CONFLICT DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('reserved_mailbox_addresses', $$admin
administrator
root
system
support
noreply
no-reply
no_reply
notification
notifications
notify
alerts
mailer-daemon
postmaster
hostmaster
webmaster
security
abuse
daemon$$) ON CONFLICT DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('subdomain_wordlist', $$access
account
accounts
admin
admin-center
admin-portal
analytics
api
api-gateway
app
apps
archive
archives
assets
audit
auth
auth-center
auth-gateway
autoconfig
autodiscover
backend
backup
billing
billing-center
billing-ops
biz
blog
board
bridge
calendar
campus
care
careers
case
cdn
center
central
chat
client
client-center
client-portal
cloud
cloud-core
cloud-hub
code
community
compliance
conference
connect
console
content
control
core
crm
customer
customer-center
dashboard
data
data-core
datahub
delivery
demo
deploy
desk
dev
digital
direct
dispatch
docs
domain
domains
download
downloads
edge
education
email
eng
enterprise
events
exchange
extranet
feedback
file
files
finance
finance-center
forums
gateway
global
group
groups
guide
help
help-center
helpdesk
hub
id
identity
images
imap
index
infra
internal
intranet
jobs
kb
knowledge
library
link
links
live
login
mail
mail-center
mail-gateway
mail-hub
mailbox
manage
manager
member
member-center
member-portal
members
message
messaging
mobile
monitor
monitoring
mx
network
news
newsletter
noc
notice
notify
office
ops
ops-center
ops-hub
panel
partner
partner-center
partner-portal
pay
pay-center
payment
payments
people
platform
portal
preview
private
project
project-center
projects
proxy
qa
register
registry
relay
remote
report
reports
research
sandbox
search
secure
security
service
service-center
service-desk
service-hub
services
share
site
sites
smtp
source
staff
staff-center
stage
staging
start
static
status
storage
store
support
support-center
support-desk
support-hub
sync
sys
system
team
team-center
team-hub
teams
test
testing
ticket
tickets
tools
tracking
training
update
upload
user
user-center
users
vault
verify
web
webmail
wiki
work
workbench
workcenter
workflow
workspace
zone$$) ON CONFLICT DO NOTHING;

-- ============================================================
-- 7. 数据库性能参数（在 postgresql.conf 或 docker 环境变量中设置更佳）
-- ============================================================
-- 以下通过 ALTER SYSTEM 设置，重启后生效
-- ALTER SYSTEM SET shared_buffers = '256MB';
-- ALTER SYSTEM SET effective_cache_size = '512MB';
-- ALTER SYSTEM SET work_mem = '4MB';
-- ALTER SYSTEM SET maintenance_work_mem = '64MB';
-- ALTER SYSTEM SET max_connections = 200;
