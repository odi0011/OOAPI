package services

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 系统设置里的「更新」。
// 仓库地址从环境变量或本机 git remote 识别，识别不到时落到默认 GitHub 仓库。
// 远程地址里的令牌不会返回给前端。手动更新只做快进；自动更新沿用同一条路径。

const (
	defaultGitHubRepo = "https://github.com/odi0011/OOAPI"
	autoUpdateOption  = "system_auto_update"
	githubAPI         = "https://api.github.com"
	updateCheckEvery  = 15 * time.Minute
	githubCacheFor    = 60 * time.Second
)

var (
	repoPartRe = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
	branchRe   = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)
	httpClient = &http.Client{Timeout: 8 * time.Second}
)

// UpdateStatus 是设置页「更新」分区要画的一份快照。
type UpdateStatus struct {
	RepoURL       string `json:"repoUrl"`
	Owner         string `json:"owner"`
	Name          string `json:"name"`
	Branch        string `json:"branch"`
	CurrentSHA    string `json:"currentSha"`
	LatestSHA     string `json:"latestSha"`
	LatestMessage string `json:"latestMessage"`
	// RemoteAhead 是 GitHub 上有、本机还没有的提交数。大于 0 就可以更新。
	RemoteAhead int    `json:"remoteAhead"`
	LocalAhead  int    `json:"localAhead"`
	State       string `json:"state"`
	AutoUpdate  bool   `json:"autoUpdate"`
	CanApply    bool   `json:"canApply"`
	Hint        string `json:"hint"`
	CheckedAt   string `json:"checkedAt"`
	LastResult  string `json:"lastResult"`
}

type ghCommit struct {
	SHA    string `json:"sha"`
	Commit struct {
		Message string `json:"message"`
	} `json:"commit"`
}

type ghCompare struct {
	Status   string     `json:"status"`
	AheadBy  int        `json:"ahead_by"`
	BehindBy int        `json:"behind_by"`
	Commits  []ghCommit `json:"commits"`
}

var updateGate struct {
	mu         sync.Mutex
	applying   bool
	lastResult string
	cacheKey   string
	cacheAt    time.Time
	cache      UpdateStatus
}

// ParseGitHubRepo 从 remote URL 取出 owner/name，并丢掉用户信息里的令牌。
// 只接受 github.com。带额外路径（/tree/main）时只取前两段。
func ParseGitHubRepo(raw string) (web, owner, name string, ok bool) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", "", "", false
	}
	text = strings.TrimSuffix(text, "/")
	// 先认 git@ / ssh，再剥 https 用户信息。否则 git@ 会被当成令牌丢掉。
	switch {
	case strings.HasPrefix(text, "git@github.com:"):
		text = "https://github.com/" + strings.TrimPrefix(text, "git@github.com:")
	case strings.HasPrefix(text, "ssh://git@github.com/"):
		text = "https://github.com/" + strings.TrimPrefix(text, "ssh://git@github.com/")
	case strings.HasPrefix(text, "git@github.com/"):
		text = "https://github.com/" + strings.TrimPrefix(text, "git@github.com/")
	}
	if i := strings.Index(text, "://"); i >= 0 {
		rest := text[i+3:]
		if at := strings.LastIndex(rest, "@"); at >= 0 {
			host := rest[at+1:]
			if strings.HasPrefix(host, "github.com/") || host == "github.com" {
				text = "https://" + host
			}
		}
	}
	if strings.HasPrefix(text, "http://github.com/") {
		text = "https://github.com/" + strings.TrimPrefix(text, "http://github.com/")
	}
	text = strings.TrimSuffix(text, ".git")
	const prefix = "https://github.com/"
	if !strings.HasPrefix(text, prefix) {
		return "", "", "", false
	}
	parts := strings.Split(strings.TrimPrefix(text, prefix), "/")
	if len(parts) < 2 || !repoPartRe.MatchString(parts[0]) || !repoPartRe.MatchString(parts[1]) {
		return "", "", "", false
	}
	owner, name = parts[0], parts[1]
	web = prefix + owner + "/" + name
	return web, owner, name, true
}

func classifyUpdate(current, latest string, remoteAhead, localAhead int, compared bool) string {
	if current != "" && latest != "" && strings.EqualFold(current, latest) {
		return "current"
	}
	if !compared {
		if current != "" && latest != "" {
			return "behind"
		}
		return "unknown"
	}
	if remoteAhead > 0 && localAhead > 0 {
		return "diverged"
	}
	if remoteAhead > 0 {
		return "behind"
	}
	if localAhead > 0 {
		return "ahead"
	}
	return "current"
}

func safeBranch(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || value == "HEAD" || strings.HasPrefix(value, "-") || !branchRe.MatchString(value) {
		return "main"
	}
	return value
}

func findRepoDir() string {
	if dir := strings.TrimSpace(os.Getenv("OOAPI_REPO_DIR")); dir != "" {
		return dir
	}
	var starts []string
	if wd, err := os.Getwd(); err == nil {
		starts = append(starts, wd)
	}
	if exe, err := os.Executable(); err == nil {
		starts = append(starts, filepath.Dir(exe))
	}
	for _, start := range starts {
		dir := start
		for range 6 {
			if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
				return dir
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return ""
}

func gitOutput(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func gitAvailable() bool {
	_, err := exec.LookPath("git")
	return err == nil
}

func resolveRepo(ctx context.Context, dir string) (web, owner, name, branch, sha string) {
	raw := strings.TrimSpace(os.Getenv("OOAPI_GITHUB_REPO"))
	if raw == "" && dir != "" && gitAvailable() {
		if remote, err := gitOutput(ctx, dir, "remote", "get-url", "origin"); err == nil {
			raw = remote
		}
	}
	if web, owner, name, ok := ParseGitHubRepo(raw); ok {
		branch = safeBranch(os.Getenv("OOAPI_GITHUB_BRANCH"))
		if os.Getenv("OOAPI_GITHUB_BRANCH") == "" && dir != "" && gitAvailable() {
			if current, err := gitOutput(ctx, dir, "rev-parse", "--abbrev-ref", "HEAD"); err == nil {
				branch = safeBranch(current)
			}
		}
		if dir != "" && gitAvailable() {
			if head, err := gitOutput(ctx, dir, "rev-parse", "HEAD"); err == nil {
				sha = head
			}
		}
		return web, owner, name, branch, sha
	}
	web, owner, name, _ = ParseGitHubRepo(defaultGitHubRepo)
	return web, owner, name, safeBranch(os.Getenv("OOAPI_GITHUB_BRANCH")), ""
}

func githubGet(ctx context.Context, path string, dest any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, githubAPI+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "OOAPI-Updater")
	if token := strings.TrimSpace(os.Getenv("OOAPI_GITHUB_TOKEN")); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("github http %d", res.StatusCode)
	}
	return json.Unmarshal(body, dest)
}

func firstLine(message string) string {
	message = strings.TrimSpace(message)
	if i := strings.IndexByte(message, '\n'); i >= 0 {
		message = message[:i]
	}
	if len(message) > 120 {
		return message[:120]
	}
	return message
}

func shortSHA(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}

// CheckSystemUpdate 对比本机提交和 GitHub 上的分支头。失败时仍返回仓库链接。
func CheckSystemUpdate(ctx context.Context, refresh bool) UpdateStatus {
	dir := findRepoDir()
	web, owner, name, branch, sha := resolveRepo(ctx, dir)
	key := owner + "/" + name + "@" + branch + ":" + sha

	updateGate.mu.Lock()
	applying := updateGate.applying
	last := updateGate.lastResult
	if !refresh && !applying && updateGate.cacheKey == key && time.Since(updateGate.cacheAt) < githubCacheFor {
		cached := updateGate.cache
		updateGate.mu.Unlock()
		cached.AutoUpdate = GetBoolOption(autoUpdateOption, false)
		cached.LastResult = last
		return cached
	}
	updateGate.mu.Unlock()

	status := UpdateStatus{
		RepoURL:    web,
		Owner:      owner,
		Name:       name,
		Branch:     branch,
		CurrentSHA: sha,
		State:      "unknown",
		AutoUpdate: GetBoolOption(autoUpdateOption, false),
		CheckedAt:  time.Now().UTC().Format(time.RFC3339),
		LastResult: last,
	}
	var latest ghCommit
	if err := githubGet(ctx, "/repos/"+url.PathEscape(owner)+"/"+url.PathEscape(name)+"/commits/"+url.PathEscape(branch), &latest); err != nil {
		status.Hint = "连上了仓库页面，但暂时读不到 GitHub 上的最新提交。"
		status.CanApply = false
		return remember(key, status)
	}
	status.LatestSHA = latest.SHA
	status.LatestMessage = firstLine(latest.Commit.Message)

	compared := false
	if sha != "" {
		var cmp ghCompare
		base := sha
		comparePath := "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(name) + "/compare/" + url.PathEscape(base) + "..." + url.PathEscape(branch)
		if err := githubGet(ctx, comparePath, &cmp); err == nil {
			compared = true
			// compare 的 ahead_by 是 head（分支）相对 base（本机）超前的提交，也就是我们落后的数量。
			status.RemoteAhead = cmp.AheadBy
			status.LocalAhead = cmp.BehindBy
			if len(cmp.Commits) > 0 {
				status.LatestMessage = firstLine(cmp.Commits[len(cmp.Commits)-1].Commit.Message)
				status.LatestSHA = cmp.Commits[len(cmp.Commits)-1].SHA
			}
		}
	}
	status.State = classifyUpdate(status.CurrentSHA, status.LatestSHA, status.RemoteAhead, status.LocalAhead, compared)
	status.CanApply = canApplyUpdate(dir, status.State)
	status.Hint = updateHint(dir, status)
	return remember(key, status)
}

func remember(key string, status UpdateStatus) UpdateStatus {
	updateGate.mu.Lock()
	updateGate.cacheKey = key
	updateGate.cacheAt = time.Now()
	updateGate.cache = status
	updateGate.mu.Unlock()
	return status
}

func repoHasGit(dir string) bool {
	if dir == "" || !gitAvailable() {
		return false
	}
	_, err := os.Stat(filepath.Join(dir, ".git"))
	return err == nil
}

func canApplyUpdate(dir, state string) bool {
	if state != "behind" && state != "unknown" {
		return false
	}
	hasCmd := strings.TrimSpace(os.Getenv("OOAPI_UPDATE_CMD")) != ""
	if state == "behind" {
		return hasCmd || repoHasGit(dir)
	}
	return hasCmd
}

func updateHint(dir string, status UpdateStatus) string {
	switch status.State {
	case "current":
		return "已经和 GitHub 上的 " + status.Branch + " 一致。"
	case "ahead":
		return "本机比 GitHub 超前 " + strconv.Itoa(status.LocalAhead) + " 个提交，不会自动回退。"
	case "diverged":
		return "本机和 GitHub 已经分叉，需要人工处理，这里不会强行合并。"
	case "behind":
		if status.CanApply {
			return "GitHub 领先 " + strconv.Itoa(max(status.RemoteAhead, 1)) + " 个提交。更新只做快进，不会覆盖本地改动。"
		}
		return "GitHub 上有更新，但这台机器没有可快进的源码目录。打开仓库查看，或配置 OOAPI_UPDATE_CMD。"
	default:
		if dir == "" {
			return "已链接到 GitHub 仓库。本机没有检出源码时，只能查看最新提交。"
		}
		return "已链接到 GitHub 仓库。"
	}
}

// SetSystemAutoUpdate 立刻写入设置。开启后后台大约每 15 分钟检查一次。
func SetSystemAutoUpdate(enabled bool) error {
	value := "false"
	if enabled {
		value = "true"
	}
	if err := SetOptions(map[string]string{autoUpdateOption: value}); err != nil {
		return err
	}
	updateGate.mu.Lock()
	updateGate.cacheAt = time.Time{}
	updateGate.mu.Unlock()
	return nil
}

// ApplySystemUpdate 把仓库快进到远程分支。可选再跑 OOAPI_UPDATE_CMD。
func ApplySystemUpdate(ctx context.Context) (UpdateStatus, error) {
	updateGate.mu.Lock()
	if updateGate.applying {
		updateGate.mu.Unlock()
		status := CheckSystemUpdate(ctx, false)
		status.State = "updating"
		status.Hint = "已经有一次更新在进行。"
		return status, fmt.Errorf("已经有一次更新在进行")
	}
	updateGate.applying = true
	updateGate.cacheAt = time.Time{}
	updateGate.mu.Unlock()
	defer func() {
		updateGate.mu.Lock()
		updateGate.applying = false
		updateGate.cacheAt = time.Time{}
		updateGate.mu.Unlock()
	}()

	before := CheckSystemUpdate(ctx, true)
	if !before.CanApply {
		return before, fmt.Errorf("%s", fallback(before.Hint, "当前不能更新"))
	}

	dir := findRepoDir()
	if before.State == "behind" && repoHasGit(dir) {
		if _, err := gitOutput(ctx, dir, "fetch", "origin", before.Branch); err != nil {
			return before, fmt.Errorf("拉取远程失败")
		}
		if _, err := gitOutput(ctx, dir, "merge", "--ff-only", "origin/"+before.Branch); err != nil {
			return before, fmt.Errorf("不能快进，工作区可能有未提交的修改")
		}
	}

	if cmdText := strings.TrimSpace(os.Getenv("OOAPI_UPDATE_CMD")); cmdText != "" {
		cmd := exec.CommandContext(ctx, "sh", "-c", cmdText)
		if dir != "" {
			cmd.Dir = dir
		}
		cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
		if out, err := cmd.CombinedOutput(); err != nil {
			log.Printf("[update] 更新命令失败: %v", err)
			return before, fmt.Errorf("更新命令执行失败")
		} else if len(out) > 0 {
			log.Printf("[update] 更新命令完成，输出 %d 字节", len(out))
		}
	}

	note := "已快进到最新提交。正在运行的进程要重新编译并重启后才会换成这一版。"
	if strings.TrimSpace(os.Getenv("OOAPI_UPDATE_CMD")) != "" {
		note = "已执行更新。若更新命令会重启服务，页面会短暂断开。"
	}
	updateGate.mu.Lock()
	updateGate.lastResult = note
	updateGate.mu.Unlock()

	after := CheckSystemUpdate(ctx, true)
	after.LastResult = note
	after.Hint = note
	log.Printf("[update] %s -> %s", shortSHA(before.CurrentSHA), shortSHA(after.LatestSHA))
	return after, nil
}

func fallback(value, other string) string {
	if strings.TrimSpace(value) == "" {
		return other
	}
	return value
}

// StartSystemAutoUpdate 在进程启动后延迟检查。开关默认关。
func StartSystemAutoUpdate() {
	go func() {
		timer := time.NewTimer(time.Minute)
		defer timer.Stop()
		for {
			<-timer.C
			timer.Reset(updateCheckEvery)
			if !GetBoolOption(autoUpdateOption, false) {
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
			status := CheckSystemUpdate(ctx, true)
			if status.State == "behind" && status.CanApply {
				if _, err := ApplySystemUpdate(ctx); err != nil {
					log.Printf("[update] 自动更新未完成: %v", err)
				}
			}
			cancel()
		}
	}()
}
