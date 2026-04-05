-- ============================================================
-- TempMail v4 迁移 — catch-all 存储与管理员角色切换
-- ============================================================

-- 1. 账户表增加系统账号标记
ALTER TABLE accounts
ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. 邮箱表增加 catch-all 标记
ALTER TABLE mailboxes
ADD COLUMN IF NOT EXISTS is_catchall BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. 创建内部 catch-all 账号（不允许登录）
INSERT INTO accounts (username, api_key, is_admin, is_active, is_system)
VALUES ('_catchall', 'tm_sys_' || encode(gen_random_bytes(24), 'hex'), FALSE, FALSE, TRUE)
ON CONFLICT (username) DO NOTHING;

-- 4. 新增未知收件人策略开关
INSERT INTO app_settings (key, value)
VALUES ('unknown_recipient_policy', 'claimable')
ON CONFLICT DO NOTHING;

-- 5. 指定 catch-all 管理员（为空 = 自动选择最早创建的活跃管理员）
INSERT INTO app_settings (key, value)
VALUES ('catchall_admin_account_id', '')
ON CONFLICT DO NOTHING;
