package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"net"
	"strings"
	"time"

	"tempmail/model"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	pool *pgxpool.Pool
}

// New 创建带连接池的 Store（高并发核心）
func New(ctx context.Context, dsn string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}

	// 连接池：不限并发，由 PgBouncer 统一管控实际 PG 连接数
	cfg.MaxConns = 500
	cfg.MinConns = 20
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.MaxConnIdleTime = 2 * time.Minute
	cfg.HealthCheckPeriod = 30 * time.Second

	// PgBouncer transaction 模式不支持 named prepared statements。
	// pgx v5 默认使用 QueryExecModeCacheStatement（会发送 Parse/Bind/Execute），
	// 多个连接复用同一个后端连接时会触发 "prepared statement already in use"。
	// 改为 SimpleProtocol：直接发送明文 SQL，完全绕过服务端 prepared statement 机制。
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect db: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("ping db: %w", err)
	}

	return &Store{pool: pool}, nil
}

func (s *Store) Close() {
	s.pool.Close()
}

// ==================== Account ====================

func (s *Store) GetAccountByAPIKey(ctx context.Context, apiKey string) (*model.Account, error) {
	var a model.Account
	err := s.pool.QueryRow(ctx,
		`SELECT id, username, api_key, is_admin, is_active, is_system, permanent_mailbox_quota, created_at, updated_at
		 FROM accounts WHERE api_key = $1 AND is_active = TRUE`, apiKey,
	).Scan(&a.ID, &a.Username, &a.APIKey, &a.IsAdmin, &a.IsActive, &a.IsSystem, &a.PermanentMailboxQuota, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *Store) CreateAccount(ctx context.Context, username string, isAdmin bool) (*model.Account, error) {
	apiKey := generateAPIKey()
	var a model.Account
	err := s.pool.QueryRow(ctx,
		`INSERT INTO accounts (username, api_key, is_admin) VALUES ($1, $2, $3)
		 RETURNING id, username, api_key, is_admin, is_active, is_system, permanent_mailbox_quota, created_at, updated_at`,
		username, apiKey, isAdmin,
	).Scan(&a.ID, &a.Username, &a.APIKey, &a.IsAdmin, &a.IsActive, &a.IsSystem, &a.PermanentMailboxQuota, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *Store) DeleteAccount(ctx context.Context, accountID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM accounts WHERE id = $1`, accountID)
	return err
}

func (s *Store) ListAccounts(ctx context.Context, page, size int, query, role string) ([]model.Account, int, error) {
	var total int
	err := s.pool.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM accounts
		WHERE ($1 = '' OR username ILIKE '%' || $1 || '%' OR api_key ILIKE '%' || $1 || '%')
		  AND (
		    $2 = '' OR $2 = 'all' OR
		    ($2 = 'admin' AND is_admin = TRUE AND is_system = FALSE) OR
		    ($2 = 'user' AND is_admin = FALSE AND is_system = FALSE) OR
		    ($2 = 'system' AND is_system = TRUE)
		  )
	`, query, role).Scan(&total)
	if err != nil {
		return nil, 0, err
	}

	rows, err := s.pool.Query(ctx,
		`SELECT id, username, api_key, is_admin, is_active, is_system, permanent_mailbox_quota, created_at, updated_at
		 FROM accounts
		 WHERE ($1 = '' OR username ILIKE '%' || $1 || '%' OR api_key ILIKE '%' || $1 || '%')
		   AND (
		     $2 = '' OR $2 = 'all' OR
		     ($2 = 'admin' AND is_admin = TRUE AND is_system = FALSE) OR
		     ($2 = 'user' AND is_admin = FALSE AND is_system = FALSE) OR
		     ($2 = 'system' AND is_system = TRUE)
		   )
		 ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
		query, role, size, (page-1)*size,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	accounts, err := pgx.CollectRows(rows, pgx.RowToStructByPos[model.Account])
	if err != nil {
		return nil, 0, err
	}
	return accounts, total, nil
}

func (s *Store) GetAccountByID(ctx context.Context, accountID uuid.UUID) (*model.Account, error) {
	var a model.Account
	err := s.pool.QueryRow(ctx,
		`SELECT id, username, api_key, is_admin, is_active, is_system, permanent_mailbox_quota, created_at, updated_at
		 FROM accounts WHERE id = $1`,
		accountID,
	).Scan(&a.ID, &a.Username, &a.APIKey, &a.IsAdmin, &a.IsActive, &a.IsSystem, &a.PermanentMailboxQuota, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *Store) GetAccountByUsername(ctx context.Context, username string) (*model.Account, error) {
	var a model.Account
	err := s.pool.QueryRow(ctx,
		`SELECT id, username, api_key, is_admin, is_active, is_system, permanent_mailbox_quota, created_at, updated_at
		 FROM accounts WHERE username = $1`,
		username,
	).Scan(&a.ID, &a.Username, &a.APIKey, &a.IsAdmin, &a.IsActive, &a.IsSystem, &a.PermanentMailboxQuota, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *Store) GetPrimaryActiveAdmin(ctx context.Context) (*model.Account, error) {
	var a model.Account
	err := s.pool.QueryRow(ctx,
		`SELECT id, username, api_key, is_admin, is_active, is_system, permanent_mailbox_quota, created_at, updated_at
		 FROM accounts
		 WHERE is_admin = TRUE AND is_active = TRUE AND is_system = FALSE
		 ORDER BY created_at
		 LIMIT 1`,
	).Scan(&a.ID, &a.Username, &a.APIKey, &a.IsAdmin, &a.IsActive, &a.IsSystem, &a.PermanentMailboxQuota, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *Store) CountActiveAdmins(ctx context.Context) (int, error) {
	var total int
	err := s.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM accounts WHERE is_admin = TRUE AND is_active = TRUE AND is_system = FALSE`,
	).Scan(&total)
	return total, err
}

func (s *Store) SetAccountAdmin(ctx context.Context, accountID uuid.UUID, isAdmin bool) (*model.Account, error) {
	var a model.Account
	err := s.pool.QueryRow(ctx,
		`UPDATE accounts
		 SET is_admin = $2, updated_at = NOW()
		 WHERE id = $1
		 RETURNING id, username, api_key, is_admin, is_active, is_system, permanent_mailbox_quota, created_at, updated_at`,
		accountID, isAdmin,
	).Scan(&a.ID, &a.Username, &a.APIKey, &a.IsAdmin, &a.IsActive, &a.IsSystem, &a.PermanentMailboxQuota, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *Store) SetAccountPermanentQuota(ctx context.Context, accountID uuid.UUID, quota int) (*model.Account, error) {
	var a model.Account
	err := s.pool.QueryRow(ctx,
		`UPDATE accounts
		 SET permanent_mailbox_quota = $2, updated_at = NOW()
		 WHERE id = $1
		 RETURNING id, username, api_key, is_admin, is_active, is_system, permanent_mailbox_quota, created_at, updated_at`,
		accountID, quota,
	).Scan(&a.ID, &a.Username, &a.APIKey, &a.IsAdmin, &a.IsActive, &a.IsSystem, &a.PermanentMailboxQuota, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *Store) CountPermanentMailboxesByAccount(ctx context.Context, accountID uuid.UUID) (int, error) {
	var total int
	err := s.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM mailboxes WHERE account_id = $1 AND is_permanent = TRUE AND is_catchall = FALSE`,
		accountID,
	).Scan(&total)
	return total, err
}

// GetAdminAPIKey 获取第一个管理员账号的 API Key（用于写入 admin.key 文件）
func (s *Store) GetAdminAPIKey(ctx context.Context) (string, error) {
	var apiKey string
	err := s.pool.QueryRow(ctx,
		`SELECT api_key FROM accounts WHERE is_admin = TRUE ORDER BY created_at LIMIT 1`,
	).Scan(&apiKey)
	return apiKey, err
}

// ==================== Domain ====================

func (s *Store) AddDomain(ctx context.Context, domain string) (*model.Domain, error) {
	normalized, err := NormalizeManagedDomain(domain)
	if err != nil {
		return nil, err
	}
	var d model.Domain
	err = s.pool.QueryRow(ctx,
		`INSERT INTO domains (domain, is_active, status) VALUES ($1, TRUE, 'active')
		 RETURNING id, domain, is_active, status, created_at, mx_checked_at`,
		normalized,
	).Scan(&d.ID, &d.Domain, &d.IsActive, &d.Status, &d.CreatedAt, &d.MxCheckedAt)
	if err != nil {
		return nil, err
	}
	return &d, nil
}

// AddDomainPending 添加待验证域名（后台轮询 MX 记录）
func (s *Store) AddDomainPending(ctx context.Context, domain string) (*model.Domain, error) {
	normalized, err := NormalizeManagedDomain(domain)
	if err != nil {
		return nil, err
	}
	var d model.Domain
	err = s.pool.QueryRow(ctx,
		`INSERT INTO domains (domain, is_active, status) VALUES ($1, FALSE, 'pending')
		 ON CONFLICT (domain) DO UPDATE
		   SET status = CASE WHEN domains.status = 'active' THEN 'active' ELSE 'pending' END,
		       is_active = CASE WHEN domains.status = 'active' THEN TRUE ELSE FALSE END
		 RETURNING id, domain, is_active, status, created_at, mx_checked_at`,
		normalized,
	).Scan(&d.ID, &d.Domain, &d.IsActive, &d.Status, &d.CreatedAt, &d.MxCheckedAt)
	if err != nil {
		return nil, err
	}
	return &d, nil
}

func (s *Store) ListDomains(ctx context.Context) ([]model.Domain, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, domain, is_active, status, created_at, mx_checked_at FROM domains ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return pgx.CollectRows(rows, pgx.RowToStructByPos[model.Domain])
}

func (s *Store) GetActiveDomains(ctx context.Context) ([]model.Domain, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, domain, is_active, status, created_at, mx_checked_at FROM domains WHERE is_active = TRUE`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return pgx.CollectRows(rows, pgx.RowToStructByPos[model.Domain])
}

func (s *Store) GetRandomActiveDomain(ctx context.Context) (*model.Domain, error) {
	var d model.Domain
	err := s.pool.QueryRow(ctx,
		`SELECT id, domain, is_active, status, created_at, mx_checked_at FROM domains
		 WHERE is_active = TRUE AND LEFT(domain, 2) <> '*.' ORDER BY RANDOM() LIMIT 1`,
	).Scan(&d.ID, &d.Domain, &d.IsActive, &d.Status, &d.CreatedAt, &d.MxCheckedAt)
	if err != nil {
		return nil, err
	}
	return &d, nil
}

// GetDomainByName 按域名字符串查找活跃域名，供创建邮箱时指定域名使用
func (s *Store) GetDomainByName(ctx context.Context, domain string) (*model.Domain, error) {
	normalized, err := NormalizeManagedDomain(domain)
	if err != nil {
		return nil, err
	}
	var d model.Domain
	err = s.pool.QueryRow(ctx,
		`SELECT id, domain, is_active, status, created_at, mx_checked_at
		 FROM domains WHERE domain = $1 AND is_active = TRUE`,
		normalized,
	).Scan(&d.ID, &d.Domain, &d.IsActive, &d.Status, &d.CreatedAt, &d.MxCheckedAt)
	if err != nil {
		return nil, err
	}
	return &d, nil
}

// ResolveActiveDomain 按实际收件域名解析激活中的域名规则。
// 优先精确匹配；若不存在，则尝试匹配最具体的通配规则（例如 *.example.com）。
func (s *Store) ResolveActiveDomain(ctx context.Context, domain string) (*model.Domain, error) {
	normalized, err := NormalizeManagedDomain(domain)
	if err != nil {
		return nil, err
	}

	exactDomain, err := s.GetDomainByName(ctx, normalized)
	if err == nil {
		return exactDomain, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}

	rows, err := s.pool.Query(ctx,
		`SELECT id, domain, is_active, status, created_at, mx_checked_at
		 FROM domains
		 WHERE is_active = TRUE AND domain LIKE '*.%'
		 ORDER BY LENGTH(domain) DESC, created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var d model.Domain
		if err := rows.Scan(&d.ID, &d.Domain, &d.IsActive, &d.Status, &d.CreatedAt, &d.MxCheckedAt); err != nil {
			return nil, err
		}
		if DomainMatchesRule(d.Domain, normalized) {
			return &d, nil
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return nil, pgx.ErrNoRows
}

func (s *Store) GetDomainByID(ctx context.Context, domainID int) (*model.Domain, error) {
	var d model.Domain
	err := s.pool.QueryRow(ctx,
		`SELECT id, domain, is_active, status, created_at, mx_checked_at FROM domains WHERE id = $1`,
		domainID,
	).Scan(&d.ID, &d.Domain, &d.IsActive, &d.Status, &d.CreatedAt, &d.MxCheckedAt)
	if err != nil {
		return nil, err
	}
	return &d, nil
}

// ListPendingDomains 返回所有待验证域名
func (s *Store) ListPendingDomains(ctx context.Context) ([]model.Domain, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, domain, is_active, status, created_at, mx_checked_at
		 FROM domains WHERE status = 'pending'
		 ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return pgx.CollectRows(rows, pgx.RowToStructByPos[model.Domain])
}

// PromoteDomainToActive 验证通过，激活域名
func (s *Store) PromoteDomainToActive(ctx context.Context, domainID int) error {
	now := time.Now()
	_, err := s.pool.Exec(ctx,
		`UPDATE domains SET is_active = TRUE, status = 'active', mx_checked_at = $1 WHERE id = $2`,
		now, domainID)
	return err
}

// TouchDomainCheckTime 更新最后检测时间
func (s *Store) TouchDomainCheckTime(ctx context.Context, domainID int) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE domains SET mx_checked_at = NOW() WHERE id = $1`, domainID)
	return err
}

// DisableDomainMX MX检测失败，自动停用域名
func (s *Store) DisableDomainMX(ctx context.Context, domainID int) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE domains SET is_active = FALSE, status = 'disabled', mx_checked_at = NOW() WHERE id = $1`,
		domainID)
	return err
}

func (s *Store) DeleteDomain(ctx context.Context, domainID int) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM domains WHERE id = $1`, domainID)
	return err
}

func (s *Store) ToggleDomain(ctx context.Context, domainID int, active bool) error {
	status := "disabled"
	if active {
		status = "active"
	}
	_, err := s.pool.Exec(ctx,
		`UPDATE domains SET is_active = $1, status = $2 WHERE id = $3`, active, status, domainID)
	return err
}

// GetStats 返回全局统计数据
func (s *Store) GetStats(ctx context.Context) (*model.Stats, error) {
	var st model.Stats
	err := s.pool.QueryRow(ctx, `
		SELECT
		  (SELECT COUNT(*) FROM mailboxes)                         AS total_mailboxes,
		  (SELECT COUNT(*) FROM mailboxes WHERE is_permanent = TRUE OR expires_at IS NULL OR expires_at > NOW()) AS active_mailboxes,
		  (SELECT COUNT(*) FROM emails)                            AS total_emails,
		  (SELECT COUNT(*) FROM domains WHERE is_active = TRUE)    AS active_domains,
		  (SELECT COUNT(*) FROM domains WHERE status = 'pending')  AS pending_domains,
		  (SELECT COUNT(*) FROM accounts WHERE is_active = TRUE)   AS total_accounts
	`).Scan(
		&st.TotalMailboxes, &st.ActiveMailboxes,
		&st.TotalEmails, &st.ActiveDomains,
		&st.PendingDomains, &st.TotalAccounts,
	)
	if err != nil {
		return nil, err
	}
	return &st, nil
}

// ==================== Mailbox ====================

func mailboxExpiresAt(ttlMinutes int) *time.Time {
	if ttlMinutes <= 0 {
		ttlMinutes = 30
	}
	expiresAt := time.Now().Add(time.Duration(ttlMinutes) * time.Minute)
	return &expiresAt
}

func (s *Store) CreateMailbox(ctx context.Context, accountID uuid.UUID, address string, domainID int, fullAddress string, ttlMinutes int, isPermanent bool) (*model.Mailbox, error) {
	var expiresAt *time.Time
	if !isPermanent {
		expiresAt = mailboxExpiresAt(ttlMinutes)
	}
	var m model.Mailbox
	err := s.pool.QueryRow(ctx,
		`INSERT INTO mailboxes (account_id, address, domain_id, full_address, expires_at, is_catchall, is_permanent)
		 VALUES ($1, $2, $3, $4, $5, FALSE, $6)
		 RETURNING id, account_id, address, domain_id, full_address, is_catchall, is_permanent, created_at, expires_at`,
		accountID, address, domainID, fullAddress, expiresAt, isPermanent,
	).Scan(&m.ID, &m.AccountID, &m.Address, &m.DomainID, &m.FullAddress, &m.IsCatchall, &m.IsPermanent, &m.CreatedAt, &m.ExpiresAt)
	if err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *Store) ListMailboxes(ctx context.Context, accountID uuid.UUID, page, size int, query, kind string) ([]model.Mailbox, int, error) {
	var total int
	err := s.pool.QueryRow(ctx,
		`SELECT COUNT(*)
		 FROM mailboxes
		 WHERE account_id = $1
		   AND ($2 = '' OR address ILIKE '%' || $2 || '%' OR full_address ILIKE '%' || $2 || '%')
		   AND (
		     $3 = '' OR $3 = 'all' OR
		     ($3 = 'permanent' AND is_permanent = TRUE) OR
		     ($3 = 'temporary' AND is_permanent = FALSE) OR
		     ($3 = 'catchall' AND is_catchall = TRUE)
		   )`, accountID, query, kind).Scan(&total)
	if err != nil {
		return nil, 0, err
	}

	rows, err := s.pool.Query(ctx,
		`SELECT id, account_id, address, domain_id, full_address, is_catchall, is_permanent, created_at, expires_at
		 FROM mailboxes
		 WHERE account_id = $1
		   AND ($2 = '' OR address ILIKE '%' || $2 || '%' OR full_address ILIKE '%' || $2 || '%')
		   AND (
		     $3 = '' OR $3 = 'all' OR
		     ($3 = 'permanent' AND is_permanent = TRUE) OR
		     ($3 = 'temporary' AND is_permanent = FALSE) OR
		     ($3 = 'catchall' AND is_catchall = TRUE)
		   )
		 ORDER BY is_permanent DESC, created_at DESC LIMIT $4 OFFSET $5`,
		accountID, query, kind, size, (page-1)*size,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	mailboxes, err := pgx.CollectRows(rows, pgx.RowToStructByPos[model.Mailbox])
	if err != nil {
		return nil, 0, err
	}
	return mailboxes, total, nil
}

func (s *Store) GetMailbox(ctx context.Context, mailboxID uuid.UUID, accountID uuid.UUID) (*model.Mailbox, error) {
	var m model.Mailbox
	err := s.pool.QueryRow(ctx,
		`SELECT id, account_id, address, domain_id, full_address, is_catchall, is_permanent, created_at, expires_at
		 FROM mailboxes WHERE id = $1 AND account_id = $2`,
		mailboxID, accountID,
	).Scan(&m.ID, &m.AccountID, &m.Address, &m.DomainID, &m.FullAddress, &m.IsCatchall, &m.IsPermanent, &m.CreatedAt, &m.ExpiresAt)
	if err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *Store) GetMailboxByID(ctx context.Context, mailboxID uuid.UUID) (*model.Mailbox, error) {
	var m model.Mailbox
	err := s.pool.QueryRow(ctx,
		`SELECT id, account_id, address, domain_id, full_address, is_catchall, is_permanent, created_at, expires_at
		 FROM mailboxes WHERE id = $1`,
		mailboxID,
	).Scan(&m.ID, &m.AccountID, &m.Address, &m.DomainID, &m.FullAddress, &m.IsCatchall, &m.IsPermanent, &m.CreatedAt, &m.ExpiresAt)
	if err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *Store) DeleteMailbox(ctx context.Context, mailboxID uuid.UUID, accountID uuid.UUID) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM mailboxes WHERE id = $1 AND account_id = $2`, mailboxID, accountID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

func (s *Store) DeleteCatchallMailbox(ctx context.Context, mailboxID uuid.UUID) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM mailboxes WHERE id = $1 AND is_catchall = TRUE`, mailboxID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

func (s *Store) GetMailboxByFullAddress(ctx context.Context, fullAddress string) (*model.Mailbox, error) {
	var m model.Mailbox
	err := s.pool.QueryRow(ctx,
		`SELECT id, account_id, address, domain_id, full_address, is_catchall, is_permanent, created_at, expires_at
		 FROM mailboxes WHERE full_address = $1`,
		strings.ToLower(fullAddress),
	).Scan(&m.ID, &m.AccountID, &m.Address, &m.DomainID, &m.FullAddress, &m.IsCatchall, &m.IsPermanent, &m.CreatedAt, &m.ExpiresAt)
	if err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *Store) CountCatchallMailboxesByAccount(ctx context.Context, accountID uuid.UUID) (int, error) {
	var total int
	err := s.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM mailboxes WHERE account_id = $1 AND is_catchall = TRUE`,
		accountID,
	).Scan(&total)
	return total, err
}

func (s *Store) ListCatchallMailboxes(ctx context.Context, page, size int, query, owner string) ([]model.CatchallMailboxSummary, int, error) {
	var total int
	err := s.pool.QueryRow(ctx,
		`SELECT COUNT(*)
		 FROM mailboxes mb
		 JOIN accounts a ON a.id = mb.account_id
		 WHERE mb.is_catchall = TRUE
		   AND ($1 = '' OR mb.full_address ILIKE '%' || $1 || '%' OR a.username ILIKE '%' || $1 || '%')
		   AND (
		     $2 = '' OR $2 = 'all' OR
		     ($2 = 'admin' AND a.is_admin = TRUE AND a.is_system = FALSE) OR
		     ($2 = 'user' AND a.is_admin = FALSE AND a.is_system = FALSE) OR
		     ($2 = 'system' AND a.is_system = TRUE)
		   )`,
		query, owner,
	).Scan(&total)
	if err != nil {
		return nil, 0, err
	}

	rows, err := s.pool.Query(ctx, `
		SELECT
			mb.id,
			mb.account_id,
			a.username,
			a.is_admin,
			a.is_system,
			mb.address,
			mb.domain_id,
			mb.full_address,
			mb.is_catchall,
			COUNT(e.id)::INT AS email_count,
			MAX(e.received_at) AS last_received_at,
			mb.created_at,
			mb.expires_at
		FROM mailboxes mb
		JOIN accounts a ON a.id = mb.account_id
		LEFT JOIN emails e ON e.mailbox_id = mb.id
		WHERE mb.is_catchall = TRUE
		  AND ($1 = '' OR mb.full_address ILIKE '%' || $1 || '%' OR a.username ILIKE '%' || $1 || '%')
		  AND (
		    $2 = '' OR $2 = 'all' OR
		    ($2 = 'admin' AND a.is_admin = TRUE AND a.is_system = FALSE) OR
		    ($2 = 'user' AND a.is_admin = FALSE AND a.is_system = FALSE) OR
		    ($2 = 'system' AND a.is_system = TRUE)
		  )
		GROUP BY mb.id, a.username, a.is_admin, a.is_system
		ORDER BY MAX(e.received_at) DESC NULLS LAST, mb.created_at DESC
		LIMIT $3 OFFSET $4
	`, query, owner, size, (page-1)*size)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	result := make([]model.CatchallMailboxSummary, 0)
	for rows.Next() {
		var item model.CatchallMailboxSummary
		if err := rows.Scan(
			&item.ID,
			&item.AccountID,
			&item.OwnerUsername,
			&item.OwnerIsAdmin,
			&item.OwnerIsSystem,
			&item.Address,
			&item.DomainID,
			&item.FullAddress,
			&item.IsCatchall,
			&item.EmailCount,
			&item.LastReceivedAt,
			&item.CreatedAt,
			&item.ExpiresAt,
		); err != nil {
			return nil, 0, err
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	return result, total, nil
}

func (s *Store) UpsertCatchallMailbox(ctx context.Context, accountID uuid.UUID, address string, domainID int, fullAddress string, ttlMinutes int) (*model.Mailbox, error) {
	expiresAt := mailboxExpiresAt(ttlMinutes)
	var m model.Mailbox
	err := s.pool.QueryRow(ctx,
		`INSERT INTO mailboxes (account_id, address, domain_id, full_address, expires_at, is_catchall, is_permanent)
		 VALUES ($1, $2, $3, $4, $5, TRUE, FALSE)
		 ON CONFLICT (full_address) DO UPDATE
		   SET expires_at = COALESCE(GREATEST(mailboxes.expires_at, EXCLUDED.expires_at), EXCLUDED.expires_at)
		 RETURNING id, account_id, address, domain_id, full_address, is_catchall, is_permanent, created_at, expires_at`,
		accountID, address, domainID, fullAddress, expiresAt,
	).Scan(&m.ID, &m.AccountID, &m.Address, &m.DomainID, &m.FullAddress, &m.IsCatchall, &m.IsPermanent, &m.CreatedAt, &m.ExpiresAt)
	if err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *Store) RefreshCatchallMailbox(ctx context.Context, mailboxID uuid.UUID, ttlMinutes int) (*model.Mailbox, error) {
	expiresAt := mailboxExpiresAt(ttlMinutes)
	var m model.Mailbox
	err := s.pool.QueryRow(ctx,
		`UPDATE mailboxes
		 SET expires_at = COALESCE(GREATEST(expires_at, $2), $2)
		 WHERE id = $1 AND is_catchall = TRUE
		 RETURNING id, account_id, address, domain_id, full_address, is_catchall, is_permanent, created_at, expires_at`,
		mailboxID, expiresAt,
	).Scan(&m.ID, &m.AccountID, &m.Address, &m.DomainID, &m.FullAddress, &m.IsCatchall, &m.IsPermanent, &m.CreatedAt, &m.ExpiresAt)
	if err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *Store) ReassignCatchallMailbox(ctx context.Context, mailboxID uuid.UUID, accountID uuid.UUID, ttlMinutes int) (*model.Mailbox, error) {
	expiresAt := mailboxExpiresAt(ttlMinutes)
	var m model.Mailbox
	err := s.pool.QueryRow(ctx,
		`UPDATE mailboxes
		 SET account_id = $2,
		     is_catchall = TRUE,
		     is_permanent = FALSE,
		     expires_at = COALESCE(GREATEST(expires_at, $3), $3)
		 WHERE id = $1 AND is_catchall = TRUE
		 RETURNING id, account_id, address, domain_id, full_address, is_catchall, is_permanent, created_at, expires_at`,
		mailboxID, accountID, expiresAt,
	).Scan(&m.ID, &m.AccountID, &m.Address, &m.DomainID, &m.FullAddress, &m.IsCatchall, &m.IsPermanent, &m.CreatedAt, &m.ExpiresAt)
	if err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *Store) ClaimCatchallMailbox(ctx context.Context, mailboxID uuid.UUID, accountID uuid.UUID, ttlMinutes int, isPermanent bool) (*model.Mailbox, error) {
	var expiresAt *time.Time
	if !isPermanent {
		expiresAt = mailboxExpiresAt(ttlMinutes)
	}
	var m model.Mailbox
	err := s.pool.QueryRow(ctx,
		`UPDATE mailboxes
		 SET account_id = $2,
		     is_catchall = FALSE,
		     is_permanent = $4,
		     expires_at = CASE
		       WHEN $4 THEN NULL
		       ELSE COALESCE(GREATEST(expires_at, $3), $3)
		     END
		 WHERE id = $1 AND is_catchall = TRUE
		 RETURNING id, account_id, address, domain_id, full_address, is_catchall, is_permanent, created_at, expires_at`,
		mailboxID, accountID, expiresAt, isPermanent,
	).Scan(&m.ID, &m.AccountID, &m.Address, &m.DomainID, &m.FullAddress, &m.IsCatchall, &m.IsPermanent, &m.CreatedAt, &m.ExpiresAt)
	if err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *Store) UpdateMailboxPermanentStatus(ctx context.Context, mailboxID, accountID uuid.UUID, ttlMinutes int, isPermanent bool) (*model.Mailbox, error) {
	var expiresAt *time.Time
	if !isPermanent {
		expiresAt = mailboxExpiresAt(ttlMinutes)
	}

	var m model.Mailbox
	err := s.pool.QueryRow(ctx,
		`UPDATE mailboxes
		 SET is_permanent = $3,
		     expires_at = CASE
		       WHEN $3 THEN NULL
		       ELSE COALESCE(GREATEST(expires_at, $4), $4)
		     END
		 WHERE id = $1 AND account_id = $2 AND is_catchall = FALSE
		 RETURNING id, account_id, address, domain_id, full_address, is_catchall, is_permanent, created_at, expires_at`,
		mailboxID, accountID, isPermanent, expiresAt,
	).Scan(&m.ID, &m.AccountID, &m.Address, &m.DomainID, &m.FullAddress, &m.IsCatchall, &m.IsPermanent, &m.CreatedAt, &m.ExpiresAt)
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// DeleteExpiredMailboxes 刪除已过期的邮箱（及其所有邮件）
func (s *Store) DeleteExpiredMailboxes(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM mailboxes WHERE is_permanent = FALSE AND expires_at IS NOT NULL AND expires_at < NOW()`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// CheckDomainMX 检测域名MX记录是否指向指定服务器IP
func CheckDomainMX(domain, serverIP string) (matched bool, mxHosts []string, status string) {
	lookupDomain := DomainMXLookupName(domain)
	mxRecords, err := net.LookupMX(lookupDomain)
	if err != nil {
		if lookupDomain != domain {
			return false, nil, fmt.Sprintf("DNS查询失败: %v（通配探测域名 %s）", err, lookupDomain)
		}
		return false, nil, fmt.Sprintf("DNS查询失败: %v", err)
	}
	if len(mxRecords) == 0 {
		if lookupDomain != domain {
			return false, nil, fmt.Sprintf("未找到MX记录，请先为通配子域配置 MX（探测域名 %s）", lookupDomain)
		}
		return false, nil, "未找到MX记录，请先配置MX记录"
	}
	for _, mx := range mxRecords {
		host := strings.TrimSuffix(mx.Host, ".")
		mxHosts = append(mxHosts, host)
		addrs, err := net.LookupHost(host)
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			if addr == serverIP {
				if lookupDomain != domain {
					return true, mxHosts, fmt.Sprintf("✓ 通配 MX 记录匹配：%s（探测 %s → %s）", host, lookupDomain, addr)
				}
				return true, mxHosts, fmt.Sprintf("✓ MX记录匹配：%s → %s", host, addr)
			}
		}
	}
	if lookupDomain != domain {
		return false, mxHosts, fmt.Sprintf("通配域名的 MX 记录(%s)未指向本服务器(%s)，探测域名 %s", strings.Join(mxHosts, ","), serverIP, lookupDomain)
	}
	return false, mxHosts, fmt.Sprintf("MX记录(%s)未指向本服务器(%s)", strings.Join(mxHosts, ","), serverIP)
}

func (s *Store) ResolveUnknownRecipientOwner(ctx context.Context, policy string) (*model.Account, error) {
	if NormalizeUnknownRecipientPolicy(policy) == UnknownRecipientPolicyAdminOnly {
		if configured, err := s.GetConfiguredCatchallAdmin(ctx); err == nil {
			return configured, nil
		}
		return s.GetPrimaryActiveAdmin(ctx)
	}
	return s.GetAccountByUsername(ctx, CatchallSystemUsername)
}

func (s *Store) GetConfiguredCatchallAdmin(ctx context.Context) (*model.Account, error) {
	value, err := s.GetSetting(ctx, "catchall_admin_account_id")
	if err != nil {
		return nil, err
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, pgx.ErrNoRows
	}

	accountID, err := uuid.Parse(value)
	if err != nil {
		return nil, err
	}
	account, err := s.GetAccountByID(ctx, accountID)
	if err != nil {
		return nil, err
	}
	if !account.IsAdmin || !account.IsActive || account.IsSystem {
		return nil, pgx.ErrNoRows
	}
	return account, nil
}

// ==================== Email ====================

func (s *Store) InsertEmail(ctx context.Context, mailboxID uuid.UUID, sender, subject, bodyText, bodyHTML, raw string) (*model.Email, error) {
	var e model.Email
	err := s.pool.QueryRow(ctx,
		`INSERT INTO emails (mailbox_id, sender, subject, body_text, body_html, raw_message, size_bytes)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING id, mailbox_id, sender, subject, body_text, body_html, raw_message, size_bytes, received_at`,
		mailboxID, sender, subject, bodyText, bodyHTML, raw, len(raw),
	).Scan(&e.ID, &e.MailboxID, &e.Sender, &e.Subject, &e.BodyText, &e.BodyHTML, &e.RawMessage, &e.SizeBytes, &e.ReceivedAt)
	if err != nil {
		return nil, err
	}
	return &e, nil
}

func (s *Store) ListEmails(ctx context.Context, mailboxID uuid.UUID, page, size int, query string) ([]model.EmailSummary, int, error) {
	var total int
	err := s.pool.QueryRow(ctx,
		`SELECT COUNT(*)
		 FROM emails
		 WHERE mailbox_id = $1
		   AND ($2 = '' OR sender ILIKE '%' || $2 || '%' OR subject ILIKE '%' || $2 || '%' OR COALESCE(body_text, '') ILIKE '%' || $2 || '%')`, mailboxID, query).Scan(&total)
	if err != nil {
		return nil, 0, err
	}

	rows, err := s.pool.Query(ctx,
		`SELECT id, sender, subject, size_bytes, received_at
		 FROM emails
		 WHERE mailbox_id = $1
		   AND ($2 = '' OR sender ILIKE '%' || $2 || '%' OR subject ILIKE '%' || $2 || '%' OR COALESCE(body_text, '') ILIKE '%' || $2 || '%')
		 ORDER BY received_at DESC LIMIT $3 OFFSET $4`,
		mailboxID, query, size, (page-1)*size,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	emails, err := pgx.CollectRows(rows, pgx.RowToStructByPos[model.EmailSummary])
	if err != nil {
		return nil, 0, err
	}
	return emails, total, nil
}

func (s *Store) GetEmail(ctx context.Context, emailID uuid.UUID, mailboxID uuid.UUID) (*model.Email, error) {
	var e model.Email
	err := s.pool.QueryRow(ctx,
		`SELECT id, mailbox_id, sender, subject, body_text, body_html, raw_message, size_bytes, received_at
		 FROM emails WHERE id = $1 AND mailbox_id = $2`,
		emailID, mailboxID,
	).Scan(&e.ID, &e.MailboxID, &e.Sender, &e.Subject, &e.BodyText, &e.BodyHTML, &e.RawMessage, &e.SizeBytes, &e.ReceivedAt)
	if err != nil {
		return nil, err
	}
	return &e, nil
}

func (s *Store) DeleteEmail(ctx context.Context, emailID uuid.UUID, mailboxID uuid.UUID) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM emails WHERE id = $1 AND mailbox_id = $2`, emailID, mailboxID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

// ==================== Helpers ====================

func generateAPIKey() string {
	b := make([]byte, 24)
	rand.Read(b)
	return "tm_" + hex.EncodeToString(b)
}

func GenerateRandomAddress() string {
	return generateRandomToken(10)
}

func GenerateRandomSubdomainLabel() string {
	return generateRandomToken(8)
}

func generateRandomToken(length int) string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
	result := make([]byte, length)
	for i := range result {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(chars))))
		result[i] = chars[n.Int64()]
	}
	return string(result)
}
