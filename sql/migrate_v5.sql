-- ============================================================
-- TempMail v5 迁移 — 永久邮箱额度与管理员保留地址
-- ============================================================

-- 1. 账户永久邮箱额度（普通用户默认 5，管理员逻辑上无限制）
ALTER TABLE accounts
ADD COLUMN IF NOT EXISTS permanent_mailbox_quota INT NOT NULL DEFAULT 5;

-- 2. 邮箱永久标记
ALTER TABLE mailboxes
ADD COLUMN IF NOT EXISTS is_permanent BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. 永久邮箱允许 expires_at 为空
ALTER TABLE mailboxes
ALTER COLUMN expires_at DROP NOT NULL;

-- 4. 历史数据修正：若已被手动设置为永不过期，则视为永久邮箱
UPDATE mailboxes
SET is_permanent = TRUE
WHERE expires_at IS NULL;

-- 5. 新增管理员保留地址配置（普通用户不可创建）
INSERT INTO app_settings (key, value)
VALUES (
  'reserved_mailbox_addresses',
  $$admin
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
daemon$$
)
ON CONFLICT DO NOTHING;
