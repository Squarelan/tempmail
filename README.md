# TempMail

一个自托管临时邮件服务平台，支持多域名、用户自助提交域名、MX 自动验证与自动禁用、API Key 鉴权及 Web 管理后台。

---

## 功能特性

| 功能 | 说明 |
|------|------|
| 邮箱管理 | 按需创建临时邮箱，可配置 TTL（默认 30 分钟），自动清理 |
| 永久邮箱额度 | 普通用户默认 5 个永久邮箱，管理员无限制，可在后台调整用户额度 |
| 多域名池 | 多个域名轮流供用户创建邮箱，支持精确域名与 `*.example.com` 通配子域规则 |
| Catch-all 收件 | 未预创建地址也可收件，支持弱所有权认领或管理员专属收件模式 |
| 保留地址 | `admin` / `noreply` / `postmaster` 等特殊前缀默认仅管理员可注册，支持后台自定义 |
| MX 自动验证 | 提交域名后后台每 30 秒轮询 MX 记录，通过即自动激活，无需管理员确认 |
| 域名健康监控 | 每 6 小时重检已激活域名，MX 失效自动暂停（`status=disabled`）|
| IP / Hostname 分离 | 服务器 IP 与邮件主机名通过环境变量或后台设置注入，不写入代码 |
| API Key 鉴权 | 每用户独立 API Key（推荐使用 `Authorization: Bearer <token>`），速率限制 500 次/分钟 |
| 管理后台 | Web GUI 管理账户、域名、Catch-all 收件箱、系统配置（含 SMTP Hostname）|
| 账户角色切换 | 管理员可在后台将账户设为管理员或解除管理员 |
| Dashboard 统计 | 实时展示邮箱数、邮件数、域名数、账户数 |
| 公告系统 | 管理员可设置公告，用户登录后显示 |
| 速率限制 | Redis 滑动窗口，默认 500 请求/60 秒/令牌 |
| 连接池 | PgBouncer 事务模式，支持 2000 并发客户端 |

---

## 快速启动

### 前置条件

- Docker 20.10+
- Docker Compose v2+
- 公网 IP / 域名（用于接收邮件）

### 1. 克隆并配置

```bash
git clone <repo-url>
cd tempmail
cp .env.example .env
# 编辑 .env，填写 SMTP_SERVER_IP 和 SMTP_HOSTNAME
```

### 2. 启动服务

```bash
docker compose up -d
```

六个容器会自动启动：`postgres`、`pgbouncer`、`redis`、`api`、`frontend`（Nginx）、`postfix`。

### 3. 获取管理员 API Key

首次启动后，管理员 Key 会写入 `data/admin.key`：

```bash
cat data/admin.key
# tm_admin_<自动生成的随机密钥>
```

也可查看容器日志：

```bash
docker compose logs api | grep "ADMIN API KEY"
```

### 4. 访问 Web 界面

浏览器打开 `http://<服务器IP>`，在登录页输入管理员 API Key 登录。

---

## 环境变量

在项目根目录 `.env` 文件中配置（**所有含服务器 IP / 域名的信息均在此处填写，不写入代码**）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SMTP_SERVER_IP` | *(必填)* | 服务器公网 IP，用于 MX 验证与 SPF 生成 |
| `SMTP_HOSTNAME` | *(推荐填写)* | 邮件服务器主机名，如 `mail.yourdomain.com`。设置后用户添加域名只需一条 MX 记录，无需 A 记录 |
| `API_DB_DSN` | `postgres://tempmail:<POSTGRES_PASSWORD>@pgbouncer:6432/tempmail?sslmode=disable` | Go API 连接 PgBouncer 的数据库连接串 |
| `API_REDIS_ADDR` | `redis:6379` | Go API 使用的 Redis 容器内地址 |
| `API_REDIS_PASSWORD` | *(必填)* | Redis 密码，应与 `REDIS_PASSWORD` 保持一致 |
| `API_PORT` | `8080` | API 监听端口 |
| `API_RATE_LIMIT` | `500` | 每令牌每窗口期最大请求数 |
| `API_RATE_WINDOW` | `60` | 速率窗口（秒）|

`.env` 示例：

```dotenv
SMTP_SERVER_IP=1.2.3.4
SMTP_HOSTNAME=mail.yourdomain.com
```

> `SMTP_SERVER_IP` / `SMTP_HOSTNAME` 也可在管理后台「系统设置」中修改，DB 值优先于环境变量。

> 说明：当前 API 相关环境变量以 `.env.example` 和 `docker-compose.yml` 中的 `API_DB_DSN` / `API_REDIS_ADDR` / `API_REDIS_PASSWORD` 为准。

---

## 添加邮件域名

任意已登录用户均可提交域名，管理员可在后台直接添加。

### 方式一：用户自助提交（推荐）

1. 登录后进入「域名列表」→「⚡ 提交域名」
2. 填写域名，系统会展示所需 DNS 记录
3. 在 DNS 面板完成配置后提交：
   - **MX 已生效** → 立即激活加入域名池
   - **MX 未生效** → 进入待验证队列，后台每 30 秒自动重试，通过后自动激活

### 方式二：管理员直接添加

登录管理后台 → 域名管理 → 手动添加（跳过 MX 检测，立即激活）。

### 所需 DNS 记录

系统接收的可以是：

- 根域：`example.com`
- 普通子域：`mail.example.com`
- 通配规则：`*.example.com`
- 更深层的通配规则：`*.mail.example.com`

> DNS 面板里“主机记录 / Name / Host”具体填什么，取决于你当前编辑的是哪个 DNS Zone。下面的主机写法假设你正在 `example.com` 这个 DNS 区里操作。

### 主机记录速查表

| 添加到系统中的域名 | 实际接收效果 | 在 `example.com` 区里常见主机写法 |
|---|---|---|
| `example.com` | 只接收 `@example.com` | `@` |
| `mail.example.com` | 只接收 `@mail.example.com` | `mail` |
| `*.example.com` | 接收任意 `@<任意子域>.example.com`，**不含** `@example.com` | `*` |
| `*.mail.example.com` | 接收任意 `@<任意子域>.mail.example.com`，**不含** `@mail.example.com` | `*.mail` |

> 如果 `mail.example.com` 已经被你单独委派成一个独立 DNS 区，那么在那个区里通常应填写 `@` 或 `*`，而不是 `mail` / `*.mail`。

### 已配置 `SMTP_HOSTNAME`（推荐）

推荐在 `.env` 或后台设置中显式配置：

```dotenv
SMTP_HOSTNAME=mail.yourdomain.com
```

这样所有用户域名都只需要把 MX 指向这个固定主机名，通常更清晰。

```text
# 1) 根域 example.com
MX   @        mail.yourdomain.com   优先级 10
TXT  @        v=spf1 ip4:<服务器公网 IP> ~all

# 2) 精确子域 mail.example.com（在 example.com 区里）
MX   mail     mail.yourdomain.com   优先级 10
TXT  mail     v=spf1 ip4:<服务器公网 IP> ~all

# 3) 通配规则 *.example.com
MX   *        mail.yourdomain.com   优先级 10
TXT  *        v=spf1 ip4:<服务器公网 IP> ~all

# 4) 更深层通配规则 *.mail.example.com（在 example.com 区里）
MX   *.mail   mail.yourdomain.com   优先级 10
TXT  *.mail   v=spf1 ip4:<服务器公网 IP> ~all
```

> `mail.yourdomain.com` 为 `SMTP_HOSTNAME` 的值；其 A/AAAA 记录由该主机名自己提供，用户域名无需额外再配 `A mail ...`。

### 未配置 `SMTP_HOSTNAME`

若未配置 `SMTP_HOSTNAME`，系统会自动把 MX 指向：

```text
mail.<你添加的精确域名或通配规则的基域>
```

因此子域越深，自动生成的 MX 主机名也会越深。示例如下：

```text
# 1) 根域 example.com
MX   @          mail.example.com         优先级 10
A    mail       <服务器公网 IP>
TXT  @          v=spf1 ip4:<服务器公网 IP> ~all

# 2) 精确子域 mail.example.com（在 example.com 区里）
MX   mail       mail.mail.example.com    优先级 10
A    mail.mail  <服务器公网 IP>
TXT  mail       v=spf1 ip4:<服务器公网 IP> ~all

# 3) 通配规则 *.example.com
MX   *          mail.example.com         优先级 10
A    mail       <服务器公网 IP>
TXT  *          v=spf1 ip4:<服务器公网 IP> ~all

# 4) 更深层通配规则 *.mail.example.com（在 example.com 区里）
MX   *.mail     mail.mail.example.com    优先级 10
A    mail.mail  <服务器公网 IP>
TXT  *.mail     v=spf1 ip4:<服务器公网 IP> ~all
```

> 因为这种模式下子域场景容易出现 `mail.mail.example.com` 这类嵌套名称，**强烈建议生产环境配置 `SMTP_HOSTNAME`**。

### 通配子域（方案 2）

如果你想让 `example.com` 自动拆分并接收任意子域邮件，可以直接添加：

```text
*.example.com
```

此时：

- `hello@a.example.com` ✅
- `hello@b.c.example.com` ✅
- `hello@example.com` ❌（根域不会被 `*.` 规则覆盖）

如果你想同时接收：

- `@example.com`
- `@任意子域.example.com`

请同时添加两条规则：

```text
example.com
*.example.com
```

---

## API 使用

所有受保护的 API 请求建议在 Header 携带：

```
Authorization: Bearer tm_xxxxxxxxxxxx
```

> 也兼容 `?api_key=<token>` 查询参数方式。

### `domain` 参数说明

- `domain` **不要求必须是根域 / Apex Domain**
- 只要是你能控制 DNS 的**合法域名或子域名**即可，例如：
  - `example.com`
  - `mail.example.com`
  - `relay.mail.example.net`
  - `*.example.com`
  - `*.mail.example.net`
- 精确域名只匹配自己：
  - `mail.example.com` → 只匹配 `user@mail.example.com`
- 通配规则只匹配更深层子域，不覆盖自身：
  - `*.mail.example.net` → 匹配 `user@a.mail.example.net`
  - `*.mail.example.net` → 也匹配 `user@b.c.mail.example.net`
  - `*.mail.example.net` → **不匹配** `user@mail.example.net`
- 如果你想同时接收：
  - `@mail.example.net`
  - `@任意子域.mail.example.net`
  
  请同时添加两条规则：

```text
mail.example.net
*.mail.example.net
```

> 是否能成功接收，取决于你是否真的能为该名字配置 DNS / MX 记录；不同 DNS 面板里主机记录填写方式可能不同。

### 常用接口

```bash
BASE="http://<服务器IP>"
KEY="your_api_key"

# 获取公开设置（无需登录）
curl "$BASE/public/settings"

# 创建邮箱
curl -X POST "$BASE/api/mailboxes" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"address":"test","domain":"example.com"}'

# 创建永久邮箱（普通用户受额度限制）
curl -X POST "$BASE/api/mailboxes" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"address":"vipbox","domain":"example.com","permanent":true}'

# 在通配规则 *.example.com 下创建一个真实子域邮箱
curl -X POST "$BASE/api/mailboxes" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"address":"hello","domain":"demo.example.com"}'

# 使用一个“非根域”的精确子域名作为收件域
curl -X POST "$BASE/api/mailboxes" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"address":"ops","domain":"mail.example.net"}'

# 在通配规则 *.example.com 下自动分配一个完全随机的真实子域
curl -X POST "$BASE/api/mailboxes" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"address":"hello","domain":"*.example.com","auto_subdomain":true,"subdomain_mode":"random"}'

# 在通配规则 *.example.com 下按词库随机分配真实子域
curl -X POST "$BASE/api/mailboxes" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"address":"hello","domain":"*.example.com","auto_subdomain":true,"subdomain_mode":"wordlist"}'

# 在 *.mail.example.net 下面自动分配随机子域
curl -X POST "$BASE/api/mailboxes" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"address":"hello","domain":"*.mail.example.net","auto_subdomain":true}'

# 说明：
# - 前端创建邮箱弹窗支持三种通配子域模式：完全随机、词库随机、自定义
# - API 自动分配子域支持两种模式：random / wordlist
# - wordlist 模式默认使用扩展后的常见子域标签词库（如 support-center / api-gateway）
# - 管理员可在后台“系统设置”里直接编辑 wordlist 词库

# 获取可用域名（需登录）
curl "$BASE/api/domains" -H "Authorization: Bearer $KEY"

# 列出邮箱
curl "$BASE/api/mailboxes" -H "Authorization: Bearer $KEY"

# 读取邮件
curl "$BASE/api/mailboxes/<mailbox-id>/emails" -H "Authorization: Bearer $KEY"

# 提交域名（任意登录用户）
curl -X POST "$BASE/api/domains/submit" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain":"example.com"}'

# 提交通配子域规则
curl -X POST "$BASE/api/domains/submit" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain":"*.example.com"}'

# 提交一个普通子域名
curl -X POST "$BASE/api/domains/submit" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain":"mail.example.net"}'

# 提交一个子域上的通配规则
curl -X POST "$BASE/api/domains/submit" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain":"*.mail.example.net"}'

# 查询域名验证状态
curl "$BASE/api/domains/<domain-id>/status" -H "Authorization: Bearer $KEY"

# 获取统计（无需登录）
curl "$BASE/public/stats"
```

### Catch-all 行为

系统设置中的 `unknown_recipient_policy` 控制未知地址邮件的去向：

- `claimable`
  - 未创建地址的邮件会自动进入系统 `_catchall` 账号下的 catch-all 邮箱
  - 用户后续创建同名地址时，可直接认领该地址及历史邮件
- `admin_only`
  - 未创建地址的邮件会进入管理员 catch-all 收件箱
  - 普通用户不可认领
  - 可额外指定 `catchall_admin_account_id`，将未知地址统一交给某个管理员；留空时自动选择最早创建的活跃管理员

### 永久邮箱额度与保留地址

- 普通用户默认可创建 **5 个永久邮箱**
- 管理员创建永久邮箱 **无限制**
- 管理员可通过后台或 API 调整普通用户的 `permanent_mailbox_quota`
- `reserved_mailbox_addresses` 中配置的本地部分仅管理员可创建
- 默认保留列表包含：`admin`、`administrator`、`root`、`system`、`support`、`noreply`、`no-reply`、`no_reply`、`notification`、`notifications`、`notify`、`alerts`、`mailer-daemon`、`postmaster`、`hostmaster`、`webmaster`、`security`、`abuse`、`daemon`

### 管理员专用接口

```bash
# 将用户设为管理员
curl -X PUT "$BASE/api/admin/accounts/<account-id>/admin" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"is_admin": true}'

# 调整普通用户永久邮箱额度
curl -X PUT "$BASE/api/admin/accounts/<account-id>/quota" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"permanent_mailbox_quota": 12}'

# 列出所有 catch-all 邮箱
curl "$BASE/api/admin/catchall/mailboxes" \
  -H "Authorization: Bearer $KEY"

# 查看某个 catch-all 邮箱的邮件
curl "$BASE/api/admin/catchall/mailboxes/<mailbox-id>/emails" \
  -H "Authorization: Bearer $KEY"

# 删除整个 catch-all 邮箱
curl -X DELETE "$BASE/api/admin/catchall/mailboxes/<mailbox-id>" \
  -H "Authorization: Bearer $KEY"

# 切换 catch-all 策略 / 指定接收管理员
curl -X PUT "$BASE/api/admin/settings" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"unknown_recipient_policy":"admin_only","catchall_admin_account_id":"<admin-uuid>"}'

# 设置普通用户不可注册的保留地址（仅管理员可创建）
curl -X PUT "$BASE/api/admin/settings" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"reserved_mailbox_addresses":"admin\nnoreply\npostmaster\nsecurity"}'
```

### 速率限制响应头

每个响应会返回：

```
X-RateLimit-Limit: 500
X-RateLimit-Remaining: 499
X-RateLimit-Reset: 1735000000
```

---

## 数据库迁移

| 文件 | 用途 |
|------|------|
| `sql/init.sql` | 全量初始化（新库使用）|
| `sql/migrate_v2.sql` | v1 → v2：添加邮箱 `expires_at` 字段 |
| `sql/migrate_v3.sql` | v2 → v3：域名 `status`、`mx_checked_at`，新增系统配置项（含 `smtp_hostname`）|
| `sql/migrate_v4.sql` | v3 → v4：新增 catch-all 支持、系统账号、角色切换与 catch-all 策略设置 |
| `sql/migrate_v5.sql` | v4 → v5：新增永久邮箱额度、永久邮箱标记、管理员保留地址设置 |

对已运行的库执行迁移：

```bash
docker exec -i $(docker compose ps -q postgres) \
  psql -U tempmail -d tempmail < sql/migrate_v5.sql
```

> 当前的通配域名能力直接复用原有 `domains.domain` 字段存储 `*.example.com`，因此已升级到 v5 的数据库无需额外 SQL 迁移。

---

## 项目结构

```
tempmail/
├── api/                  # Go API 服务
│   ├── main.go           # 路由、中间件、后台 goroutine
│   ├── config/           # 环境变量配置
│   ├── handler/          # HTTP 处理器
│   ├── middleware/        # 鉴权、速率限制
│   ├── model/            # 数据结构
│   └── store/            # 数据库操作
├── frontend/             # 静态 SPA（Nginx 托管）
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
├── nginx/                # Nginx 反向代理配置
├── postfix/              # Postfix 邮件接收
├── pgbouncer/            # PgBouncer 连接池配置
├── sql/                  # 数据库 DDL 与迁移脚本
├── data/                 # 运行时数据（admin.key 在此，已 gitignore）
├── docker-compose.yml
└── .env                  # 敏感配置（已 gitignore，不含硬编码 IP）
```

---

## 后台 Goroutine

| Goroutine | 间隔 | 功能 |
|-----------|------|------|
| 邮箱清理器 | 1 分钟 | 删除 `expires_at` 已过期的邮箱及其邮件 |
| MX 域名验证器（待验证） | 30 秒 | 轮询 `status='pending'` 的域名，MX 检测通过则自动激活 |
| MX 域名健康巡检（已激活） | 6 小时 | 重检所有 `status='active'` 的域名，MX 失效则自动禁用 |
| Admin Key 写入 | 启动 1 秒后执行一次 | 将管理员 API Key 写入 `ADMIN_KEY_FILE` |

---

## 许可证

MIT

---

## 友链

- [LINUX DO](https://linux.do/)
