package handlers

import (
	"database/sql"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/trading"
)

/*
现货网格的接口。

和策略接口（/api/trading/strategies）刻意分成两组路由：网格没有
leverage / emaFast / stopR 这些字段，硬塞进同一个请求体，会造出一个
一半字段永远为空的结构 —— 而"这个字段到底属不属于这一行"是排查时
最容易出错的地方。

两条比别处更紧的约束：

  · 网格**独占一个交易对**。它会撤掉该交易对上所有不认识挂单，
    所以同一个交易对上不能同时跑手工挂单或另一条网格；
  · 实盘门闩在 GridExchangeFor 里再拦一道。网格一次挂十几张单，
    比趋势引擎更容易在某条少见的路径上绕过门闩，而绕过之后动的是真钱。
*/

// gridRunner 是进程内的网格调度器。测试默认不启动。
var gridRunner = trading.NewGridRunner(trading.DefaultGridHub())

// newGridExchange 建一个现货网格出口。
//
// 抽成变量是为了测试能把它指向 mock 主机 —— 与交易台那边的
// `var newDeskBook` 同一个做法。**不要在生产路径上替换它**：
// 它是实盘门闩落地的地方（见 trading.GridExchangeFor）。
var newGridExchange = trading.GridExchangeFor

// StartGridRunner 恢复数据库里 running=1 的网格。
// TRADING_RUNNER=0 时不启动，只留手工 step。
func StartGridRunner() {
	installGridFillLog()
	if runnerDisabled() {
		log.Printf("[grid] 进程内调度已关闭（TRADING_RUNNER）")
		return
	}
	gridRunner.SetStop(func(gridID int64) {
		// 网格自己停机（止损 / 上沿止盈）时把运行标记落库，
		// 否则重启之后它又会自己跑起来，而用户以为已经停了。
		if err := setGridRunning(gridID, 0, false, ""); err != nil {
			log.Printf("[grid] 同步运行标记失败 id=%d: %v", gridID, err)
		}
	})
	gridRunner.Start()
	specs, err := listRunningGrids()
	if err != nil {
		log.Printf("[grid] 恢复运行中的网格失败: %v", err)
		return
	}
	gridRunner.Sync(specs)
	log.Printf("[grid] 已恢复 %d 条运行中的网格", len(specs))
}

// ---------------------------------------------------------------------------
// 预览：这个区间、这个交易对，最少要多少钱
// ---------------------------------------------------------------------------

type gridPreviewRequest struct {
	Symbol        string  `json:"symbol"`
	Lower         float64 `json:"lower"`
	Upper         float64 `json:"upper"`
	Levels        int     `json:"levels"`
	QuoteBudget   float64 `json:"quoteBudget"`
	StopPct       float64 `json:"stopPct"`
	ExchangeKeyID int64   `json:"exchangeKeyId"`
	Mode          string  `json:"mode"`
}

/*
PostGridPreview 算一份网格计划，**不保存、不下单**。

这是这个模块里最有用的一个接口：用户真正的困惑不是"怎么填参数"，
而是"我这个账户到底能不能跑、要多少钱"。所以响应里除了计划本身，
还有两个档位的资金门槛，以及门槛是被哪一项顶起来的
（交易所最小名义 / 步长零头）—— 两者的解法完全不同。
*/
func PostGridPreview(c *gin.Context) {
	user, okUser := requireTradingUser(c)
	if !okUser {
		return
	}
	var req gridPreviewRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}
	rules, price, mode, full, terr := gridMarketContext(user.ID, req.ExchangeKeyID, req.Mode, req.Symbol)
	if terr != nil {
		writeTradingError(c, terr)
		return
	}
	in := trading.GridInput{
		Symbol:      strings.ToUpper(strings.TrimSpace(req.Symbol)),
		Lower:       req.Lower,
		Upper:       req.Upper,
		Levels:      req.Levels,
		QuoteBudget: req.QuoteBudget,
		LastPrice:   price,
		FeeRate:     full,
		MinNotional: rules.MinNotional,
		StepSize:    rules.StepSize,
		MinQty:      rules.MinQty,
		TickSize:    rules.TickSize,
		StopPct:     req.StopPct,
	}

	out := gin.H{
		"symbol":        in.Symbol,
		"mode":          mode,
		"lastPrice":     price,
		"feeRate":       full,
		"stepSize":      rules.StepSize,
		"tickSize":      rules.TickSize,
		"minNotional":   rules.MinNotional,
		"baseAsset":     rules.BaseAsset,
		"quoteAsset":    rules.QuoteAsset,
		"minNotionalKnown": rules.MinNotional > 0,
	}

	// 资金门槛先算 —— 即使计划本身不合法，这个数也算得出来，
	// 而它恰恰是用户在参数不对的时候最需要看到的。
	if need, rerr := trading.GridRequirementFor(in); rerr == nil {
		out["requirement"] = need
	} else {
		out["requirementError"] = rerr.Error()
	}

	plan, err := trading.BuildGridPlan(in)
	if err != nil {
		out["ok"] = false
		out["message"] = err.Error()
		if reason := gridReasonOf(err); reason != "" {
			out["reason"] = reason
		}
		ok(c, out)
		return
	}
	out["ok"] = true
	out["plan"] = plan
	ok(c, out)
}

// gridReasonOf 从带原因的校验错误里取出机器可读的原因码。
// 取不到时回空串，让前端退回只显示文案 —— 而不是给它一个假原因。
func gridReasonOf(err error) string {
	var re *trading.ReasonError
	if errors.As(err, &re) {
		return re.Reason
	}
	return ""
}

/*
gridMarketContext 拿到算计划需要的三样东西：交易对规则、当前价、真实费率。

**真实费率必须读出来，不能用常量。** 币安现货基础档是 0.1%/边，
而合约的 taker 费是 0.05% —— 用后者去算，一份实际亏损的网格会被
算成盈利的，而网格的每格收益本来就只有一两个百分点。

读不到费率时返回 0，由 trading 包用不乐观的兜底值（现货 0.1%）顶上。
*/
func gridMarketContext(userID, keyID int64, mode, symbol string) (
	trading.GridRules, float64, string, float64, *tradingError,
) {
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	if symbol == "" {
		return trading.GridRules{}, 0, "", 0,
			&tradingError{Status: http.StatusBadRequest, Message: "请选择交易对", Code: "bad_request"}
	}
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "" {
		// 没给就用用户绑的那把密钥的网络；一把都没有时按测网。
		if keyID > 0 {
			stored, err := loadExchangeKey(keyID, userID)
			if err == nil && stored.Network != "" {
				mode = stored.Network
			}
		}
	}
	if mode != trading.ModeTestnet && mode != trading.ModeLive {
		mode = trading.ModeTestnet
	}
	client, err := newGridExchange(mode)
	if err != nil {
		return trading.GridRules{}, 0, mode, 0, engineError(err)
	}
	rules, err := client.Rules(symbol)
	if err != nil {
		return trading.GridRules{}, 0, mode, 0, engineError(err)
	}
	price, err := client.LastPrice(symbol)
	if err != nil {
		return trading.GridRules{}, 0, mode, 0, engineError(err)
	}
	// 费率是账户级数据，要密钥；读不到不是错误，兜底值更保守。
	fee := 0.0
	if keyID > 0 {
		if opener := gridSecretOpener(userID, keyID, mode); opener != nil {
			if creds, cerr := opener(); cerr == nil {
				if uerr := client.UseCredentials(creds); uerr == nil {
					fee = client.CommissionRate()
				}
			}
		}
	}
	return rules, price, mode, fee, nil
}

// engineError 把 trading 包的错误翻译成接口层能回的状态码。
func engineError(err error) *tradingError {
	if err == nil {
		return nil
	}
	if errors.Is(err, trading.ErrLiveGateClosed) {
		return &tradingError{Status: http.StatusForbidden,
			Message: "实盘门闩未打开，网格不能进入实盘", Code: "live_gate_closed"}
	}
	var ve *trading.ValidationError
	if errors.As(err, &ve) {
		return &tradingError{Status: http.StatusBadRequest, Message: ve.Error(), Code: "bad_request"}
	}
	return &tradingError{Status: http.StatusBadGateway, Message: err.Error(), Code: "exchange_error"}
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

type gridWrite struct {
	Symbol        *string  `json:"symbol"`
	ExchangeKeyID *int64   `json:"exchangeKeyId"`
	Mode          *string  `json:"mode"`
	Lower         *float64 `json:"lower"`
	Upper         *float64 `json:"upper"`
	Levels        *int     `json:"levels"`
	QuoteBudget   *float64 `json:"quoteBudget"`
	StopPct       *float64 `json:"stopPct"`
}

const (
	gridDefaultLevels = 8
	gridMinBudget     = 1.0
	gridMaxBudget     = 1_000_000.0
)

// gridView 是列表和详情共用的形状。
func gridView(row gridRow, snap *trading.GridSnapshot) gin.H {
	cfg := row.Config
	out := gin.H{
		"id":            cfg.ID,
		"symbol":        cfg.Symbol,
		"mode":          cfg.Mode,
		"exchangeKeyId": cfg.ExchangeKeyID,
		"lower":         round8(cfg.Lower),
		"upper":         round8(cfg.Upper),
		"levels":        cfg.Levels,
		"quoteBudget":   round8(cfg.QuoteBudget),
		"stopPct":       round8(cfg.StopPct),
		"feeRate":       round8(cfg.FeeRate),
		"running":       cfg.Running,
		"pauseReason":   cfg.PauseReason,
		"exchangeKeyNetwork": row.KeyNetwork,
		"exchangeKeyActive":  row.KeyStatus == exchangeKeyActive,
		"warnings":      gridWarnings(cfg.Mode, row.KeyNetwork, row.KeyStatus == exchangeKeyActive),
	}
	if snap != nil {
		out["snapshot"] = snap
	} else {
		// 内存里没有这台引擎（进程重启后还没推进过，或本来就没在跑）。
		// 这里如实回 null，不编一个"全零的运行状态"—— 那会让界面
		// 显示"运行中、持仓 0、成交 0"，而实际上什么都没在跑。
		out["snapshot"] = nil
	}
	return out
}

// gridWarnings 与策略那套同源：mode 和密钥网络不一致、密钥已作废，
// 都是"能保存但跑不起来"的状态，必须提前说。
func gridWarnings(mode, keyNetwork string, keyActive bool) []string {
	out := []string{}
	if mode == trading.ModeLive {
		out = append(out, liveModeWarning)
	}
	if keyNetwork != "" && keyNetwork != mode {
		out = append(out, networkMismatchWarning)
	}
	if !keyActive {
		out = append(out, revokedKeyWarning)
	}
	return out
}

// ListGrids 列出当前用户的网格，最新修改的在前。
func ListGrids(c *gin.Context) {
	user, okUser := requireTradingUser(c)
	if !okUser {
		return
	}
	rows, err := listGrids(user.ID)
	if err != nil {
		log.Printf("[grid] 查询网格失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询网格失败", "server_error")
		return
	}
	// 运行状态只在内存里 —— 库里的那一列只是"该不该跑"。
	snaps := trading.DefaultGridHub().UserSnapshots(user.ID)
	items := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		var snap *trading.GridSnapshot
		if s, okSnap := snaps[row.Config.ID]; okSnap {
			copied := s
			snap = &copied
		}
		items = append(items, gridView(row, snap))
	}
	ok(c, gin.H{"items": items})
}

// GetGrid 读取一条网格：配置 + 运行状态 + 成交明细。
func GetGrid(c *gin.Context) {
	user, okUser := requireTradingUser(c)
	if !okUser {
		return
	}
	id, okID := parseTradingID(c)
	if !okID {
		return
	}
	row, err := loadGrid(id, user.ID)
	if isNotFound(err) {
		fail(c, http.StatusNotFound, "网格不存在", "not_found")
		return
	}
	if err != nil {
		log.Printf("[grid] 读取网格失败: %v", err)
		fail(c, http.StatusInternalServerError, "读取网格失败", "server_error")
		return
	}
	var snap *trading.GridSnapshot
	if s, okSnap := trading.DefaultGridHub().Snapshot(id); okSnap {
		snap = &s
	}
	view := gridView(row, snap)
	view["fills"] = gridFills(id, 100)
	if _, realized, serr := trading.GridSummaryFor(id); serr == nil {
		view["realizedUsdt"] = round8(realized)
	}
	// 逐格还持有多少 —— 从成交明细算出来，与引擎用的是同一份数据。
	if holds, herr := trading.GridHoldings(id); herr == nil {
		view["holdings"] = holds
	}
	ok(c, view)
}

// CreateGrid 建一条网格。建成时**不自动开始运行** ——
// 挂十几张真钱单之前，用户应当先看到预览里的资金门槛。
func CreateGrid(c *gin.Context) {
	user, okUser := requireTradingUser(c)
	if !okUser {
		return
	}
	var req gridWrite
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}
	cfg, terr := applyGridWrite(user.ID, nil, req)
	if terr != nil {
		writeTradingError(c, terr)
		return
	}
	if taken, terr2 := gridSymbolTaken(user.ID, cfg.ExchangeKeyID, cfg.Symbol, 0); terr2 != nil {
		writeTradingError(c, terr2)
		return
	} else if taken {
		fail(c, http.StatusConflict,
			"该交易对上已有运行中的网格（网格会撤掉这个交易对上所有挂单，不能和别的策略共用）",
			"symbol_in_use")
		return
	}
	res, err := exec(gridInsertSQL, user.ID, cfg.ExchangeKeyID, cfg.Symbol, cfg.Mode,
		cfg.Lower, cfg.Upper, cfg.Levels, cfg.QuoteBudget, cfg.StopPct, cfg.FeeRate)
	if err != nil {
		log.Printf("[grid] 写入网格失败: %v", err)
		fail(c, http.StatusInternalServerError, "保存网格失败", "server_error")
		return
	}
	id, err := res.LastInsertId()
	if err != nil || id <= 0 {
		fail(c, http.StatusInternalServerError, "保存网格失败", "server_error")
		return
	}
	auditLog(c, "创建网格", cfg.Symbol+" 区间 "+formatGridNum(cfg.Lower)+"–"+formatGridNum(cfg.Upper)+
		" "+strconv.Itoa(cfg.Levels)+" 线")
	row, err := loadGrid(id, user.ID)
	if err != nil {
		fail(c, http.StatusInternalServerError, "读取网格失败", "server_error")
		return
	}
	ok(c, gridView(row, nil))
}

// UpdateGrid 改一条网格的配置。**运行中不允许改** —— 改了要重算计划，
// 而盘口上还挂着按旧计划挂的单，改完两边对不上。
func UpdateGrid(c *gin.Context) {
	user, okUser := requireTradingUser(c)
	if !okUser {
		return
	}
	id, okID := parseTradingID(c)
	if !okID {
		return
	}
	row, err := loadGrid(id, user.ID)
	if isNotFound(err) {
		fail(c, http.StatusNotFound, "网格不存在", "not_found")
		return
	}
	if err != nil {
		log.Printf("[grid] 读取网格失败: %v", err)
		fail(c, http.StatusInternalServerError, "读取网格失败", "server_error")
		return
	}
	if row.Config.Running || trading.DefaultGridHub().Tracking(id) {
		fail(c, http.StatusConflict, "网格运行中不能改参数，请先停止", "grid_running")
		return
	}
	var req gridWrite
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}
	cfg, terr := applyGridWrite(user.ID, &row, req)
	if terr != nil {
		writeTradingError(c, terr)
		return
	}
	if taken, terr2 := gridSymbolTaken(user.ID, cfg.ExchangeKeyID, cfg.Symbol, id); terr2 != nil {
		writeTradingError(c, terr2)
		return
	} else if taken {
		fail(c, http.StatusConflict, "该交易对上已有运行中的网格", "symbol_in_use")
		return
	}
	if _, err := exec(gridUpdateSQL, cfg.ExchangeKeyID, cfg.Symbol, cfg.Mode,
		cfg.Lower, cfg.Upper, cfg.Levels, cfg.QuoteBudget, cfg.StopPct, cfg.FeeRate,
		id, user.ID); err != nil {
		log.Printf("[grid] 更新网格失败: %v", err)
		fail(c, http.StatusInternalServerError, "保存网格失败", "server_error")
		return
	}
	auditLog(c, "修改网格", cfg.Symbol+" 区间 "+formatGridNum(cfg.Lower)+"–"+formatGridNum(cfg.Upper))
	updated, err := loadGrid(id, user.ID)
	if err != nil {
		fail(c, http.StatusInternalServerError, "读取网格失败", "server_error")
		return
	}
	ok(c, gridView(updated, nil))
}

// DeleteGrid 删掉一条网格。运行中的要先停 —— 直接删会让盘口上的挂单
// 失去主人，那些单会一直挂在那里，直到有人手工撤。
func DeleteGrid(c *gin.Context) {
	user, okUser := requireTradingUser(c)
	if !okUser {
		return
	}
	id, okID := parseTradingID(c)
	if !okID {
		return
	}
	row, err := loadGrid(id, user.ID)
	if isNotFound(err) {
		fail(c, http.StatusNotFound, "网格不存在", "not_found")
		return
	}
	if err != nil {
		log.Printf("[grid] 读取网格失败: %v", err)
		fail(c, http.StatusInternalServerError, "读取网格失败", "server_error")
		return
	}
	if row.Config.Running || trading.DefaultGridHub().Tracking(id) {
		fail(c, http.StatusConflict, "网格运行中不能删除，请先停止", "grid_running")
		return
	}
	if _, err := exec(gridDeleteSQL, id, user.ID); err != nil {
		log.Printf("[grid] 删除网格失败: %v", err)
		fail(c, http.StatusInternalServerError, "删除网格失败", "server_error")
		return
	}
	auditLog(c, "删除网格", row.Config.Symbol)
	ok(c, gin.H{"id": id})
}

// ---------------------------------------------------------------------------
// 启停
// ---------------------------------------------------------------------------

// PostGridStart 开始运行一条网格。
func PostGridStart(c *gin.Context) {
	user, okUser := requireTradingUser(c)
	if !okUser {
		return
	}
	id, okID := parseTradingID(c)
	if !okID {
		return
	}
	row, err := loadGrid(id, user.ID)
	if isNotFound(err) {
		fail(c, http.StatusNotFound, "网格不存在", "not_found")
		return
	}
	if err != nil {
		log.Printf("[grid] 读取网格失败: %v", err)
		fail(c, http.StatusInternalServerError, "读取网格失败", "server_error")
		return
	}
	if terr := ensureSelectableKey(user.ID, row.Config.ExchangeKeyID); terr != nil {
		writeTradingError(c, terr)
		return
	}
	if taken, terr := gridSymbolTaken(user.ID, row.Config.ExchangeKeyID, row.Config.Symbol, id); terr != nil {
		writeTradingError(c, terr)
		return
	} else if taken {
		fail(c, http.StatusConflict, "该交易对上已有运行中的网格", "symbol_in_use")
		return
	}
	// 先真正建一次引擎：区间、精度、资金门槛的问题要在这里就暴露，
	// 而不是等它"运行"了几拍之后才发现一张单都挂不出去。
	spec := trading.GridRunSpec{
		UserID:  user.ID,
		Config:  row.Config,
		Secrets: gridSecretOpener(user.ID, row.Config.ExchangeKeyID, row.Config.Mode),
	}
	if err := startGrid(spec); err != nil {
		writeTradingError(c, engineError(err))
		return
	}
	if err := setGridRunning(id, user.ID, true, ""); err != nil {
		log.Printf("[grid] 记下运行标记失败: %v", err)
		fail(c, http.StatusInternalServerError, "启动失败", "server_error")
		return
	}
	row.Config.Running = true
	auditLog(c, "启动网格", row.Config.Symbol)
	snap, _ := trading.DefaultGridHub().Snapshot(id)
	ok(c, gridView(row, &snap))
}

// PostGridStop 停止一条网格。**默认清仓** —— 见 trading.GridEngine.Stop。
func PostGridStop(c *gin.Context) {
	user, okUser := requireTradingUser(c)
	if !okUser {
		return
	}
	id, okID := parseTradingID(c)
	if !okID {
		return
	}
	row, err := loadGrid(id, user.ID)
	if isNotFound(err) {
		fail(c, http.StatusNotFound, "网格不存在", "not_found")
		return
	}
	if err != nil {
		log.Printf("[grid] 读取网格失败: %v", err)
		fail(c, http.StatusInternalServerError, "读取网格失败", "server_error")
		return
	}
	// 先落库再停：停的过程会撤单、平仓，中间可能失败；
	// 先把"不该再跑"这一意愿写下来，进程即使此刻挂掉也不会自己重启。
	if err := setGridRunning(id, user.ID, false, ""); err != nil {
		log.Printf("[grid] 记下停止标记失败: %v", err)
		fail(c, http.StatusInternalServerError, "停止失败", "server_error")
		return
	}
	if eng, tracked := trading.DefaultGridHub().Get(id); tracked {
		if serr := eng.Stop(time.Now().UTC(), trading.ReasonGridStoppedByUser); serr != nil {
			log.Printf("[grid] 停止网格 %d 出错: %v", id, serr)
			auditLog(c, "停止网格（有错误）", row.Config.Symbol+": "+serr.Error())
			fail(c, http.StatusBadGateway, "清仓时出错，请到交易所确认挂单是否已撤干净: "+serr.Error(), "grid_stop_failed")
			return
		}
	}
	trading.DefaultGridHub().Remove(id)
	gridRunner.Remove(id)
	row.Config.Running = false
	auditLog(c, "停止网格", row.Config.Symbol)
	snap := trading.GridSnapshot{ID: id, Symbol: row.Config.Symbol, State: trading.GridStopped}
	ok(c, gridView(row, &snap))
}

/*
startGrid 建引擎并让它接上调度。**建失败就直接返回错误**。

引擎的构造里已经包含了计划计算（区间、精度、资金门槛都在那儿校验），
所以"启动"这一步顺带就是一次完整的前置检查 —— 比让用户点了开始、
等几拍之后发现一个格子都没挂上要好得多。
*/
func startGrid(spec trading.GridRunSpec) error {
	ex, err := newGridExchange(spec.Config.Mode)
	if err != nil {
		return err
	}
	if spec.Secrets != nil {
		creds, cerr := spec.Secrets()
		if cerr != nil {
			return cerr
		}
		if uerr := ex.UseCredentials(creds); uerr != nil {
			return uerr
		}
	}
	price, err := ex.LastPrice(spec.Config.Symbol)
	if err != nil {
		return err
	}
	eng, err := trading.BuildGridEngine(spec.Config, price, ex, trading.CurrentGridFillLog(), trading.StdLogger())
	if err != nil {
		return err
	}
	if err := eng.Start(time.Now().UTC()); err != nil {
		return err
	}
	if err := trading.DefaultGridHub().Put(eng); err != nil {
		return err
	}
	gridRunner.SetStop(func(gridID int64) {
		if err := setGridRunning(gridID, 0, false, ""); err != nil {
			log.Printf("[grid] 同步运行标记失败 id=%d: %v", gridID, err)
		}
	})
	if gridRunner.Started() {
		gridRunner.Ensure(spec)
	}
	return nil
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

// applyGridWrite 把请求体合并到已有配置上（更新时）或默认值上（创建时），
// 然后做一遍完整校验。校验用**真实的交易对规则**跑一次计划计算 ——
// 保存时就该知道这个区间、这个预算到底能不能跑。
func applyGridWrite(userID int64, base *gridRow, req gridWrite) (trading.GridConfig, *tradingError) {
	var cfg trading.GridConfig
	if base != nil {
		cfg = base.Config
	} else {
		cfg = trading.GridConfig{
			Symbol: "DOGEUSDT", Mode: trading.ModeTestnet,
			Levels: gridDefaultLevels,
		}
	}
	if req.Symbol != nil {
		cfg.Symbol = strings.ToUpper(strings.TrimSpace(*req.Symbol))
	}
	if req.ExchangeKeyID != nil {
		cfg.ExchangeKeyID = *req.ExchangeKeyID
	}
	if req.Mode != nil {
		cfg.Mode = strings.ToLower(strings.TrimSpace(*req.Mode))
	}
	if req.Lower != nil {
		cfg.Lower = *req.Lower
	}
	if req.Upper != nil {
		cfg.Upper = *req.Upper
	}
	if req.Levels != nil {
		cfg.Levels = *req.Levels
	}
	if req.QuoteBudget != nil {
		cfg.QuoteBudget = *req.QuoteBudget
	}
	if req.StopPct != nil {
		cfg.StopPct = *req.StopPct
	}

	cfg = cfg.Normalize()
	if cfg.ExchangeKeyID <= 0 {
		return cfg, &tradingError{Status: http.StatusBadRequest,
			Message: "请先绑定一把未作废的交易所密钥", Code: "bad_request"}
	}
	if terr := ensureSelectableKey(userID, cfg.ExchangeKeyID); terr != nil {
		return cfg, terr
	}
	if cfg.Mode != trading.ModeTestnet && cfg.Mode != trading.ModeLive {
		return cfg, &tradingError{Status: http.StatusBadRequest,
			Message: "mode 只能是 testnet 或 live", Code: "bad_request"}
	}
	if cfg.QuoteBudget < gridMinBudget || cfg.QuoteBudget > gridMaxBudget {
		return cfg, &tradingError{Status: http.StatusBadRequest,
			Message: "投入金额要大于 0", Code: "bad_request"}
	}

	/*
		用真实的交易对规则跑一遍计划计算。

		这一步是刻意的：区间太密、每格太小、预算不够，全都是**只有
		拿到真实 stepSize / minNotional 才能判断**的问题。放到保存时
		而不是启动时，用户就不用"点了开始、等几拍、发现没挂上单"。
	*/
	rules, price, _, fee, terr := gridMarketContext(userID, cfg.ExchangeKeyID, cfg.Mode, cfg.Symbol)
	if terr != nil {
		return cfg, terr
	}
	// 费率以账户上的真实值为准存下来 —— 网格的每格收益全靠它算，
	// 用兜底值会让界面上显示的收益和实际不符。
	if fee > 0 {
		cfg.FeeRate = fee
	}
	_, err := trading.BuildGridPlan(trading.GridInput{
		Symbol:      cfg.Symbol,
		Lower:       cfg.Lower,
		Upper:       cfg.Upper,
		Levels:      cfg.Levels,
		QuoteBudget: cfg.QuoteBudget,
		LastPrice:   price,
		FeeRate:     cfg.FeeRate,
		MinNotional: rules.MinNotional,
		StepSize:    rules.StepSize,
		MinQty:      rules.MinQty,
		TickSize:    rules.TickSize,
		StopPct:     cfg.StopPct,
	})
	if err != nil {
		code := "bad_request"
		if reason := gridReasonOf(err); reason != "" {
			code = reason
		}
		return cfg, &tradingError{Status: http.StatusBadRequest, Message: err.Error(), Code: code}
	}
	return cfg, nil
}

// gridSymbolTaken 检查这个交易对上是否已有另一条运行中的网格。
//
// 网格会撤掉该交易对上**所有**不认识的挂单，所以同一个交易对上
// 不能同时跑两条网格，也不能和趋势策略共用（趋势策略的止损止盈
// 会被网格当成"外来挂单"撤掉）。
func gridSymbolTaken(userID, keyID int64, symbol string, exceptID int64) (bool, *tradingError) {
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	if symbol == "" {
		return false, &tradingError{Status: http.StatusBadRequest,
			Message: "请选择交易对", Code: "bad_request"}
	}
	// 另一条运行中的网格占着这个交易对。
	var found int64
	err := queryRow(gridRunningDupSQL, userID, keyID, symbol, exceptID).Scan(&found)
	switch {
	case err == nil && found > 0:
		return true, nil
	case err != nil && !errors.Is(err, sql.ErrNoRows):
		log.Printf("[grid] 检查交易对占用失败: %v", err)
		return false, &tradingError{Status: http.StatusInternalServerError,
			Message: "检查交易对失败", Code: "server_error"}
	}
	// 一条运行中的**趋势策略**同样占着这个交易对：网格会撤掉该交易对上
	// 所有不认识的挂单，而趋势策略的止损止盈正挂在上面 —— 共用会让
	// 网格把别人的保护单撤掉，那是真事故。
	// exceptID 传 0 而不是网格 ID：那个参数是**策略** ID。
	// 网格和策略的 ID 各有一套自增，撞号的概率不为零 —— 传网格 ID
	// 进去，撞上时会把一条正在跑的冲突策略当成"自己"放过去。
	if taken, terr := runningSymbolTaken(userID, keyID, symbol, 0); terr != nil {
		return false, terr
	} else if taken {
		return true, nil
	}
	return false, nil
}

// formatGridNum 给审计文案用的价格文本。不用 %f —— 那会带一串无意义的 0。
func formatGridNum(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}
