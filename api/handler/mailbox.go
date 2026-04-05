package handler

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"tempmail/middleware"
	"tempmail/model"
	"tempmail/store"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type MailboxHandler struct {
	store *store.Store
}

func NewMailboxHandler(s *store.Store) *MailboxHandler {
	return &MailboxHandler{store: s}
}

var mailboxAddressPattern = regexp.MustCompile(`^[a-z0-9_-]{1,128}$`)

const autoSubdomainMaxAttempts = 24

var errAutoSubdomainExhausted = errors.New("auto_subdomain exhausted")

func isMailboxUniqueConflict(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "duplicate") || strings.Contains(message, "unique")
}

func generateAutoSubdomainHost(wildcardRule, subdomainMode string, wordlist []string) string {
	return fmt.Sprintf("%s.%s", store.GenerateSubdomainLabelWithWordlist(subdomainMode, wordlist), store.WildcardBaseDomain(wildcardRule))
}

func (h *MailboxHandler) createMailboxWithAutoSubdomain(c *gin.Context, accountID uuid.UUID, address string, domainRecord *model.Domain, ttlMinutes int, isPermanent bool, subdomainMode string) (*model.Mailbox, string, error) {
	wordlist := h.store.GetSubdomainWordlist(c.Request.Context())
	for attempt := 0; attempt < autoSubdomainMaxAttempts; attempt++ {
		actualDomain := generateAutoSubdomainHost(domainRecord.Domain, subdomainMode, wordlist)
		fullAddress := fmt.Sprintf("%s@%s", address, actualDomain)

		_, err := h.store.GetMailboxByFullAddress(c.Request.Context(), fullAddress)
		switch {
		case err == nil:
			continue
		case !errors.Is(err, pgx.ErrNoRows):
			return nil, "", err
		}

		mailbox, err := h.store.CreateMailbox(c.Request.Context(), accountID, address, domainRecord.ID, fullAddress, ttlMinutes, isPermanent)
		if err != nil {
			if isMailboxUniqueConflict(err) {
				continue
			}
			return nil, "", err
		}
		return mailbox, actualDomain, nil
	}

	return nil, "", errAutoSubdomainExhausted
}

// POST /api/mailboxes - 创建临时邮箱
// 请求体字段均为可选：
//
//	address        — 本地部分（@ 前），为空则随机生成
//	domain         — 指定域名（须是已激活域名），为空则随机选取
//	auto_subdomain — 当 domain=*.example.com 时自动分配真实子域
//	subdomain_mode — auto_subdomain 下可选 random / wordlist，默认 random
func (h *MailboxHandler) Create(c *gin.Context) {
	account := middleware.GetAccount(c)

	var req struct {
		Address       string `json:"address"`
		Domain        string `json:"domain"`
		Permanent     bool   `json:"permanent"`
		AutoSubdomain bool   `json:"auto_subdomain"`
		SubdomainMode string `json:"subdomain_mode"`
	}
	c.ShouldBindJSON(&req)

	address := strings.TrimSpace(req.Address)
	if address == "" {
		address = store.GenerateRandomAddress()
	}
	address = strings.ToLower(address)
	if !mailboxAddressPattern.MatchString(address) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid address: only lowercase letters, numbers, hyphen and underscore are allowed"})
		return
	}
	if !account.IsAdmin {
		if _, exists := h.store.GetReservedMailboxAddresses(c.Request.Context())[address]; exists {
			c.JSON(http.StatusForbidden, gin.H{"error": "this mailbox address is reserved and can only be created by administrators"})
			return
		}
	}

	// 读取 TTL 设置
	ttlMinutes := h.store.GetMailboxTTLMinutes(c.Request.Context())
	isPermanent := req.Permanent
	useAutoSubdomain := req.AutoSubdomain
	subdomainMode := store.NormalizeSubdomainGenerationMode(req.SubdomainMode)
	if strings.TrimSpace(req.SubdomainMode) != "" && subdomainMode == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid subdomain_mode: only random or wordlist are supported"})
		return
	}
	if subdomainMode == "" {
		subdomainMode = store.SubdomainModeRandom
	}

	// 确定域名：指定 or 随机
	var domainRecord *model.Domain
	if d := strings.TrimSpace(strings.ToLower(req.Domain)); d != "" {
		normalizedDomain, err := store.NormalizeManagedDomain(d)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid domain: " + err.Error()})
			return
		}
		if store.IsWildcardDomain(normalizedDomain) {
			if !useAutoSubdomain {
				c.JSON(http.StatusBadRequest, gin.H{"error": "wildcard domain rules cannot be used directly; set auto_subdomain=true to let the API allocate a real subdomain automatically, or specify a real subdomain such as inbox." + store.WildcardBaseDomain(normalizedDomain)})
				return
			}

			found, err := h.store.GetDomainByName(c.Request.Context(), normalizedDomain)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "wildcard domain rule not found or not active: " + normalizedDomain})
				return
			}
			domainRecord = found
			req.Domain = normalizedDomain
		} else {
			if useAutoSubdomain {
				c.JSON(http.StatusBadRequest, gin.H{"error": "auto_subdomain requires domain to be a wildcard rule like *.example.com"})
				return
			}

			found, err := h.store.ResolveActiveDomain(c.Request.Context(), normalizedDomain)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "domain not found or not active: " + normalizedDomain})
				return
			}
			domainRecord = found
			req.Domain = normalizedDomain
		}
	} else {
		if useAutoSubdomain {
			c.JSON(http.StatusBadRequest, gin.H{"error": "auto_subdomain requires domain to be a wildcard rule like *.example.com"})
			return
		}

		found, err := h.store.GetRandomActiveDomain(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "no active domains available"})
			return
		}
		domainRecord = found
		req.Domain = found.Domain
	}

	fullAddress := fmt.Sprintf("%s@%s", address, req.Domain)
	ensurePermanentQuota := func() bool {
		if !isPermanent || account.IsAdmin {
			return true
		}
		permanentCount, err := h.store.CountPermanentMailboxesByAccount(c.Request.Context(), account.ID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return false
		}
		if permanentCount >= account.PermanentMailboxQuota {
			c.JSON(http.StatusConflict, gin.H{"error": fmt.Sprintf("permanent mailbox quota reached (%d/%d)", permanentCount, account.PermanentMailboxQuota)})
			return false
		}
		return true
	}

	if useAutoSubdomain {
		if !ensurePermanentQuota() {
			return
		}

		mailbox, generatedDomain, err := h.createMailboxWithAutoSubdomain(c, account.ID, address, domainRecord, ttlMinutes, isPermanent, subdomainMode)
		if err != nil {
			if errors.Is(err, errAutoSubdomainExhausted) {
				c.JSON(http.StatusConflict, gin.H{"error": "could not allocate a unique wildcard subdomain, please retry"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		c.JSON(http.StatusCreated, gin.H{
			"mailbox":          mailbox,
			"claimed":          false,
			"auto_subdomain":   true,
			"subdomain_mode":   subdomainMode,
			"generated_domain": generatedDomain,
			"message":          "wildcard subdomain allocated automatically",
		})
		return
	}

	existing, err := h.store.GetMailboxByFullAddress(c.Request.Context(), fullAddress)
	switch {
	case err == nil:
		if existing.AccountID == account.ID {
			if existing.IsCatchall {
				if !ensurePermanentQuota() {
					return
				}
				mailbox, claimErr := h.store.ClaimCatchallMailbox(c.Request.Context(), existing.ID, account.ID, ttlMinutes, isPermanent)
				if claimErr != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": claimErr.Error()})
					return
				}
				c.JSON(http.StatusOK, gin.H{
					"mailbox": mailbox,
					"claimed": true,
					"message": "catch-all mailbox converted to owned mailbox",
				})
				return
			}
			if isPermanent && !existing.IsPermanent {
				if !ensurePermanentQuota() {
					return
				}
				mailbox, updateErr := h.store.UpdateMailboxPermanentStatus(c.Request.Context(), existing.ID, account.ID, ttlMinutes, true)
				if updateErr != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": updateErr.Error()})
					return
				}
				c.JSON(http.StatusOK, gin.H{
					"mailbox": mailbox,
					"claimed": false,
					"message": "mailbox upgraded to permanent",
				})
				return
			}
			c.JSON(http.StatusOK, gin.H{
				"mailbox": existing,
				"claimed": false,
				"message": "mailbox already exists",
			})
			return
		}

		if existing.IsCatchall {
			policy := h.store.GetUnknownRecipientPolicy(c.Request.Context())
			if policy == store.UnknownRecipientPolicyAdminOnly && !account.IsAdmin {
				c.JSON(http.StatusConflict, gin.H{"error": "unknown-recipient catch-all is in admin-only mode; normal users cannot claim this address"})
				return
			}
			if !ensurePermanentQuota() {
				return
			}

			mailbox, claimErr := h.store.ClaimCatchallMailbox(c.Request.Context(), existing.ID, account.ID, ttlMinutes, isPermanent)
			if claimErr != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": claimErr.Error()})
				return
			}
			c.JSON(http.StatusCreated, gin.H{
				"mailbox": mailbox,
				"claimed": true,
				"message": "catch-all mailbox claimed",
			})
			return
		}

		c.JSON(http.StatusConflict, gin.H{"error": "address already taken, try again"})
		return

	case !errors.Is(err, pgx.ErrNoRows):
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if !ensurePermanentQuota() {
		return
	}

	mailbox, err := h.store.CreateMailbox(c.Request.Context(), account.ID, address, domainRecord.ID, fullAddress, ttlMinutes, isPermanent)
	if err != nil {
		if isMailboxUniqueConflict(err) {
			c.JSON(http.StatusConflict, gin.H{"error": "address already taken, try again"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"mailbox": mailbox,
		"claimed": false,
	})
}

// GET /api/mailboxes - 列出当前账号的邮箱
func (h *MailboxHandler) List(c *gin.Context) {
	account := middleware.GetAccount(c)
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "20"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 100 {
		size = 20
	}

	mailboxes, total, err := h.store.ListMailboxes(c.Request.Context(), account.ID, page, size)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"data":  mailboxes,
		"total": total,
		"page":  page,
		"size":  size,
	})
}

// DELETE /api/mailboxes/:id - 删除邮箱
func (h *MailboxHandler) Delete(c *gin.Context) {
	account := middleware.GetAccount(c)
	id, err := parseUUID(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid mailbox id"})
		return
	}

	if err := h.store.DeleteMailbox(c.Request.Context(), id, account.ID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "mailbox not found"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "mailbox deleted"})
}
