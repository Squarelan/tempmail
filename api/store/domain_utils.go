package store

import (
	"fmt"
	"hash/fnv"
	"strings"
)

const wildcardDomainPrefix = "*."

// NormalizeManagedDomain 规范化后台维护的域名/通配域名规则。
// 支持 example.com 与 *.example.com 两种形式。
func NormalizeManagedDomain(input string) (string, error) {
	domain := strings.ToLower(strings.TrimSpace(input))
	domain = strings.TrimSuffix(domain, ".")
	if domain == "" {
		return "", fmt.Errorf("domain is required")
	}

	isWildcard := strings.HasPrefix(domain, wildcardDomainPrefix)
	if isWildcard {
		domain = strings.TrimPrefix(domain, wildcardDomainPrefix)
		if domain == "" {
			return "", fmt.Errorf("wildcard domain must include a base domain")
		}
	}

	if strings.Contains(domain, "*") {
		return "", fmt.Errorf("wildcard is only allowed as the leading *.")
	}
	if err := validateDNSDomain(domain); err != nil {
		return "", err
	}

	if isWildcard {
		return wildcardDomainPrefix + domain, nil
	}
	return domain, nil
}

func validateDNSDomain(domain string) error {
	if len(domain) > 253 {
		return fmt.Errorf("domain is too long")
	}

	labels := strings.Split(domain, ".")
	if len(labels) < 2 {
		return fmt.Errorf("domain must contain at least one dot")
	}

	for _, label := range labels {
		if label == "" {
			return fmt.Errorf("domain contains an empty label")
		}
		if len(label) > 63 {
			return fmt.Errorf("domain label %q is too long", label)
		}
		if label[0] == '-' || label[len(label)-1] == '-' {
			return fmt.Errorf("domain label %q cannot start or end with a hyphen", label)
		}
		for _, ch := range label {
			if (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '-' {
				continue
			}
			return fmt.Errorf("domain label %q contains invalid character %q", label, ch)
		}
	}

	return nil
}

func IsWildcardDomain(domain string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(domain)), wildcardDomainPrefix)
}

func WildcardBaseDomain(domain string) string {
	normalized, err := NormalizeManagedDomain(domain)
	if err != nil {
		normalized = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(domain), "."))
	}
	return strings.TrimPrefix(normalized, wildcardDomainPrefix)
}

func DomainMatchesRule(rule, host string) bool {
	normalizedRule, err := NormalizeManagedDomain(rule)
	if err != nil {
		return false
	}
	normalizedHost, err := NormalizeManagedDomain(host)
	if err != nil {
		return false
	}

	if !IsWildcardDomain(normalizedRule) {
		return normalizedRule == normalizedHost
	}

	base := WildcardBaseDomain(normalizedRule)
	return normalizedHost != base && strings.HasSuffix(normalizedHost, "."+base)
}

// DomainMXLookupName 返回用于 MX 探测的域名。
// 通配规则会生成一个稳定且极不可能冲突的子域，用于验证 *.example.com 的 MX 是否生效。
func DomainMXLookupName(domain string) string {
	normalized, err := NormalizeManagedDomain(domain)
	if err != nil {
		return strings.ToLower(strings.TrimSuffix(strings.TrimSpace(domain), "."))
	}
	if !IsWildcardDomain(normalized) {
		return normalized
	}

	base := WildcardBaseDomain(normalized)
	hasher := fnv.New32a()
	_, _ = hasher.Write([]byte(base))
	return fmt.Sprintf("tm-wildcard-%08x.%s", hasher.Sum32(), base)
}
