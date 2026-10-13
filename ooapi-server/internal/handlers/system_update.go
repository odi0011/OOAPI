package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"ooapi/internal/services"
)

// AdminGetSystemUpdate 读取 GitHub 仓库对比。需要 option:view。
func AdminGetSystemUpdate(c *gin.Context) {
	refresh := c.Query("refresh") == "1"
	ok(c, services.CheckSystemUpdate(c.Request.Context(), refresh))
}

type systemUpdateBody struct {
	Action     string `json:"action"`
	AutoUpdate *bool  `json:"autoUpdate"`
}

// AdminPostSystemUpdate 检查、快进到最新，或切换自动更新。需要 option:edit。
func AdminPostSystemUpdate(c *gin.Context) {
	var body systemUpdateBody
	if err := c.ShouldBindJSON(&body); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}
	switch body.Action {
	case "check":
		ok(c, services.CheckSystemUpdate(c.Request.Context(), true))
	case "set-auto":
		if body.AutoUpdate == nil {
			fail(c, http.StatusBadRequest, "缺少自动更新开关", "bad_request")
			return
		}
		if err := services.SetSystemAutoUpdate(*body.AutoUpdate); err != nil {
			fail(c, http.StatusInternalServerError, "保存自动更新失败", "update_save_failed")
			return
		}
		ok(c, services.CheckSystemUpdate(c.Request.Context(), false))
	case "apply":
		status, err := services.ApplySystemUpdate(c.Request.Context())
		if err != nil {
			fail(c, http.StatusConflict, err.Error(), "update_failed")
			return
		}
		ok(c, status)
	default:
		fail(c, http.StatusBadRequest, "不认识的更新动作", "bad_request")
	}
}
