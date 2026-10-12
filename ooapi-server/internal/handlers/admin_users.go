package handlers

import (
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"ooapi/internal/authz"
	"ooapi/internal/db"
	"ooapi/internal/middleware"
)

// AdminListUsers 用户列表，需要 user:view 能力点。
//
// 数据归属：管理员只看到自己层级以下的用户，超管看全部。
// 这条规则和 CanModifyUser 一致，避免「看得到但改不了」或反之。
func AdminListUsers(c *gin.Context) {
	actor, _ := currentRole(c)

	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(c.DefaultQuery("page_size", "20"))
	if size < 1 || size > 100 {
		size = 20
	}
	offset := (page - 1) * size

	// 超管看全部；其余只能看到角色数值低于自己的用户。
	//
	// 调用次数用相关子查询而不是 JOIN + GROUP BY：用户量小时两者等价，
	// 但子查询能复用 idx_user_created，也不必把 users 的每一列都写进 GROUP BY。
	type row struct {
		ID           int64  `json:"id"`
		Username     string `json:"username"`
		DisplayName  string `json:"display_name"`
		Email        string `json:"email"`
		Role         int    `json:"role"`
		RoleName     string `json:"role_name"`
		Status       int    `json:"status"`
		Quota        int64  `json:"quota"`
		UsedQuota    int64  `json:"used_quota"`
		RequestCount int64  `json:"request_count"`
		GroupName    string `json:"group_name"`
		CreatedAt    string `json:"created_at"`
		LastLoginAt  string `json:"last_login_at"`
		AvatarURL    string `json:"avatar_url"`
	}

	const selectCols = `SELECT id, username, display_name, email, role, status, quota, used_quota,
	        (SELECT COUNT(*) FROM logs WHERE logs.user_id = users.id AND logs.type IN (2, 3)) AS request_count,
	        group_name, created_at, last_login_at, avatar_url
	 FROM users`

	var (
		rows *sqlRows
		err  error
		where string
		args  []any
	)
	if actor == authz.RoleRoot {
		rows, err = queryRows(selectCols+` ORDER BY id DESC LIMIT ? OFFSET ?`, size, offset)
	} else {
		where = " WHERE role < ?"
		rows, err = queryRows(selectCols+where+` ORDER BY id DESC LIMIT ? OFFSET ?`, int(actor), size, offset)
	}
	if err != nil {
		log.Printf("[admin/users] 查询失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询用户失败", "server_error")
		return
	}
	defer rows.Close()

	out := []row{}
	for rows.Next() {
		var (
			r         row
			lastLogin *string
		)
		if err := rows.Scan(&r.ID, &r.Username, &r.DisplayName, &r.Email, &r.Role, &r.Status,
			&r.Quota, &r.UsedQuota, &r.RequestCount, &r.GroupName, &r.CreatedAt, &lastLogin, &r.AvatarURL); err != nil {
			continue
		}
		r.RoleName = authz.ParseRole(r.Role).Name()
		if lastLogin != nil {
			r.LastLoginAt = *lastLogin
		}
		out = append(out, r)
	}

	// 本页统计与总数：卡片要显示「一共多少人」，而不是「本页多少人」。
	var totalCount int64
	countArgs := append([]any{}, args...)
	_ = db.DB.QueryRow("SELECT COUNT(*) FROM users"+where, countArgs...).Scan(&totalCount)

	// 同时回传当前操作者能授予的最高角色，前端据此限制下拉选项。
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"items":            out,
			"page":             page,
			"size":             size,
			"total":            totalCount,
			"assignable_roles": assignableRoles(actor),
		},
	})
}

type updateProfileRequest struct {
	DisplayName string `json:"display_name"`
	Email       string `json:"email"`
}

// AdminUpdateUserProfile 编辑用户资料（显示名称与邮箱），需要 user:edit。
//
// 只允许改这两个字段：角色的变更有单独的接口（要 role:assign），
// 额度走增量接口 —— 一个接口揽所有改动会让权限边界变得含糊。
func AdminUpdateUserProfile(c *gin.Context) {
	actor, _ := currentRole(c)
	operator, _ := currentUser(c)

	targetID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		fail(c, http.StatusBadRequest, "用户 ID 不正确", "bad_request")
		return
	}

	var req updateProfileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}

	displayName := strings.TrimSpace(req.DisplayName)
	email := strings.TrimSpace(req.Email)
	if len(displayName) > 64 {
		fail(c, http.StatusBadRequest, "显示名称最长 64 个字符", "bad_request")
		return
	}
	if email != "" {
		if len(email) > 128 || !strings.Contains(email, "@") || strings.HasPrefix(email, "@") || strings.HasSuffix(email, "@") {
			fail(c, http.StatusBadRequest, "邮箱格式不正确", "bad_request")
			return
		}
	}

	var targetRoleInt int
	if err := db.DB.QueryRow("SELECT role FROM users WHERE id = ?", targetID).Scan(&targetRoleInt); err != nil {
		fail(c, http.StatusNotFound, "用户不存在", "not_found")
		return
	}
	if !authz.CanModifyUser(actor, authz.ParseRole(targetRoleInt)) {
		fail(c, http.StatusForbidden, "无权修改该用户的资料", "forbidden")
		return
	}

	if _, err := db.DB.Exec(
		"UPDATE users SET display_name = ?, email = ? WHERE id = ?",
		displayName, email, targetID,
	); err != nil {
		log.Printf("[admin/users] 更新资料失败: %v", err)
		fail(c, http.StatusInternalServerError, "更新用户资料失败", "server_error")
		return
	}

	if operator != nil {
		log.Printf("[admin] %s 编辑用户 %d 资料", operator.Username, targetID)
	}
	auditLog(c, "编辑用户资料", "用户 ID "+strconv.FormatInt(targetID, 10))
	ok(c, gin.H{"id": targetID, "display_name": displayName, "email": email})
}

// AdminDeleteUser 删除用户，需要 user:edit（与状态改动同一能力点）。
//
// 与状态禁用不同：删除是不可逆的。级联删除该用户的密钥与三方绑定，
// 但**保留其日志** —— 用量审计是平台账目的一部分，
// 删用户就把历史消费一起抹掉，对账会永久失真（日志里的 user_id
// 保留为原值，列表联查时显示为「已注销用户」）。
func AdminDeleteUser(c *gin.Context) {
	actor, _ := currentRole(c)
	operator, _ := currentUser(c)

	targetID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		fail(c, http.StatusBadRequest, "用户 ID 不正确", "bad_request")
		return
	}

	var (
		targetRoleInt int
		username      string
	)
	if err := db.DB.QueryRow("SELECT role, username FROM users WHERE id = ?", targetID).
		Scan(&targetRoleInt, &username); err != nil {
		fail(c, http.StatusNotFound, "用户不存在", "not_found")
		return
	}

	if !authz.CanModifyUser(actor, authz.ParseRole(targetRoleInt)) {
		fail(c, http.StatusForbidden, "无权删除该用户", "forbidden")
		return
	}
	if operator != nil && operator.ID == targetID {
		fail(c, http.StatusBadRequest, "不能删除自己的账号", "self_modify")
		return
	}

	// 不能删掉最后一个启用中的管理员：留下一个没人能管理的站点
	// 比拒绝一次删除糟糕得多。
	targetRole := authz.ParseRole(targetRoleInt)
	if targetRole >= authz.RoleAdmin {
		var remaining int
		_ = db.DB.QueryRow(
			"SELECT COUNT(*) FROM users WHERE id <> ? AND role >= ? AND status = 1",
			targetID, int(authz.RoleAdmin),
		).Scan(&remaining)
		if remaining == 0 {
			fail(c, http.StatusBadRequest, "必须至少保留一个启用的管理员", "last_admin")
			return
		}
	}

	tx, err := db.DB.Begin()
	if err != nil {
		fail(c, http.StatusInternalServerError, "删除用户失败", "server_error")
		return
	}
	defer func() { _ = tx.Rollback() }()

	for _, stmt := range []string{
		"DELETE FROM tokens WHERE user_id = ?",
		"DELETE FROM user_oauth WHERE user_id = ?",
		"DELETE FROM users WHERE id = ?",
	} {
		if _, err := tx.Exec(stmt, targetID); err != nil {
			log.Printf("[admin/users] 删除用户失败: %v", err)
			fail(c, http.StatusInternalServerError, "删除用户失败", "server_error")
			return
		}
	}
	if err := tx.Commit(); err != nil {
		fail(c, http.StatusInternalServerError, "删除用户失败", "server_error")
		return
	}

	if operator != nil {
		log.Printf("[admin] %s 删除用户 %d（%s）", operator.Username, targetID, username)
	}
	auditLog(c, "删除用户", "用户 ID "+strconv.FormatInt(targetID, 10)+"（"+username+"）")
	ok(c, gin.H{"id": targetID})
}

// assignableRoles 返回操作者可分配的角色列表 —— 只能低于自己，
// 超管可分配除自己以外的全部角色。
func assignableRoles(actor authz.Role) []gin.H {
	out := []gin.H{}
	for _, r := range []authz.Role{authz.RoleUser, authz.RoleAdmin, authz.RoleRoot} {
		if authz.CanAssignRole(actor, r) {
			out = append(out, gin.H{"value": int(r), "label": r.Name()})
		}
	}
	return out
}

type updateRoleRequest struct {
	Role int `json:"role"`
}

// AdminUpdateUserRole 调整用户角色，需要 role:assign。
//
// 三重防护：
//  1. 中间件按能力点拦截
//  2. CanAssignRole 校验目标角色不高于自己
//  3. CanModifyUser 校验目标用户不高于自己
//
// 第 3 条是关键：否则管理员可以给一个超管降级来绕过第 2 条。
func AdminUpdateUserRole(c *gin.Context) {
	actor, _ := currentRole(c)
	operator, _ := currentUser(c)

	targetID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		fail(c, http.StatusBadRequest, "用户 ID 不正确", "bad_request")
		return
	}

	var req updateRoleRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}

	newRole := authz.ParseRole(req.Role)
	if !authz.CanAssignRole(actor, newRole) {
		fail(c, http.StatusForbidden, "无权授予该角色", "forbidden")
		return
	}

	// 读目标用户当前角色，用于判断是否越级操作。
	var currentRoleInt int
	if err := db.DB.QueryRow("SELECT role FROM users WHERE id = ?", targetID).Scan(&currentRoleInt); err != nil {
		fail(c, http.StatusNotFound, "用户不存在", "not_found")
		return
	}
	targetRole := authz.ParseRole(currentRoleInt)

	if !authz.CanModifyUser(actor, targetRole) {
		fail(c, http.StatusForbidden, "无权修改该用户的角色", "forbidden")
		return
	}

	// 不允许改动自己，避免管理员误把自己降级导致无人可管理。
	if operator != nil && operator.ID == targetID {
		fail(c, http.StatusBadRequest, "不能修改自己的角色", "self_modify")
		return
	}

	if _, err := db.DB.Exec("UPDATE users SET role = ? WHERE id = ?", int(newRole), targetID); err != nil {
		log.Printf("[admin/users] 更新角色失败: %v", err)
		fail(c, http.StatusInternalServerError, "更新角色失败", "server_error")
		return
	}

	log.Printf("[admin] %s 将用户 %d 的角色改为 %s", operator.Username, targetID, newRole.Name())
	auditLog(c, "变更用户角色",
		"用户 ID "+strconv.FormatInt(targetID, 10)+" → "+newRole.Name())
	ok(c, gin.H{"id": targetID, "role": int(newRole), "role_name": newRole.Name()})
}

type updateStatusRequest struct {
	Status int `json:"status"`
}

// AdminUpdateUserStatus 启用或禁用账号，需要 user:edit。
func AdminUpdateUserStatus(c *gin.Context) {
	actor, _ := currentRole(c)
	operator, _ := currentUser(c)

	targetID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		fail(c, http.StatusBadRequest, "用户 ID 不正确", "bad_request")
		return
	}

	var req updateStatusRequest
	if err := c.ShouldBindJSON(&req); err != nil || (req.Status != 0 && req.Status != 1) {
		fail(c, http.StatusBadRequest, "状态只能是 0 或 1", "bad_request")
		return
	}

	var targetRoleInt int
	if err := db.DB.QueryRow("SELECT role FROM users WHERE id = ?", targetID).Scan(&targetRoleInt); err != nil {
		fail(c, http.StatusNotFound, "用户不存在", "not_found")
		return
	}
	targetRole := authz.ParseRole(targetRoleInt)

	if !authz.CanModifyUser(actor, targetRole) {
		fail(c, http.StatusForbidden, "无权修改该用户的状态", "forbidden")
		return
	}
	if operator != nil && operator.ID == targetID {
		fail(c, http.StatusBadRequest, "不能禁用自己的账号", "self_modify")
		return
	}

	if _, err := db.DB.Exec("UPDATE users SET status = ? WHERE id = ?", req.Status, targetID); err != nil {
		log.Printf("[admin/users] 更新状态失败: %v", err)
		fail(c, http.StatusInternalServerError, "更新状态失败", "server_error")
		return
	}

	log.Printf("[admin] %s 将用户 %d 状态改为 %d", operator.Username, targetID, req.Status)
	action := "启用用户"
	if req.Status == 0 {
		action = "禁用用户"
	}
	auditLog(c, action, "用户 ID "+strconv.FormatInt(targetID, 10))
	ok(c, gin.H{"id": targetID, "status": req.Status})
}

type updateQuotaRequest struct {
	Delta int64 `json:"delta"`
}

// AdminUpdateUserQuota 增减额度，需要 user:quota。
// 用增量而非绝对值，避免并发覆盖；扣减后为负则拒绝。
func AdminUpdateUserQuota(c *gin.Context) {
	actor, _ := currentRole(c)
	operator, _ := currentUser(c)

	targetID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		fail(c, http.StatusBadRequest, "用户 ID 不正确", "bad_request")
		return
	}

	var req updateQuotaRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.Delta == 0 {
		fail(c, http.StatusBadRequest, "请提供非零的额度变化值", "bad_request")
		return
	}

	var targetRoleInt int
	if err := db.DB.QueryRow("SELECT role FROM users WHERE id = ?", targetID).Scan(&targetRoleInt); err != nil {
		fail(c, http.StatusNotFound, "用户不存在", "not_found")
		return
	}
	if !authz.CanModifyUser(actor, authz.ParseRole(targetRoleInt)) {
		fail(c, http.StatusForbidden, "无权修改该用户的额度", "forbidden")
		return
	}

	// 条件更新：余额不足时影响 0 行，天然防止并发下被扣成负数。
	res, err := db.DB.Exec(
		"UPDATE users SET quota = quota + ? WHERE id = ? AND quota + ? >= 0",
		req.Delta, targetID, req.Delta,
	)
	if err != nil {
		log.Printf("[admin/users] 更新额度失败: %v", err)
		fail(c, http.StatusInternalServerError, "更新额度失败", "server_error")
		return
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		fail(c, http.StatusBadRequest, "扣减后额度不能为负", "insufficient_quota")
		return
	}

	var newQuota int64
	_ = db.DB.QueryRow("SELECT quota FROM users WHERE id = ?", targetID).Scan(&newQuota)

	log.Printf("[admin] %s 调整用户 %d 额度 %+d", operator.Username, targetID, req.Delta)
	// 带 quota 的审计：操作日志页靠这个字段显示「额度变动」列。
	auditLogQuota(c, "调整用户额度",
		"用户 ID "+strconv.FormatInt(targetID, 10)+" 变化 "+strconv.FormatInt(req.Delta, 10),
		req.Delta)
	ok(c, gin.H{"id": targetID, "quota": newQuota})
}

// RequireSelfOr 用于「本人或具备某能力点」才能访问的场景，
// 例如查看他人额度明细：本人放行，其他人需有 user:view。
func RequireSelfOr(perm authz.Permission) gin.HandlerFunc {
	return func(c *gin.Context) {
		user, logged := currentUser(c)
		if !logged {
			fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
			c.Abort()
			return
		}

		targetID, err := strconv.ParseInt(c.Param("id"), 10, 64)
		if err == nil && user.ID == targetID {
			c.Next()
			return
		}

		role, _ := middleware.CurrentRole(c)
		if authz.Can(role, perm) {
			c.Next()
			return
		}

		fail(c, http.StatusForbidden, "没有查看该用户的权限", "forbidden")
		c.Abort()
	}
}
