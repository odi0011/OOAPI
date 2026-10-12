package trading

// Cross 是快慢 EMA 在最后一根已收盘 K 线上的关系。
type Cross string

const (
	CrossNone   Cross = ""
	CrossGolden Cross = "golden"
	CrossDeath  Cross = "death"
)

// EMA 用 SMA 作为种子，之后按 k=2/(period+1) 递推。
// 返回切片与输入等长；下标 period-1 之前的值是 0，不能用来判断交叉。
func EMA(values []float64, period int) ([]float64, error) {
	if period < 1 {
		return nil, invalid("EMA 周期要大于 0")
	}
	if len(values) < period {
		return nil, invalid("K 线数量不足以计算 EMA")
	}
	out := make([]float64, len(values))
	var sum float64
	for i := 0; i < period; i++ {
		sum += values[i]
	}
	k := 2 / float64(period+1)
	out[period-1] = sum / float64(period)
	for i := period; i < len(values); i++ {
		out[i] = values[i]*k + out[i-1]*(1-k)
	}
	return out, nil
}

// LastCross 只看最后一根 K 线是否发生交叉。
// 金叉：上一根快线不超过慢线，这一根快线高于慢线。死叉相反。
// K 线不够时返回 CrossNone，不视为故障。
func LastCross(closes []float64, fastPeriod, slowPeriod int) (Cross, error) {
	if fastPeriod < 1 || slowPeriod <= fastPeriod {
		return CrossNone, invalid("快线周期要小于慢线")
	}
	// 慢线从下标 slowPeriod-1 开始有效，交叉还要看前一根。
	if len(closes) < slowPeriod+1 {
		return CrossNone, nil
	}
	fast, err := EMA(closes, fastPeriod)
	if err != nil {
		return CrossNone, err
	}
	slow, err := EMA(closes, slowPeriod)
	if err != nil {
		return CrossNone, err
	}
	i := len(closes) - 1
	return crossAt(fast[i-1], slow[i-1], fast[i], slow[i]), nil
}

func crossAt(prevFast, prevSlow, fast, slow float64) Cross {
	if prevFast <= prevSlow && fast > slow {
		return CrossGolden
	}
	if prevFast >= prevSlow && fast < slow {
		return CrossDeath
	}
	return CrossNone
}

// SideForCross 把交叉翻译成开仓方向。没有交叉就返回空。
func SideForCross(cross Cross) Side {
	switch cross {
	case CrossGolden:
		return SideLong
	case CrossDeath:
		return SideShort
	default:
		return ""
	}
}
