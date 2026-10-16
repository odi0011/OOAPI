package handlers

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"ooapi/internal/trading"
)

/*
现货钱包：余额读取与划转。

两者都用**策略绑定的那把交易所密钥**（与交易台、数据看板同一把）——
归属由 deskSecretOpener 按 user_id 收口，传别人的策略 ID 取不到密钥。

划转是动钱的操作，所以：
  · 路由单独挂 option:edit；
  · 请求体里只有「方向和数量」，没有「划给谁」—— 钱只能在当前用户
    自己绑定的那个交易所账户的两个钱包之间走；
  · 成功后写操作日志，事后能查到是谁划的、划了多少。

测网上这两个接口都会返回「只在实盘可用」：现货测网与合约测网是两套
互不连通的账本（见 trading.spotTarget）。
*/

// 抽成变量是为了测试能替换成指向 mock 主机的客户端，
// 与交易台那边的 `var newDeskBook = trading.NewDeskBook` 同一个做法。
var (
	newSpotReadClient     = trading.NewSpotReadClient
	newSpotTransferClient = trading.NewSpotTransferClient
)

/*
GetSpotBalances 一次读**现货**与**资金账户**两个钱包。

为什么两个一起读：用户问"我的钱在哪"时，只看现货会给出**错误的答案**——
资金账户（Funding wallet，P2P 与币安支付的落点）是另一个钱包，
`/api/v3/account` 读不到它。"我账户里应该还有 4 刀"那次误判就是这么来的。

资金账户读失败**不拖垮整个响应**：现货读到了就先给现货，在 fundingError
里写明原因（多数是密钥没开对应权限）。一个钱包读不到不该让整页打不开。

用途之一是核对划转：合约、现货、资金是三个钱包，划完要看目标那边
是否真到账，而不是只看划转接口回了成功。
*/
func GetSpotBalances(c *gin.Context) {
	user, row, okRow := deskRow(c)
	if !okRow {
		return
	}
	client, err := newSpotReadClient(row.Record.Mode)
	if err != nil {
		writeEngineErr(c, err)
		return
	}
	creds, err := deskSecretOpener(user.ID, row)()
	if err != nil {
		writeEngineErr(c, err)
		return
	}
	if err := client.UseCredentials(creds); err != nil {
		writeEngineErr(c, err)
		return
	}
	spot, err := client.SpotBalances()
	if err != nil {
		writeEngineErr(c, err)
		return
	}
	out := gin.H{
		"network":       row.Record.Mode,
		"exchangeKeyId": row.Record.ExchangeKeyID,
		"spot":          spot,
		"funding":       []trading.SpotBalance{},
	}
	if funding, ferr := client.FundingBalances(); ferr != nil {
		out["fundingError"] = ferr.Error()
	} else {
		out["funding"] = funding
	}
	ok(c, out)
}

type transferRequest struct {
	From   string  `json:"from"`   // spot | funding | futures
	To     string  `json:"to"`     // spot | funding | futures
	Asset  string  `json:"asset"`  // 例如 USDT
	Amount float64 `json:"amount"` // 正数
}

// PostTradingTransfer 在现货钱包与 USDT-M 合约钱包之间划转。
func PostTradingTransfer(c *gin.Context) {
	user, row, okRow := deskRow(c)
	if !okRow {
		return
	}
	var req transferRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}
	client, err := newSpotTransferClient(row.Record.Mode)
	if err != nil {
		writeEngineErr(c, err)
		return
	}
	creds, err := deskSecretOpener(user.ID, row)()
	if err != nil {
		writeEngineErr(c, err)
		return
	}
	if err := client.UseCredentials(creds); err != nil {
		writeEngineErr(c, err)
		return
	}
	result, err := client.Transfer(trading.TransferRequest{
		From:   strings.TrimSpace(req.From),
		To:     strings.TrimSpace(req.To),
		Asset:  req.Asset,
		Amount: req.Amount,
	})
	if err != nil {
		writeEngineErr(c, err)
		return
	}
	// 动钱的操作必须留痕：这一条会出现在「操作日志」页里。
	auditLog(c, "钱包划转", fmt.Sprintf("%s %s：%s → %s（tranId %d）",
		formatTransferAmount(result.Amount), result.Asset, result.From, result.To, result.TranID))
	ok(c, gin.H{
		"tranId": result.TranID,
		"asset":  result.Asset,
		"amount": result.Amount,
		"from":   result.From,
		"to":     result.To,
	})
}

// formatTransferAmount 给审计文案用的金额文本。不用 %f —— 那会带一串无意义的 0。
func formatTransferAmount(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}
