package handler

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"tempmail/middleware"
	"tempmail/store"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

type AccountHandler struct {
	store *store.Store
}

func NewAccountHandler(s *store.Store) *AccountHandler {
	return &AccountHandler{store: s}
}

// POST /api/admin/accounts - 创建账号（管理员）
func (h *AccountHandler) Create(c *gin.Context) {
	var req struct {
		Username string `json:"username" binding:"required,min=2,max=64"`
		IsAdmin  bool   `json:"is_admin"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	account, err := h.store.CreateAccount(c.Request.Context(), req.Username, req.IsAdmin)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": "username already exists or db error: " + err.Error()})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"id":                      account.ID,
		"username":                account.Username,
		"api_key":                 account.APIKey,
		"is_admin":                account.IsAdmin,
		"is_system":               account.IsSystem,
		"permanent_mailbox_quota": account.PermanentMailboxQuota,
	})
}

// GET /api/admin/accounts - 列出所有账号（管理员）
func (h *AccountHandler) List(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "20"))
	query := strings.TrimSpace(c.DefaultQuery("q", ""))
	role := strings.ToLower(strings.TrimSpace(c.DefaultQuery("role", "all")))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 100 {
		size = 20
	}
	switch role {
	case "", "all", "admin", "user", "system":
	default:
		role = "all"
	}

	accounts, total, err := h.store.ListAccounts(c.Request.Context(), page, size, query, role)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"data":  accounts,
		"total": total,
		"page":  page,
		"size":  size,
	})
}

// DELETE /api/admin/accounts/:id - 删除账号（管理员）
func (h *AccountHandler) Delete(c *gin.Context) {
	id, err := parseUUID(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid account id"})
		return
	}

	target, err := h.store.GetAccountByID(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "account not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if target.IsSystem {
		c.JSON(http.StatusBadRequest, gin.H{"error": "system account cannot be deleted"})
		return
	}
	catchallCount, err := h.store.CountCatchallMailboxesByAccount(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if catchallCount > 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "account still owns catch-all mailboxes; clear or claim them first"})
		return
	}
	if target.IsAdmin && target.IsActive {
		activeAdmins, err := h.store.CountActiveAdmins(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if activeAdmins <= 1 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "at least one active admin account must remain"})
			return
		}
	}

	if err := h.store.DeleteAccount(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	_ = h.clearCatchallAdminSettingIfMatches(c, id.String())

	c.JSON(http.StatusOK, gin.H{"message": "account deleted"})
}

// PUT /api/admin/accounts/:id/admin - 设置/取消管理员（管理员）
func (h *AccountHandler) SetAdmin(c *gin.Context) {
	id, err := parseUUID(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid account id"})
		return
	}

	target, err := h.store.GetAccountByID(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "account not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if target.IsSystem {
		c.JSON(http.StatusBadRequest, gin.H{"error": "system account cannot change admin role"})
		return
	}

	var req struct {
		IsAdmin bool `json:"is_admin"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if target.IsAdmin == req.IsAdmin {
		c.JSON(http.StatusOK, gin.H{"message": "account role unchanged", "account": target})
		return
	}

	if !req.IsAdmin {
		catchallCount, err := h.store.CountCatchallMailboxesByAccount(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if catchallCount > 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "account still owns catch-all mailboxes; cannot remove admin role"})
			return
		}
		if target.IsActive {
			activeAdmins, err := h.store.CountActiveAdmins(c.Request.Context())
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			if activeAdmins <= 1 {
				c.JSON(http.StatusBadRequest, gin.H{"error": "at least one active admin account must remain"})
				return
			}
		}
	}

	account, err := h.store.SetAccountAdmin(c.Request.Context(), id, req.IsAdmin)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if !req.IsAdmin {
		_ = h.clearCatchallAdminSettingIfMatches(c, id.String())
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "account role updated",
		"account": account,
	})
}

// PUT /api/admin/accounts/:id/quota - 调整永久邮箱额度（管理员）
func (h *AccountHandler) SetPermanentQuota(c *gin.Context) {
	id, err := parseUUID(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid account id"})
		return
	}

	target, err := h.store.GetAccountByID(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "account not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if target.IsSystem {
		c.JSON(http.StatusBadRequest, gin.H{"error": "system account quota cannot be changed"})
		return
	}

	var req struct {
		PermanentMailboxQuota int `json:"permanent_mailbox_quota"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.PermanentMailboxQuota < 0 || req.PermanentMailboxQuota > 100000 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "permanent_mailbox_quota must be between 0 and 100000"})
		return
	}

	account, err := h.store.SetAccountPermanentQuota(c.Request.Context(), id, req.PermanentMailboxQuota)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "permanent mailbox quota updated",
		"account": account,
	})
}

// GET /api/me - 查看当前账号信息
func (h *AccountHandler) Me(c *gin.Context) {
	account := middleware.GetAccount(c)
	permanentCount, err := h.store.CountPermanentMailboxesByAccount(c.Request.Context(), account.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"id":                      account.ID,
		"username":                account.Username,
		"is_admin":                account.IsAdmin,
		"is_system":               account.IsSystem,
		"permanent_mailbox_quota": account.PermanentMailboxQuota,
		"permanent_mailbox_count": permanentCount,
		"created_at":              account.CreatedAt,
	})
}

func (h *AccountHandler) clearCatchallAdminSettingIfMatches(c *gin.Context, accountID string) error {
	value, err := h.store.GetSetting(c.Request.Context(), "catchall_admin_account_id")
	if err != nil {
		return nil
	}
	if value != accountID {
		return nil
	}
	return h.store.SetSetting(c.Request.Context(), "catchall_admin_account_id", "")
}
