package instrument

import (
	"strings"
	"testing"
)

func TestNativeSymbolsPreserveHanAndRejectSeparators(t *testing.T) {
	for _, s := range []string{"BTCUSDT", "BTC-USDT-SWAP", "1000PEPEUSDT", "牛来USDT", "币安人生USDT", "牛来", "xyz:GOOGL", "xyz:SKHY"} {
		if !ValidSymbol(s) {
			t.Fatal("valid identifier rejected", s)
		}
	}
	for _, s := range []string{"", "btcUSDT", "XYZ:GOOGL", "xyz:googl", "xyz:GOOGL:EXTRA", "xyz/evil:GOOGL", "牛来 USDT", "牛来/USDT", "牛来USDT&limit=999", "牛来USDT%0A", "牛来\nUSDT", "牛来\u202eUSDT", "牛来🚀USDT", "ΒTCUSDT", strings.Repeat("牛", 41), string([]byte{0xff})} {
		if ValidSymbol(s) {
			t.Fatal("unsafe identifier accepted", s)
		}
	}
}
