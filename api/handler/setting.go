package handler

import (
	"net/http"
	"strings"

	"tempmail/store"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type SettingHandler struct {
	store *store.Store
}

func NewSettingHandler(s *store.Store) *SettingHandler {
	return &SettingHandler{store: s}
}

// GET /public/settings → 返回前端需要的公开配置
func (h *SettingHandler) GetPublic(c *gin.Context) {
	regOpen, err := h.store.GetSetting(c.Request.Context(), "registration_open")
	if err != nil {
		regOpen = "false"
	}
	siteTitle, _ := h.store.GetSetting(c.Request.Context(), "site_title")
	siteLogo, _ := h.store.GetSetting(c.Request.Context(), "site_logo")
	siteSubtitle, _ := h.store.GetSetting(c.Request.Context(), "site_subtitle")
	smtpIP, _ := h.store.GetSetting(c.Request.Context(), "smtp_server_ip")
	smtpHostname, _ := h.store.GetSetting(c.Request.Context(), "smtp_hostname")
	announce, _ := h.store.GetSetting(c.Request.Context(), "announcement")
	c.JSON(http.StatusOK, gin.H{
		"registration_open": regOpen == "true",
		"site_title":        siteTitle,
		"site_logo":         siteLogo,
		"site_subtitle":     siteSubtitle,
		"smtp_server_ip":    smtpIP,
		"smtp_hostname":     smtpHostname,
		"announcement":      announce,
	})
}

// GET /api/admin/settings → 读取所有设置（管理员）
func (h *SettingHandler) AdminGetAll(c *gin.Context) {
	settings, err := h.store.GetAllSettings(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if strings.TrimSpace(settings["reserved_mailbox_addresses"]) == "" {
		settings["reserved_mailbox_addresses"] = store.DefaultReservedMailboxAddresses
	}
	if strings.TrimSpace(settings["subdomain_wordlist"]) == "" {
		settings["subdomain_wordlist"] = store.DefaultSubdomainWordlistText
	}
	c.JSON(http.StatusOK, settings)
}

// PUT /api/admin/settings → 更新设置（管理员）
func (h *SettingHandler) AdminUpdate(c *gin.Context) {
	var req map[string]string
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// 白名单：已知配置项
	allowed := map[string]bool{
		"registration_open":          true,
		"rate_limit_enabled":         true,
		"max_mailboxes_per_user":     true,
		"smtp_server_ip":             true,
		"smtp_hostname":              true,
		"site_title":                 true,
		"site_logo":                  true,
		"site_subtitle":              true,
		"announcement":               true,
		"default_domain":             true,
		"mailbox_ttl_minutes":        true,
		"reserved_mailbox_addresses": true,
		"subdomain_wordlist":         true,
		"unknown_recipient_policy":   true,
		"catchall_admin_account_id":  true,
	}

	for k, v := range req {
		if !allowed[k] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "unknown setting key: " + k})
			return
		}
		if k == "unknown_recipient_policy" {
			switch strings.ToLower(strings.TrimSpace(v)) {
			case store.UnknownRecipientPolicyClaimable, store.UnknownRecipientPolicyAdminOnly:
				v = strings.ToLower(strings.TrimSpace(v))
			default:
				c.JSON(http.StatusBadRequest, gin.H{"error": "unknown_recipient_policy must be claimable or admin_only"})
				return
			}
		}
		if k == "catchall_admin_account_id" {
			v = strings.TrimSpace(v)
			if v != "" {
				accountID, err := uuid.Parse(v)
				if err != nil {
					c.JSON(http.StatusBadRequest, gin.H{"error": "catchall_admin_account_id must be a valid UUID or empty"})
					return
				}
				account, err := h.store.GetAccountByID(c.Request.Context(), accountID)
				if err != nil {
					c.JSON(http.StatusBadRequest, gin.H{"error": "catchall admin account not found"})
					return
				}
				if !account.IsAdmin || !account.IsActive || account.IsSystem {
					c.JSON(http.StatusBadRequest, gin.H{"error": "catchall admin account must be an active non-system admin"})
					return
				}
				v = accountID.String()
			}
		}
		if k == "reserved_mailbox_addresses" {
			v = store.NormalizeReservedMailboxAddresses(v)
		}
		if k == "subdomain_wordlist" {
			v = store.NormalizeSubdomainWordlist(v)
		}
		if err := h.store.SetSetting(c.Request.Context(), k, v); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"message": "settings updated"})
}
