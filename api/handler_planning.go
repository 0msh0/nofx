package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/gin-gonic/gin"
	"net/http"
	"nofx/mcp"
	"nofx/planning"
	"nofx/planning/core"
	"nofx/planning/forge"
	"nofx/planning/harness"
	"nofx/planning/instrument"
	"nofx/planning/live"
	"nofx/planning/market"
	"nofx/planning/model"
	"nofx/planning/plugins"
	"nofx/store"
	"nofx/trader/binance"
	"nofx/trader/hyperliquid"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type planningBrokerCache struct {
	stamp  string
	broker live.Broker
}

type planningServices struct {
	brokers     sync.Map
	dataPlugins sync.Map
	feedSlots   chan struct{}
	source      *market.Client
	live        *live.Controller
	turns       sync.Map
	mutex       sync.Mutex
}

func (s *Server) planningService() (*planningServices, error) {
	s.planningMu.RLock()
	closing := s.planningClosing
	s.planningMu.RUnlock()
	if closing {
		return nil, errors.New("server is shutting down")
	}
	s.planningOnce.Do(func() {
		s.planningMu.Lock()
		defer s.planningMu.Unlock()
		if s.planningClosing {
			s.planningError = errors.New("server is shutting down")
			return
		}
		source := market.New()
		p := &planningServices{source: source, feedSlots: make(chan struct{}, 16)}
		controller, e := live.New(s.store.GormDB(), s.planningBroker, source)
		if e != nil {
			s.planningError = e
			return
		}
		p.live = controller
		if e = s.store.GormDB().AutoMigrate(&planning.Conversation{}, &planning.Preferences{}); e != nil {
			s.planningError = e
			return
		}
		s.planning = p
	})
	return s.planning, s.planningError
}
func accountKey(e *store.Exchange) string {
	return planning.AccountIdentity(e.ExchangeType, string(e.APIKey), e.HyperliquidWalletAddr)
}

func (s *Server) planningBroker(ctx context.Context, user, id string) (live.Broker, string, error) {
	ex, e := s.store.Exchange().GetByID(user, id)
	if e != nil || !ex.Enabled {
		return nil, "", errors.New("交易账户未启用或不属于当前用户")
	}
	running, er := s.store.Trader().ListByExchangeID(user, id)
	if er != nil {
		return nil, "", errors.New("cannot verify automatic trader state")
	}
	for _, t := range running {
		active := t.IsRunning
		if s.traderManager != nil {
			if runtime, e := s.traderManager.GetTrader(t.ID); e == nil {
				if yes, ok := runtime.GetStatus()["is_running"].(bool); ok && yes {
					active = true
				}
			}
		}
		if active {
			return nil, "", errors.New("该账户有自动交易运行中；请先停止自动交易，避免与已批准计划冲突")
		}
	}
	stampBytes, _ := json.Marshal([]any{ex.UpdatedAt, string(ex.APIKey), string(ex.SecretKey), ex.HyperliquidWalletAddr, ex.HyperliquidBuilderApproved, ex.Testnet})
	stampHash := sha256.Sum256(stampBytes)
	stamp := hex.EncodeToString(stampHash[:])
	if s.planning != nil {
		if cached, ok := s.planning.brokers.Load(user + "/" + id); ok {
			v := cached.(planningBrokerCache)
			if v.stamp == stamp {
				return v.broker, accountKey(ex), nil
			}
		}
	}
	cache := func(b live.Broker, key string) (live.Broker, string, error) {
		if s.planning != nil {
			s.planning.brokers.Store(user+"/"+id, planningBrokerCache{stamp: stamp, broker: b})
		}
		return b, key, nil
	}
	key := accountKey(ex)
	switch ex.ExchangeType {
	case "binance":
		if ex.APIKey == "" || ex.SecretKey == "" {
			return nil, "", errors.New("请先在 NOFX 设置中连接 Binance 合约账户")
		}
		return cache(binance.NewPlanningBroker(string(ex.APIKey), string(ex.SecretKey)), key)
	case "hyperliquid":
		if ex.APIKey == "" || ex.HyperliquidWalletAddr == "" || !ex.HyperliquidBuilderApproved || ex.Testnet {
			return nil, "", errors.New("请先在 NOFX 中完成 Hyperliquid 主网钱包、Agent 与 Builder 授权")
		}
		t, e := hyperliquid.NewHyperliquidTrader(string(ex.APIKey), ex.HyperliquidWalletAddr, false, true)
		if e != nil {
			return nil, "", errors.New("Hyperliquid 授权账户初始化失败")
		}
		return cache(&hyperliquid.PlanningBroker{Trader: t}, key)
	default:
		return nil, "", errors.New("首版真实规划执行支持 Binance USDT 合约和 Hyperliquid；不会使用交易类型回退")
	}
}
func (s *Server) planningAccount(user, id string) (*store.Exchange, error) {
	ex, e := s.store.Exchange().GetByID(user, id)
	if e != nil || !ex.Enabled {
		return nil, errors.New("请选择当前用户已启用的 NOFX 交易账户")
	}
	if ex.Testnet {
		return nil, errors.New("此入口只支持真实主网账户")
	}
	if ex.ExchangeType != "binance" && ex.ExchangeType != "hyperliquid" {
		return nil, errors.New("当前规划执行支持 Binance 与 Hyperliquid 永续账户")
	}
	return ex, nil
}
func planningError(c *gin.Context, e error) { c.JSON(http.StatusBadRequest, gin.H{"error": e.Error()}) }
func (s *Server) registerPlanning(api, protected *gin.RouterGroup) {
	for _, path := range []string{"instrument", "candles", "feed"} {
		api.GET("/planning/"+path, s.handlePlanningMarket)
	}
	protected.GET("/planning/account", s.handlePlanningReadAccount)
	protected.GET("/planning/state", s.handlePlanningState)
	protected.POST("/planning/chat", s.handlePlanningChat)
	protected.POST("/planning/compile", s.handlePlanningCompile)
	protected.POST("/planning/approve", s.handlePlanningApprove)
	protected.POST("/planning/execute", s.handlePlanningExecute)
	protected.POST("/planning/stop", s.handlePlanningStop)
	protected.POST("/planning/reconcile", s.handlePlanningReconcile)
	protected.GET("/planning/conversations", s.handlePlanningConversations)
	protected.GET("/planning/preferences", s.handlePlanningPreferences)
	protected.PUT("/planning/preferences", s.handlePlanningPreferences)
	protected.GET("/planning/entry-plugins", s.handlePlanningEntryPlugins)
	protected.GET("/planning/data-plugins", s.handlePlanningDataPlugins)
	protected.POST("/planning/data-plugins", s.handlePlanningDataPlugins)
	protected.GET("/planning/plugin-data", s.handlePlanningPluginData)
}
func (s *Server) handlePlanningMarket(c *gin.Context) {
	p, e := s.planningService()
	if e != nil {
		c.JSON(503, gin.H{"error": "planning service unavailable"})
		return
	}
	if strings.HasSuffix(c.Request.URL.Path, "/instrument") {
		b, e := p.source.Snapshot(c.Request.Context(), c.Query("venue"), c.Query("symbol"))
		if e != nil {
			planningError(c, e)
			return
		}
		c.JSON(200, b)
		return
	}
	var q market.CandleQuery
	if e = c.ShouldBindQuery(&q); e != nil {
		planningError(c, e)
		return
	}
	for name, target := range map[string]*int64{"from": &q.From, "to": &q.To} {
		if value := c.Query(name); value != "" {
			n, er := strconv.ParseInt(value, 10, 64)
			if er != nil {
				planningError(c, errors.New("invalid chart range"))
				return
			}
			*target = n
		}
	}
	if value := c.Query("limit"); value != "" {
		n, er := strconv.Atoi(value)
		if er != nil {
			planningError(c, errors.New("invalid chart count"))
			return
		}
		q.Limit = n
	}
	q.Venue = c.Query("venue")
	q.Symbol = c.Query("symbol")
	q.Interval = c.Query("interval")
	if q.Limit == 0 {
		q.Limit = 300
	}
	if e = q.Validate(); e != nil {
		planningError(c, e)
		return
	}
	if strings.HasSuffix(c.Request.URL.Path, "/candles") {
		rows, e := p.source.Candles(c.Request.Context(), q)
		if e != nil {
			planningError(c, e)
			return
		}
		c.JSON(200, gin.H{"candles": rows, "interval": q.Interval, "venue": q.Venue, "symbol": q.Symbol, "mode": "public", "received": time.Now().UTC()})
		return
	}
	if q.From != 0 || q.To != 0 {
		planningError(c, errors.New("feed cannot use historical bounds"))
		return
	}
	select {
	case p.feedSlots <- struct{}{}:
		defer func() { <-p.feedSlots }()
	default:
		c.JSON(429, gin.H{"error": "too many planning chart feeds"})
		return
	}
	c.Header("Content-Type", "text/event-stream")
	c.Header("X-Accel-Buffering", "no")
	tick := time.NewTicker(3 * time.Second)
	defer tick.Stop()
	for {
		rows, e := p.source.Candles(c.Request.Context(), q)
		data := harness.Event{Type: "candles", Data: gin.H{"candles": rows, "venue": q.Venue, "symbol": q.Symbol, "interval": q.Interval, "mode": "public", "received": time.Now().UTC()}}
		if e != nil {
			data = harness.Event{Type: "feed_error", Data: gin.H{"message": e.Error()}}
		}
		raw, _ := json.Marshal(data)
		if _, e = fmt.Fprintf(c.Writer, "data: %s\n\n", raw); e != nil {
			return
		}
		c.Writer.Flush()
		select {
		case <-c.Request.Context().Done():
			return
		case <-tick.C:
		}
	}
}
func (s *Server) handlePlanningState(c *gin.Context) {
	p, e := s.planningService()
	if e != nil {
		planningError(c, e)
		return
	}
	user := c.GetString("user_id")
	records := (&planning.DraftStore{DB: s.store.GormDB(), UserID: user}).Records()
	var bindings []planning.Draft
	s.store.GormDB().Select("id", "exchange_id").Where("user_id = ?", user).Find(&bindings)
	accounts := map[string]string{}
	for _, d := range bindings {
		accounts[d.ID] = d.ExchangeID
	}
	runs, e := p.live.List(user)
	if e != nil {
		planningError(c, e)
		return
	}
	c.JSON(200, gin.H{"records": records, "accounts": accounts, "runs": runs, "mode": "live", "now": time.Now().UTC()})
}
func (s *Server) handlePlanningCompile(c *gin.Context) {
	var in struct {
		ExchangeID  string           `json:"exchange_id"`
		Symbol      string           `json:"symbol"`
		Idea        core.Idea        `json:"idea"`
		Constraints core.Constraints `json:"constraints"`
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 32<<10)
	if e := c.ShouldBindJSON(&in); e != nil {
		planningError(c, errors.New("invalid draft input"))
		return
	}
	ex, e := s.planningAccount(c.GetString("user_id"), in.ExchangeID)
	if e != nil {
		planningError(c, e)
		return
	}
	p, e := s.planningService()
	if e != nil {
		planningError(c, e)
		return
	}
	snapshot, e := p.source.Snapshot(c.Request.Context(), ex.ExchangeType, in.Symbol)
	if e != nil {
		planningError(c, e)
		return
	}
	if in.Idea.Execution == nil {
		in.Idea.Execution = &core.Execution{Kind: "limit"}
	}
	draft, e := core.Compile(snapshot, in.Constraints, in.Idea, time.Now().UTC())
	if e != nil {
		planningError(c, e)
		return
	}
	ds := planning.DraftStore{DB: s.store.GormDB(), UserID: c.GetString("user_id"), ExchangeID: ex.ID, Venue: ex.ExchangeType}
	if e = ds.Add([]core.Plan{draft}); e != nil {
		planningError(c, e)
		return
	}
	c.JSON(200, draft)
}
func (s *Server) handlePlanningChat(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
	var in struct {
		harness.Input
		ExchangeID  string           `json:"exchange_id"`
		ModelID     string           `json:"model_id"`
		Constraints core.Constraints `json:"constraints"`
	}
	if e := c.ShouldBindJSON(&in); e != nil {
		planningError(c, errors.New("invalid planning input"))
		return
	}
	user := c.GetString("user_id")
	ex, e := s.planningAccount(user, in.ExchangeID)
	if e != nil {
		planningError(c, e)
		return
	}
	in.Venue = ex.ExchangeType
	if e = in.Validate(); e != nil {
		planningError(c, e)
		return
	}
	if e = in.Constraints.Validate(); e != nil {
		planningError(c, e)
		return
	}
	ai, e := s.store.AIModel().Get(user, in.ModelID)
	if e != nil || !ai.Enabled || ai.APIKey == "" {
		planningError(c, errors.New("请选择当前用户已配置并启用的 NOFX AI"))
		return
	}
	client := mcp.NewAIClientByProvider(ai.Provider)
	if client == nil {
		planningError(c, errors.New("NOFX 中未注册这个 AI 服务"))
		return
	}
	url := ai.CustomAPIURL
	if ai.Provider == "claw402" {
		url = ""
	}
	client.SetAPIKey(string(ai.APIKey), url, ai.CustomModelName)
	client.SetTimeout(90 * time.Second)
	p, e := s.planningService()
	if e != nil {
		planningError(c, e)
		return
	}
	if _, loaded := p.turns.LoadOrStore(user, true); loaded {
		c.JSON(409, gin.H{"error": "上一轮规划还在处理；请等待或停止它"})
		return
	}
	defer p.turns.Delete(user)
	ds := &planning.DraftStore{DB: s.store.GormDB(), UserID: user, ExchangeID: ex.ID, Venue: ex.ExchangeType}
	if in.PlanID != "" {
		var selected planning.Draft
		if e = s.store.GormDB().Where("user_id = ? AND id = ? AND exchange_id = ? AND status = ?", user, in.PlanID, ex.ID, "draft").First(&selected).Error; e != nil {
			planningError(c, errors.New("只可修改本账户未批准草案；已批准计划需先取消审批"))
			return
		}
	}
	hash := sha256.Sum256([]byte(user))
	root := filepath.Join("data", "planning", hex.EncodeToString(hash[:16]))
	if e = os.MkdirAll(root, 0700); e != nil {
		planningError(c, errors.New("planning workspace unavailable"))
		return
	}
	forgeRegistry, e := forge.Open(filepath.Join(root, "entry-plugins"))
	if e != nil {
		planningError(c, e)
		return
	}
	registry, e := s.planningDataRegistry(user)
	if e != nil {
		planningError(c, e)
		return
	}
	engine := harness.Engine{Store: ds, Market: p.source, Charts: p.source, Model: &model.NOFXAdapter{Client: client}, Limits: in.Constraints, Forge: forgeRegistry, Plugins: registry}
	var preferences planning.Preferences
	if s.store.GormDB().Where("user_id = ?", user).First(&preferences).Error == nil && preferences.Text != "" {
		engine.Memory = []string{preferences.Text}
	}
	c.Header("Content-Type", "text/event-stream")
	c.Header("X-Accel-Buffering", "no")
	ctx, cancel := context.WithTimeout(c.Request.Context(), 360*time.Second)
	defer cancel()
	messages := append([]harness.History(nil), in.History...)
	messages = append(messages, harness.History{Role: "user", Content: in.Message})
	emit := func(event harness.Event) error {
		if event.Type == "assistant" {
			raw, _ := json.Marshal(event.Data)
			var text map[string]string
			json.Unmarshal(raw, &text)
			messages = append(messages, harness.History{Role: "assistant", Content: text["message"]})
		}
		raw, e := json.Marshal(event)
		if e != nil {
			return e
		}
		_, e = fmt.Fprintf(c.Writer, "data: %s\n\n", raw)
		if e == nil {
			c.Writer.Flush()
		}
		return e
	}
	e = engine.Run(ctx, in.Input, emit)
	if e != nil && ctx.Err() == nil {
		_ = emit(harness.Event{Type: "error", Data: gin.H{"message": e.Error()}})
	}
	if in.SessionID != "" {
		raw, _ := json.Marshal(messages[max(0, len(messages)-20):])
		row := planning.Conversation{UserID: user, ID: in.SessionID, ExchangeID: ex.ID, ModelID: ai.ID, Symbol: in.Symbol, Messages: string(raw), UpdatedAt: time.Now().UTC()}
		s.store.GormDB().Save(&row)
	}
}
func (s *Server) handlePlanningApprove(c *gin.Context) {
	var in struct {
		PlanID       string `json:"plan_id"`
		Hash         string `json:"hash"`
		Confirmation string `json:"confirmation"`
	}
	if c.ShouldBindJSON(&in) != nil {
		planningError(c, errors.New("invalid approval"))
		return
	}
	p, e := s.planningService()
	if e != nil {
		planningError(c, e)
		return
	}
	var d planning.Draft
	if e = s.store.GormDB().Where("user_id = ? AND id = ?", c.GetString("user_id"), in.PlanID).First(&d).Error; e != nil {
		planningError(c, errors.New("plan not found"))
		return
	}
	unlock, e := s.lockPlanningAccount(c.GetString("user_id"), d.ExchangeID)
	if e != nil {
		planningError(c, e)
		return
	}
	defer unlock()
	v, e := p.live.Approve(c.Request.Context(), c.GetString("user_id"), in.PlanID, in.Hash, in.Confirmation)
	if e != nil {
		planningError(c, e)
		return
	}
	c.JSON(200, v)
}
func (s *Server) handlePlanningExecute(c *gin.Context) {
	var in struct {
		ID   string `json:"id"`
		Hash string `json:"hash"`
	}
	if c.ShouldBindJSON(&in) != nil {
		planningError(c, errors.New("invalid execution"))
		return
	}
	p, e := s.planningService()
	if e != nil {
		planningError(c, e)
		return
	}
	v, e := p.live.Execute(c.Request.Context(), c.GetString("user_id"), in.ID, in.Hash)
	if e != nil {
		planningError(c, e)
		return
	}
	c.JSON(200, v)
}
func (s *Server) handlePlanningStop(c *gin.Context) {
	var in struct {
		ID   string `json:"id"`
		Hash string `json:"hash"`
	}
	if c.ShouldBindJSON(&in) != nil {
		planningError(c, errors.New("invalid stop request"))
		return
	}
	p, e := s.planningService()
	if e != nil {
		planningError(c, e)
		return
	}
	v, e := p.live.Stop(c.GetString("user_id"), in.ID, in.Hash)
	if e != nil {
		planningError(c, e)
		return
	}
	c.JSON(200, v)
}
func (s *Server) handlePlanningReconcile(c *gin.Context) {
	var in struct {
		ID string `json:"id"`
	}
	if c.ShouldBindJSON(&in) != nil {
		planningError(c, errors.New("invalid reconciliation"))
		return
	}
	p, e := s.planningService()
	if e != nil {
		planningError(c, e)
		return
	}
	v, e := p.live.Reconcile(c.GetString("user_id"), in.ID)
	if e != nil {
		planningError(c, e)
		return
	}
	c.JSON(200, v)
}
func (s *Server) handlePlanningConversations(c *gin.Context) {
	if _, e := s.planningService(); e != nil {
		planningError(c, e)
		return
	}
	var rows []planning.Conversation
	if e := s.store.GormDB().Where("user_id = ?", c.GetString("user_id")).Order("updated_at desc").Limit(50).Find(&rows).Error; e != nil {
		planningError(c, e)
		return
	}
	c.JSON(200, rows)
}
func (s *Server) handlePlanningPreferences(c *gin.Context) {
	p, e := s.planningService()
	if e != nil {
		planningError(c, e)
		return
	}
	_ = p
	user := c.GetString("user_id")
	if c.Request.Method == http.MethodPut {
		var in struct {
			Text string `json:"text"`
		}
		if c.ShouldBindJSON(&in) != nil || len(in.Text) > 1600 || harness.HasCredential(in.Text) {
			planningError(c, errors.New("偏好最多1600字节，不能包含密钥"))
			return
		}
		if e := s.store.GormDB().Save(&planning.Preferences{UserID: user, Text: in.Text}).Error; e != nil {
			planningError(c, e)
			return
		}
		c.JSON(200, gin.H{"saved": true})
		return
	}
	var row planning.Preferences
	s.store.GormDB().Where("user_id = ?", user).First(&row)
	c.JSON(200, gin.H{"text": row.Text})
}
func (s *Server) handlePlanningEntryPlugins(c *gin.Context) {
	user := c.GetString("user_id")
	hash := sha256.Sum256([]byte(user))
	r, e := forge.Open(filepath.Join("data", "planning", hex.EncodeToString(hash[:16]), "entry-plugins"))
	if e != nil {
		planningError(c, e)
		return
	}
	c.JSON(200, r.List(c.Query("session_id")))
}

func (s *Server) lockPlanningAccount(user, id string) (func(), error) {
	p, e := s.planningService()
	if e != nil {
		return nil, e
	}
	ex, e := s.store.Exchange().GetByID(user, id)
	if e != nil {
		return nil, errors.New("account not found")
	}
	_ = p
	return planning.LockAccount(accountKey(ex)), nil
}
func (s *Server) handlePlanningReadAccount(c *gin.Context) {
	if !instrument.ValidSymbol(c.Query("symbol")) {
		planningError(c, errors.New("标的格式不正确"))
		return
	}
	p, e := s.planningService()
	if e != nil {
		planningError(c, e)
		return
	}
	b, _, e := s.planningBroker(c.Request.Context(), c.GetString("user_id"), c.Query("exchange_id"))
	if e != nil {
		planningError(c, e)
		return
	}
	_ = p
	a, e := b.Account(c.Request.Context(), c.Query("symbol"))
	if e != nil {
		planningError(c, e)
		return
	}
	c.JSON(200, gin.H{"equity": a.Equity, "available": a.Available, "fee_bps": a.FeeBPS, "position": a.Position, "open_orders": a.OpenOrders})
}

// Registry state is scoped to the logged-in user and shared with its tool loop.
func (s *Server) planningDataRegistry(user string) (*plugins.Registry, error) {
	p, e := s.planningService()
	if e != nil {
		return nil, e
	}
	if cached, ok := p.dataPlugins.Load(user); ok {
		return cached.(*plugins.Registry), nil
	}
	p.mutex.Lock()
	defer p.mutex.Unlock()
	if cached, ok := p.dataPlugins.Load(user); ok {
		return cached.(*plugins.Registry), nil
	}
	hash := sha256.Sum256([]byte(user))
	root := filepath.Join("data", "planning", hex.EncodeToString(hash[:16]))
	registry, e := plugins.Open(filepath.Join(root, "plugins.json"), append(plugins.Builtins(p.source), (plugins.Hyperdata{HTTP: p.source.HTTP, Base: "https://hyperdata.vergex.exchange"}).Definitions()...)...)
	if e != nil {
		return nil, e
	}
	p.dataPlugins.Store(user, registry)
	return registry, nil
}
func (s *Server) handlePlanningDataPlugins(c *gin.Context) {
	registry, e := s.planningDataRegistry(c.GetString("user_id"))
	if e != nil {
		planningError(c, e)
		return
	}
	if c.Request.Method == http.MethodPost {
		var in struct {
			ID      string `json:"id"`
			Enabled *bool  `json:"enabled"`
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4096)
		if c.ShouldBindJSON(&in) != nil || in.Enabled == nil {
			planningError(c, errors.New("invalid plugin setting"))
			return
		}
		if e = registry.SetEnabled(in.ID, *in.Enabled); e != nil {
			planningError(c, e)
			return
		}
	}
	c.JSON(200, registry.List())
}
func (s *Server) handlePlanningPluginData(c *gin.Context) {
	ex, e := s.planningAccount(c.GetString("user_id"), c.Query("exchange_id"))
	if e != nil {
		planningError(c, e)
		return
	}
	window := c.DefaultQuery("window", "7d")
	if window != "7d" && window != "30d" {
		planningError(c, errors.New("invalid plugin window"))
		return
	}
	registry, e := s.planningDataRegistry(c.GetString("user_id"))
	if e != nil {
		planningError(c, e)
		return
	}
	result, e := registry.Read(c.Request.Context(), c.Query("plugin"), plugins.Request{Venue: ex.ExchangeType, Symbol: c.Query("symbol"), Window: window})
	if e != nil {
		planningError(c, e)
		return
	}
	c.JSON(200, result)
}
