package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"tempmail/config"
	"tempmail/handler"
	"tempmail/middleware"
	"tempmail/store"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
)

func main() {
	cfg := config.Load()

	// ==================== 连接数据库 ====================
	ctx := context.Background()
	db, err := store.New(ctx, cfg.DBDSN)
	if err != nil {
		log.Fatalf("failed to connect database: %v", err)
	}
	defer db.Close()
	log.Println("✓ Database connected")

	// ==================== 连接 Redis ====================
	rdb := redis.NewClient(&redis.Options{
		Addr:         cfg.RedisAddr,
		Password:     cfg.RedisPassword,
		DB:           0,
		PoolSize:     0, // 0 = 不限（自动按 CPU 核心数 * 10）
		MinIdleConns: 20,
		DialTimeout:  3 * time.Second,
		ReadTimeout:  2 * time.Second,
		WriteTimeout: 2 * time.Second,
	})
	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Fatalf("failed to connect redis: %v", err)
	}
	defer rdb.Close()
	log.Println("✓ Redis connected")

	// ==================== Gin 路由 ====================
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	// CORS：允许前端跨域访问
	r.Use(cors.New(cors.Config{
		AllowOrigins:  []string{"*"},
		AllowMethods:  []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders:  []string{"Origin", "Content-Type", "Authorization"},
		ExposeHeaders: []string{"X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"},
		MaxAge:        12 * time.Hour,
	}))

	// 健康检查（无需认证）
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "time": time.Now().Unix()})
	})

	// 初始化 handlers
	accountH := handler.NewAccountHandler(db)
	domainH := handler.NewDomainHandler(db, cfg.SMTPServerIP, cfg.SMTPHostname)
	mailboxH := handler.NewMailboxHandler(db)
	emailH := handler.NewEmailHandler(db)
	catchallH := handler.NewCatchallHandler(db)
	settingH := handler.NewSettingHandler(db)
	registerH := handler.NewRegisterHandler(db)
	statsH := handler.NewStatsHandler(db)

	// 公开路由（无需认证）
	public := r.Group("/public")
	{
		public.GET("/settings", settingH.GetPublic)
		public.POST("/register", registerH.Register)
		public.GET("/stats", statsH.Get)
	}

	// API 路由组（需要认证 + 速率限制）
	api := r.Group("/api")
	api.Use(middleware.Auth(db))
	api.Use(middleware.RateLimit(rdb, cfg.RateLimit, cfg.RateWindow))
	{
		// 当前用户
		api.GET("/me", accountH.Me)

		// 域名池（所有用户可查看）
		api.GET("/domains", domainH.List)
		api.GET("/domains/:id/status", domainH.GetStatus) // 任意用户可轮询域名状态
		api.GET("/stats", statsH.Get)
		// 任意已登录用户可提交域名进行 MX 自动验证
		api.POST("/domains/submit", domainH.Submit)

		// 邮箱管理
		api.POST("/mailboxes", mailboxH.Create)
		api.GET("/mailboxes", mailboxH.List)
		api.DELETE("/mailboxes/:id", mailboxH.Delete)

		// 邮件管理
		api.GET("/mailboxes/:id/emails", emailH.List)
		api.GET("/mailboxes/:id/emails/:email_id", emailH.Get)
		api.DELETE("/mailboxes/:id/emails/:email_id", emailH.Delete)
		// 管理员路由
		admin := api.Group("/admin")
		admin.Use(middleware.AdminOnly())
		{
			admin.POST("/accounts", accountH.Create)
			admin.GET("/accounts", accountH.List)
			admin.DELETE("/accounts/:id", accountH.Delete)
			admin.PUT("/accounts/:id/admin", accountH.SetAdmin)
			admin.PUT("/accounts/:id/quota", accountH.SetPermanentQuota)

			admin.GET("/catchall/mailboxes", catchallH.ListMailboxes)
			admin.DELETE("/catchall/mailboxes/:id", catchallH.DeleteMailbox)
			admin.GET("/catchall/mailboxes/:id/emails", catchallH.ListEmails)
			admin.GET("/catchall/mailboxes/:id/emails/:email_id", catchallH.GetEmail)
			admin.DELETE("/catchall/mailboxes/:id/emails/:email_id", catchallH.DeleteEmail)

			admin.POST("/domains", domainH.Add)
			admin.DELETE("/domains/:id", domainH.Delete)
			admin.PUT("/domains/:id/toggle", domainH.Toggle)
			admin.POST("/domains/mx-import", domainH.MXImport)
			admin.POST("/domains/mx-register", domainH.MXRegister)
			admin.GET("/domains/:id/status", domainH.GetStatus)

			// 系统设置管理
			admin.GET("/settings", settingH.AdminGetAll)
			admin.PUT("/settings", settingH.AdminUpdate)
		}
	}

	// 内部邮件投递接口（Postfix pipe 调用，仅内部网络）
	internal := r.Group("/internal")
	{
		// 域名列表（供 Postfix 同步）
		internal.GET("/domains", func(c *gin.Context) {
			domains, err := db.ListDomains(c.Request.Context())
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			c.JSON(http.StatusOK, gin.H{"domains": domains})
		})

		internal.POST("/deliver", func(c *gin.Context) {
			var req struct {
				Recipient string `json:"recipient" binding:"required"`
				Sender    string `json:"sender"`
				Subject   string `json:"subject"`
				BodyText  string `json:"body_text"`
				BodyHTML  string `json:"body_html"`
				Raw       string `json:"raw"`
			}
			if err := c.ShouldBindJSON(&req); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
				return
			}

			recipient := normalizeEmailAddress(req.Recipient)
			localPart, domainName, ok := splitEmailAddress(recipient)
			if !ok {
				c.JSON(http.StatusOK, gin.H{"status": "discarded", "reason": "invalid recipient"})
				return
			}

			domainRecord, err := db.ResolveActiveDomain(c.Request.Context(), domainName)
			if err != nil {
				c.JSON(http.StatusOK, gin.H{"status": "discarded", "reason": "inactive domain"})
				return
			}

			ttlMinutes := db.GetMailboxTTLMinutes(c.Request.Context())
			policy := db.GetUnknownRecipientPolicy(c.Request.Context())

			// 查找收件邮箱；不存在时按 catch-all 规则自动建箱
			mailbox, err := db.GetMailboxByFullAddress(c.Request.Context(), recipient)
			switch {
			case err == nil:
				if mailbox.IsCatchall {
					if policy == store.UnknownRecipientPolicyAdminOnly {
						owner, ownerErr := db.ResolveUnknownRecipientOwner(c.Request.Context(), policy)
						if ownerErr != nil {
							c.JSON(http.StatusInternalServerError, gin.H{"error": ownerErr.Error()})
							return
						}
						if mailbox.AccountID != owner.ID {
							mailbox, err = db.ReassignCatchallMailbox(c.Request.Context(), mailbox.ID, owner.ID, ttlMinutes)
						} else {
							mailbox, err = db.RefreshCatchallMailbox(c.Request.Context(), mailbox.ID, ttlMinutes)
						}
					} else {
						mailbox, err = db.RefreshCatchallMailbox(c.Request.Context(), mailbox.ID, ttlMinutes)
					}
					if err != nil {
						c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
						return
					}
				}
			case errors.Is(err, pgx.ErrNoRows):
				owner, ownerErr := db.ResolveUnknownRecipientOwner(c.Request.Context(), policy)
				if ownerErr != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": ownerErr.Error()})
					return
				}
				mailbox, err = db.UpsertCatchallMailbox(c.Request.Context(), owner.ID, localPart, domainRecord.ID, recipient, ttlMinutes)
				if err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
					return
				}
			default:
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}

			// 存储邮件
			email, err := db.InsertEmail(c.Request.Context(),
				mailbox.ID, req.Sender, req.Subject, req.BodyText, req.BodyHTML, req.Raw)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}

			c.JSON(http.StatusOK, gin.H{"status": "delivered", "email_id": email.ID})
		})
	}

	// ==================== 邮箱自动过期清理 ====================
	go func() {
		ticker := time.NewTicker(1 * time.Minute)
		defer ticker.Stop()
		log.Println("✓ Mailbox expiry cleaner started (TTL=30min, interval=1min)")
		for range ticker.C {
			if deleted, err := db.DeleteExpiredMailboxes(context.Background()); err != nil {
				log.Printf("[cleaner] error: %v", err)
			} else if deleted > 0 {
				log.Printf("[cleaner] deleted %d expired mailboxes", deleted)
			}
		}
	}()

	// ==================== MX 自动验证轮询 ====================
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		log.Println("✓ MX domain verifier started (pending check=30s, active re-check=6h)")
		reCheckTicker := time.NewTicker(6 * time.Hour)
		defer reCheckTicker.Stop()
		for {
			select {
			case <-ticker.C:
				// 处理待验证域名
				pendingDomains, err := db.ListPendingDomains(context.Background())
				if err != nil {
					log.Printf("[mx-verifier] list pending error: %v", err)
					continue
				}
				if len(pendingDomains) == 0 {
					continue
				}
				serverIP := db.GetSMTPServerIP(context.Background(), cfg.SMTPServerIP)
				for _, d := range pendingDomains {
					matched, _, mxStatus := store.CheckDomainMX(d.Domain, serverIP)
					db.TouchDomainCheckTime(context.Background(), d.ID)
					if matched {
						if err := db.PromoteDomainToActive(context.Background(), d.ID); err != nil {
							log.Printf("[mx-verifier] promote %s error: %v", d.Domain, err)
						} else {
							log.Printf("[mx-verifier] ✓ %s MX verified, domain activated", d.Domain)
						}
					} else {
						log.Printf("[mx-verifier] waiting: %s — %s", d.Domain, mxStatus)
					}
				}

			case <-reCheckTicker.C:
				// 每 6 小时重新检测所有已激活域名，MX 失效则自动停用
				activeDomains, err := db.GetActiveDomains(context.Background())
				if err != nil {
					log.Printf("[mx-recheck] list active error: %v", err)
					continue
				}
				serverIP := db.GetSMTPServerIP(context.Background(), cfg.SMTPServerIP)
				log.Printf("[mx-recheck] checking %d active domains", len(activeDomains))
				for _, d := range activeDomains {
					matched, _, mxStatus := store.CheckDomainMX(d.Domain, serverIP)
					db.TouchDomainCheckTime(context.Background(), d.ID)
					if !matched {
						if err := db.DisableDomainMX(context.Background(), d.ID); err != nil {
							log.Printf("[mx-recheck] disable %s error: %v", d.Domain, err)
						} else {
							log.Printf("[mx-recheck] ⚠ %s MX no longer valid (%s), domain disabled", d.Domain, mxStatus)
						}
					}
				}
			}
		}
	}()

	// ==================== 写出管理员 API Key 文件 ====================
	go func() {
		// 等待 DB 就绪后再读取（延迟 1 秒）
		time.Sleep(1 * time.Second)
		adminKey, err := db.GetAdminAPIKey(context.Background())
		if err != nil {
			log.Printf("[adminkey] could not fetch admin key: %v", err)
			return
		}
		keyFile := os.Getenv("ADMIN_KEY_FILE")
		if keyFile == "" {
			keyFile = "/data/admin.key"
		}
		if err := os.MkdirAll(filepath.Dir(keyFile), 0700); err == nil {
			content := "# TempMail Admin API Key\n# Auto-generated on startup — keep this secret!\n\nADMIN_API_KEY=" + adminKey + "\n"
			if err := os.WriteFile(keyFile, []byte(content), 0600); err != nil {
				log.Printf("[adminkey] write file error: %v", err)
			} else {
				log.Printf("✓ Admin API Key written to %s", keyFile)
			}
		}
		log.Printf("✴ ADMIN API KEY: %s", adminKey)
	}()

	// ==================== 启动服务 ====================
	srv := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      r,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		log.Printf("✓ API server listening on :%s", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	// 优雅关闭
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("Shutting down server...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Fatalf("Server forced to shutdown: %v", err)
	}
	log.Println("Server exited")
}

func normalizeEmailAddress(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func splitEmailAddress(value string) (localPart string, domain string, ok bool) {
	localPart, domain, ok = strings.Cut(normalizeEmailAddress(value), "@")
	if !ok || localPart == "" || domain == "" {
		return "", "", false
	}
	if strings.Contains(localPart, "@") || strings.Contains(domain, "@") {
		return "", "", false
	}
	return localPart, domain, true
}
