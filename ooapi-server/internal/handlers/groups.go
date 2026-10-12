package handlers

import (
	"errors"
	"log"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"ooapi/internal/services"
)

// AdminListGroups 分组列表，需要 user:view 及以上。
//
// 密钥创建时也要读分组列表，但普通用户不该看到分组管理界面 ——
// 因此列表接口按「登录即可读」，增删改按能力点收口。
func AdminListGroups(c *gin.Context) {
	groups, err := services.ListGroups()
	if err != nil {
		log.Printf("[groups] 查询失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询分组失败", "server_error")
		return
	}
	ok(c, gin.H{"items": groups})
}

type groupRequest struct {
	Name   string   `json:"name"`
	Remark string   `json:"remark"`
	Rate   float64  `json:"rate"`
	Models []string `json:"models"`
}

// AdminCreateGroup 建分组，需要 user:edit。
func AdminCreateGroup(c *gin.Context) {
	var req groupRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}

	// 倍率缺省为 1（原价），而不是 0 —— 0 会被判为非法值。
	if req.Rate == 0 {
		req.Rate = 1
	}

	g, err := services.CreateGroup(req.Name, req.Remark, req.Rate, req.Models)
	if err != nil {
		writeGroupError(c, err)
		return
	}

	if operator, okOp := currentUser(c); okOp {
		log.Printf("[admin] %s 创建分组「%s」倍率 %v", operator.Username, g.Name, g.Rate)
	}
	ok(c, g)
}

// AdminUpdateGroup 改分组，需要 user:edit。
func AdminUpdateGroup(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		fail(c, http.StatusBadRequest, "分组 ID 不正确", "bad_request")
		return
	}

	var req groupRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}
	if req.Rate == 0 {
		req.Rate = 1
	}

	g, err := services.UpdateGroup(id, req.Name, req.Remark, req.Rate, req.Models)
	if err != nil {
		writeGroupError(c, err)
		return
	}

	if operator, okOp := currentUser(c); okOp {
		log.Printf("[admin] %s 更新分组「%s」倍率 %v 模型数 %d", operator.Username, g.Name, g.Rate, len(g.Models))
	}
	auditLog(c, "更新分组", g.Name)
	ok(c, g)
}

// AdminDeleteGroup 删分组，需要 user:edit。
func AdminDeleteGroup(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		fail(c, http.StatusBadRequest, "分组 ID 不正确", "bad_request")
		return
	}

	if err := services.DeleteGroup(id); err != nil {
		writeGroupError(c, err)
		return
	}

	if operator, okOp := currentUser(c); okOp {
		log.Printf("[admin] %s 删除分组 %d", operator.Username, id)
	}
	ok(c, gin.H{"id": id})
}

// writeGroupError 把服务层的错误映射成合适的 HTTP 状态码。
func writeGroupError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, services.ErrGroupNotFound):
		fail(c, http.StatusNotFound, err.Error(), "not_found")
	case errors.Is(err, services.ErrGroupNameTaken):
		fail(c, http.StatusConflict, err.Error(), "name_taken")
	case errors.Is(err, services.ErrGroupInUse):
		fail(c, http.StatusConflict, err.Error(), "in_use")
	case errors.Is(err, services.ErrBadRate), errors.Is(err, services.ErrBadGroupName):
		fail(c, http.StatusBadRequest, err.Error(), "invalid_input")
	default:
		log.Printf("[groups] 操作失败: %v", err)
		fail(c, http.StatusInternalServerError, "操作失败，请稍后重试", "server_error")
	}
}

// PublicGroups 供普通用户创建密钥时选择分组。
//
// 只返回名字、备注、倍率与模型白名单 —— 这些是用户判断「该选哪个分组」
// 所必需的信息，不含任何管理字段。
func PublicGroups(c *gin.Context) {
	groups, err := services.ListGroups()
	if err != nil {
		log.Printf("[groups] 查询失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询分组失败", "server_error")
		return
	}

	type item struct {
		ID     int64    `json:"id"`
		Name   string   `json:"name"`
		Remark string   `json:"remark"`
		Rate   float64  `json:"rate"`
		Models []string `json:"models"`
	}
	out := make([]item, 0, len(groups))
	for _, g := range groups {
		out = append(out, item{ID: g.ID, Name: g.Name, Remark: g.Remark, Rate: g.Rate, Models: g.Models})
	}
	ok(c, gin.H{"items": out})
}
