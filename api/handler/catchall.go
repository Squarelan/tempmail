package handler

import (
	"errors"
	"net/http"
	"strconv"

	"tempmail/model"
	"tempmail/store"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

type CatchallHandler struct {
	store *store.Store
}

func NewCatchallHandler(s *store.Store) *CatchallHandler {
	return &CatchallHandler{store: s}
}

// GET /api/admin/catchall/mailboxes - 管理员查看所有 catch-all 邮箱
func (h *CatchallHandler) ListMailboxes(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "50"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 200 {
		size = 50
	}

	mailboxes, total, err := h.store.ListCatchallMailboxes(c.Request.Context(), page, size)
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

// DELETE /api/admin/catchall/mailboxes/:id - 删除 catch-all 邮箱及其邮件
func (h *CatchallHandler) DeleteMailbox(c *gin.Context) {
	mailboxID, err := parseUUID(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid mailbox id"})
		return
	}

	if err := h.store.DeleteCatchallMailbox(c.Request.Context(), mailboxID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "catch-all mailbox not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "catch-all mailbox deleted"})
}

// GET /api/admin/catchall/mailboxes/:id/emails - 查看 catch-all 邮件列表
func (h *CatchallHandler) ListEmails(c *gin.Context) {
	mailbox, ok := h.requireCatchallMailbox(c)
	if !ok {
		return
	}

	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "20"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 100 {
		size = 20
	}

	emails, total, err := h.store.ListEmails(c.Request.Context(), mailbox.ID, page, size)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"data":  emails,
		"total": total,
		"page":  page,
		"size":  size,
	})
}

// GET /api/admin/catchall/mailboxes/:id/emails/:email_id - 查看单封 catch-all 邮件
func (h *CatchallHandler) GetEmail(c *gin.Context) {
	mailbox, ok := h.requireCatchallMailbox(c)
	if !ok {
		return
	}

	emailID, err := parseUUID(c.Param("email_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid email id"})
		return
	}

	email, err := h.store.GetEmail(c.Request.Context(), emailID, mailbox.ID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "email not found"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"email": email})
}

// DELETE /api/admin/catchall/mailboxes/:id/emails/:email_id - 删除 catch-all 邮件
func (h *CatchallHandler) DeleteEmail(c *gin.Context) {
	mailbox, ok := h.requireCatchallMailbox(c)
	if !ok {
		return
	}

	emailID, err := parseUUID(c.Param("email_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid email id"})
		return
	}

	if err := h.store.DeleteEmail(c.Request.Context(), emailID, mailbox.ID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "email not found"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "email deleted"})
}

func (h *CatchallHandler) requireCatchallMailbox(c *gin.Context) (*model.Mailbox, bool) {
	mailboxID, err := parseUUID(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid mailbox id"})
		return nil, false
	}

	mailbox, err := h.store.GetMailboxByID(c.Request.Context(), mailboxID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "catch-all mailbox not found"})
			return nil, false
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return nil, false
	}
	if !mailbox.IsCatchall {
		c.JSON(http.StatusNotFound, gin.H{"error": "catch-all mailbox not found"})
		return nil, false
	}
	return mailbox, true
}
