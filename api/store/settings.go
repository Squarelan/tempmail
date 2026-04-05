package store

import (
	"context"
	"strconv"
	"strings"
	"time"
)

const (
	CatchallSystemUsername          = "_catchall"
	UnknownRecipientPolicyClaimable = "claimable"
	UnknownRecipientPolicyAdminOnly = "admin_only"
	DefaultPermanentMailboxQuota    = 5
	DefaultReservedMailboxAddresses = "admin\nadministrator\nroot\nsystem\nsupport\nnoreply\nno-reply\nno_reply\nnotification\nnotifications\nnotify\nalerts\nmailer-daemon\npostmaster\nhostmaster\nwebmaster\nsecurity\nabuse\ndaemon"
)

func NormalizeUnknownRecipientPolicy(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case UnknownRecipientPolicyAdminOnly:
		return UnknownRecipientPolicyAdminOnly
	default:
		return UnknownRecipientPolicyClaimable
	}
}

// GetSetting 读取单个配置项
func (s *Store) GetSetting(ctx context.Context, key string) (string, error) {
	var value string
	err := s.pool.QueryRow(ctx,
		`SELECT value FROM app_settings WHERE key = $1`, key,
	).Scan(&value)
	return value, err
}

// SetSetting 写入配置项（upsert）
func (s *Store) SetSetting(ctx context.Context, key, value string) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO app_settings (key, value, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3`,
		key, value, time.Now(),
	)
	return err
}

func (s *Store) GetSettingWithFallback(ctx context.Context, key, fallback string) string {
	value, err := s.GetSetting(ctx, key)
	if err == nil {
		value = strings.TrimSpace(value)
		if value != "" {
			return value
		}
	}
	return strings.TrimSpace(fallback)
}

func (s *Store) GetSMTPServerIP(ctx context.Context, fallback string) string {
	return s.GetSettingWithFallback(ctx, "smtp_server_ip", fallback)
}

func (s *Store) GetSMTPHostname(ctx context.Context, fallback string) string {
	return s.GetSettingWithFallback(ctx, "smtp_hostname", fallback)
}

func (s *Store) GetMailboxTTLMinutes(ctx context.Context) int {
	value, err := s.GetSetting(ctx, "mailbox_ttl_minutes")
	if err != nil {
		return 30
	}
	n, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || n <= 0 {
		return 30
	}
	return n
}

func (s *Store) GetUnknownRecipientPolicy(ctx context.Context) string {
	value, err := s.GetSetting(ctx, "unknown_recipient_policy")
	if err != nil {
		return UnknownRecipientPolicyClaimable
	}
	return NormalizeUnknownRecipientPolicy(value)
}

func ParseReservedMailboxAddresses(value string) map[string]struct{} {
	result := make(map[string]struct{})
	for _, item := range strings.FieldsFunc(value, func(r rune) bool {
		switch r {
		case ',', '\n', '\r', '\t', ';', ' ':
			return true
		default:
			return false
		}
	}) {
		normalized := strings.ToLower(strings.TrimSpace(item))
		if normalized == "" {
			continue
		}
		result[normalized] = struct{}{}
	}
	return result
}

func NormalizeReservedMailboxAddresses(value string) string {
	seen := make(map[string]struct{})
	normalized := make([]string, 0)
	for _, item := range strings.FieldsFunc(value, func(r rune) bool {
		switch r {
		case ',', '\n', '\r', '\t', ';', ' ':
			return true
		default:
			return false
		}
	}) {
		entry := strings.ToLower(strings.TrimSpace(item))
		if entry == "" {
			continue
		}
		if _, exists := seen[entry]; exists {
			continue
		}
		seen[entry] = struct{}{}
		normalized = append(normalized, entry)
	}
	return strings.Join(normalized, "\n")
}

func (s *Store) GetReservedMailboxAddresses(ctx context.Context) map[string]struct{} {
	value, err := s.GetSetting(ctx, "reserved_mailbox_addresses")
	if err != nil {
		value = DefaultReservedMailboxAddresses
	}
	return ParseReservedMailboxAddresses(value)
}

func (s *Store) GetSubdomainWordlist(ctx context.Context) []string {
	value, err := s.GetSetting(ctx, "subdomain_wordlist")
	if err != nil {
		return append([]string(nil), DefaultSubdomainWordlist...)
	}
	return ParseSubdomainWordlist(value)
}

// GetAllSettings 读取所有配置项
func (s *Store) GetAllSettings(ctx context.Context) (map[string]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT key, value FROM app_settings`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]string)
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		result[k] = v
	}
	return result, rows.Err()
}
