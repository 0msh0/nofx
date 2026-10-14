package api

import (
	"errors"
	"nofx/store"
	"nofx/trader/binance"
	"nofx/trader/types"
)

// Keep account inspection independent of autonomous-trader loading. A finite
// planning lease deliberately prevents that loader from creating a trader.
// This interface cannot submit, cancel, or change account settings.
type accountReader interface {
	GetPositions() ([]map[string]interface{}, error)
	GetOpenOrders(string) ([]types.OpenOrder, error)
}

func (s *Server) accountReadConfig(user, traderID string) (*store.Exchange, error) {
	if user == "" {
		return nil, errors.New("Authentication is required")
	}
	owned, err := s.store.Trader().List(user)
	if err != nil {
		return nil, errors.New("Could not verify account ownership")
	}
	for _, t := range owned {
		if traderID != "" && t.ID != traderID {
			continue
		}
		ex, err := s.store.Exchange().GetByID(user, t.ExchangeID)
		if err != nil || !ex.Enabled {
			return nil, errors.New("Trading account is unavailable or disabled")
		}
		if ex.ExchangeType == "binance" && ex.Testnet {
			return nil, errors.New("Binance testnet inspection is unsupported; mainnet fallback is disabled")
		}
		return ex, nil
	}
	return nil, errors.New("Trader does not belong to this account")
}

func (s *Server) accountReadClient(user, traderID string) (accountReader, error) {
	ex, err := s.accountReadConfig(user, traderID)
	if err != nil {
		return nil, err
	}
	if ex.ExchangeType == "binance" {
		// The general Binance constructor changes hedge mode. Reading positions
		// must use the existing NOFX constructor with no account-setting writes.
		return binance.NewExecutionTrader(string(ex.APIKey), string(ex.SecretKey), user), nil
	}
	return buildExchangeProbeTrader(ex, user)
}
