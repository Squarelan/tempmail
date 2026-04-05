package store

import (
	"crypto/rand"
	"math/big"
	"strings"
)

const (
	SubdomainModeRandom   = "random"
	SubdomainModeWordlist = "wordlist"
)

var DefaultSubdomainWordlist = []string{
	"access", "account", "accounts", "admin", "admin-center", "admin-portal", "analytics", "api",
	"api-gateway", "app", "apps", "archive", "archives", "assets", "audit", "auth",
	"auth-center", "auth-gateway", "autoconfig", "autodiscover", "backend", "backup", "billing", "billing-center",
	"billing-ops", "biz", "blog", "board", "bridge", "calendar", "campus", "care",
	"careers", "case", "cdn", "center", "central", "chat", "client", "client-center",
	"client-portal", "cloud", "cloud-core", "cloud-hub", "code", "community", "compliance", "conference",
	"connect", "console", "content", "control", "core", "crm", "customer", "customer-center",
	"dashboard", "data", "data-core", "datahub", "delivery", "demo", "deploy", "desk",
	"dev", "digital", "direct", "dispatch", "docs", "domain", "domains", "download",
	"downloads", "edge", "education", "email", "eng", "enterprise", "events", "exchange",
	"extranet", "feedback", "file", "files", "finance", "finance-center", "forums", "gateway",
	"global", "group", "groups", "guide", "help", "help-center", "helpdesk", "hub",
	"id", "identity", "images", "imap", "index", "infra", "internal", "intranet",
	"jobs", "kb", "knowledge", "library", "link", "links", "live", "login",
	"mail", "mail-center", "mail-gateway", "mail-hub", "mailbox", "manage", "manager", "member",
	"member-center", "member-portal", "members", "message", "messaging", "mobile", "monitor", "monitoring",
	"mx", "network", "news", "newsletter", "noc", "notice", "notify", "office",
	"ops", "ops-center", "ops-hub", "panel", "partner", "partner-center", "partner-portal", "pay",
	"pay-center", "payment", "payments", "people", "platform", "portal", "preview", "private",
	"project", "project-center", "projects", "proxy", "qa", "register", "registry", "relay",
	"remote", "report", "reports", "research", "sandbox", "search", "secure", "security",
	"service", "service-center", "service-desk", "service-hub", "services", "share", "site", "sites",
	"smtp", "source", "staff", "staff-center", "stage", "staging", "start", "static",
	"status", "storage", "store", "support", "support-center", "support-desk", "support-hub", "sync",
	"sys", "system", "team", "team-center", "team-hub", "teams", "test", "testing",
	"ticket", "tickets", "tools", "tracking", "training", "update", "upload", "user",
	"user-center", "users", "vault", "verify", "web", "webmail", "wiki", "work",
	"workbench", "workcenter", "workflow", "workspace", "zone",
}

var DefaultSubdomainWordlistText = strings.Join(DefaultSubdomainWordlist, "\n")

func NormalizeSubdomainGenerationMode(value string) string {
	normalized := strings.TrimSpace(strings.ToLower(value))
	switch normalized {
	case "", SubdomainModeRandom:
		return SubdomainModeRandom
	case SubdomainModeWordlist:
		return SubdomainModeWordlist
	default:
		return ""
	}
}

func GenerateSubdomainLabel(mode string) string {
	return GenerateSubdomainLabelWithWordlist(mode, DefaultSubdomainWordlist)
}

func GenerateSubdomainLabelWithWordlist(mode string, wordlist []string) string {
	switch NormalizeSubdomainGenerationMode(mode) {
	case SubdomainModeWordlist:
		return GenerateWordlistSubdomainLabel(wordlist)
	default:
		return GenerateRandomSubdomainLabel()
	}
}

func NormalizeSubdomainWordlist(value string) string {
	seen := make(map[string]struct{})
	items := make([]string, 0)
	for _, item := range strings.FieldsFunc(value, func(r rune) bool {
		switch r {
		case ',', '\n', '\r', '\t', ';', ' ':
			return true
		default:
			return false
		}
	}) {
		entry := normalizeSubdomainWord(item)
		if entry == "" {
			continue
		}
		if _, exists := seen[entry]; exists {
			continue
		}
		seen[entry] = struct{}{}
		items = append(items, entry)
	}
	return strings.Join(items, "\n")
}

func ParseSubdomainWordlist(value string) []string {
	normalized := NormalizeSubdomainWordlist(value)
	if normalized == "" {
		return append([]string(nil), DefaultSubdomainWordlist...)
	}
	return strings.Split(normalized, "\n")
}

func GenerateWordlistSubdomainLabel(wordlist []string) string {
	if len(wordlist) == 0 {
		return GenerateRandomSubdomainLabel()
	}
	label := normalizeSubdomainWord(wordlist[cryptoRandInt(len(wordlist))])
	if label == "" {
		return GenerateRandomSubdomainLabel()
	}
	return label
}

func normalizeSubdomainWord(value string) string {
	entry := strings.ToLower(strings.TrimSpace(value))
	entry = strings.Trim(entry, ".-")
	if len(entry) < 2 || len(entry) > 63 {
		return ""
	}
	for i, ch := range entry {
		switch {
		case ch >= 'a' && ch <= 'z':
		case ch >= '0' && ch <= '9':
		case ch == '-' && i > 0 && i < len(entry)-1:
		default:
			return ""
		}
	}
	return entry
}

func cryptoRandInt(max int) int {
	if max <= 1 {
		return 0
	}
	n, err := rand.Int(rand.Reader, big.NewInt(int64(max)))
	if err != nil {
		return 0
	}
	return int(n.Int64())
}
