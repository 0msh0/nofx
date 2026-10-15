package api

import (
	"github.com/gin-gonic/gin"
)

func (s *Server) handlePlanningMarkets(c *gin.Context) {
	if c.Query("venue") != "binance" && c.Query("venue") != "hyperliquid" {
		c.JSON(400, gin.H{"error": "Choose Binance or Hyperliquid"})
		return
	}
	p, err := s.planningService()
	if err != nil {
		c.JSON(503, gin.H{"error": "Market discovery unavailable"})
		return
	}
	markets, err := p.source.Markets(c.Request.Context(), c.Query("venue"))
	if err != nil {
		c.JSON(503, gin.H{"error": "Public market list unavailable. Retry or enter a native symbol."})
		return
	}
	c.Header("Cache-Control", "public, max-age=30")
	c.JSON(200, markets)
}
