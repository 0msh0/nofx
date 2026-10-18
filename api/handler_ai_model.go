package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"nofx/config"
	"nofx/crypto"
	"nofx/logger"
	"nofx/security"
	"nofx/store"
	"nofx/wallet"

	"github.com/gin-gonic/gin"
)

type ModelConfig struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Provider     string `json:"provider"`
	Enabled      bool   `json:"enabled"`
	APIKey       string `json:"apiKey,omitempty"`
	CustomAPIURL string `json:"customApiUrl,omitempty"`
}

// SafeModelConfig Safe model configuration structure (does not contain sensitive information)
type SafeModelConfig struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Provider        string `json:"provider"`
	Enabled         bool   `json:"enabled"`
	HasAPIKey       bool   `json:"has_api_key"`
	CustomAPIURL    string `json:"customApiUrl"`    // Custom API URL (usually not sensitive)
	CustomModelName string `json:"customModelName"` // Custom model name (not sensitive)
	WalletAddress   string `json:"walletAddress,omitempty"`
	BalanceUSDC     string `json:"balanceUsdc,omitempty"`
}

// ModelConfigUpdate is a single model's update payload. It is a named type
// (rather than an inline anonymous struct) so the log-sanitizer in utils.go is
// guaranteed to stay in sync with this shape — a mismatch there is what let
// plaintext credentials reach the logs previously.
type ModelConfigUpdate struct {
	Enabled         bool   `json:"enabled"`
	APIKey          string `json:"api_key"`
	CustomAPIURL    string `json:"custom_api_url"`
	CustomModelName string `json:"custom_model_name"`
}

type UpdateModelConfigRequest struct {
	Models map[string]ModelConfigUpdate `json:"models"`
}

const defaultOpenRouterBaseURL = "https://openrouter.ai/api/v1"

// SupportedAIModel is a safe, credential-free template shown when a user adds
// an AI provider. Configuration values are still stored only after the user
// explicitly saves a provider setup.
type SupportedAIModel struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Provider     string `json:"provider"`
	DefaultModel string `json:"defaultModel,omitempty"`
	DefaultURL   string `json:"defaultUrl,omitempty"`
}

func supportedAIModelTemplates() []SupportedAIModel {
	return []SupportedAIModel{
		{
			ID:           "openai",
			Name:         "OpenAI Direct",
			Provider:     "openai",
			DefaultModel: "gpt-5.4",
			DefaultURL:   "https://api.openai.com/v1",
		},
		{
			ID:         "openrouter",
			Name:       "OpenRouter",
			Provider:   "openrouter",
			DefaultURL: "https://openrouter.ai/api/v1",
		},
		{
			ID:       "custom",
			Name:     "Custom OpenAI-Compatible API",
			Provider: "custom",
		},
		{
			ID:           "claw402",
			Name:         "Claw402 (Base USDC)",
			Provider:     "claw402",
			DefaultModel: "gpt-5.6",
		},
	}
}

func normalizeProviderModelConfig(provider string, modelData ModelConfigUpdate) (ModelConfigUpdate, error) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	modelData.CustomAPIURL = strings.TrimSpace(modelData.CustomAPIURL)
	modelData.CustomModelName = strings.TrimSpace(modelData.CustomModelName)

	if !modelData.Enabled {
		return modelData, nil
	}

	switch provider {
	case "openrouter":
		if modelData.CustomModelName == "" {
			return modelData, fmt.Errorf("OpenRouter requires a model name")
		}
		if modelData.CustomAPIURL == "" {
			modelData.CustomAPIURL = defaultOpenRouterBaseURL
		}
	case "custom":
		if modelData.CustomAPIURL == "" {
			return modelData, fmt.Errorf("Custom OpenAI-compatible API requires a base URL")
		}
		if modelData.CustomModelName == "" {
			return modelData, fmt.Errorf("Custom OpenAI-compatible API requires a model name")
		}
	}

	return modelData, nil
}

func validateProviderAPIKey(provider string, enabled bool, incomingKey string, hasExistingKey bool) error {
	if !enabled || strings.TrimSpace(incomingKey) != "" || hasExistingKey {
		return nil
	}

	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "openrouter", "custom":
		return fmt.Errorf("%s requires an API key before it can be enabled", provider)
	default:
		return nil
	}
}

func existingModelForUpdate(models []*store.AIModel, modelID string) *store.AIModel {
	for _, model := range models {
		if model != nil && model.ID == modelID {
			return model
		}
	}
	for _, model := range models {
		if model != nil && model.Provider == modelID {
			return model
		}
	}
	return nil
}

// handleGetModelConfigs Get AI model configurations
func (s *Server) handleGetModelConfigs(c *gin.Context) {
	userID := c.GetString("user_id")
	logger.Infof("🔍 Querying AI model configs for user %s", userID)
	models, err := s.store.AIModel().List(userID)
	if err != nil {
		logger.Infof("❌ Failed to get AI model configs: %v", err)
		SafeInternalError(c, "Failed to get AI model configs", err)
		return
	}

	// If no models in database, return default models
	if len(models) == 0 {
		logger.Infof("⚠️ No AI models in database, returning defaults")
		defaultModels := []SafeModelConfig{
			{ID: "claw402", Name: "Claw402 (Base USDC)", Provider: "claw402", Enabled: false, HasAPIKey: false},
		}
		c.JSON(http.StatusOK, defaultModels)
		return
	}

	logger.Infof("✅ Found %d AI model configs", len(models))

	// Convert to safe response structure, remove sensitive information
	safeModels := make([]SafeModelConfig, 0, len(models))
	for _, model := range models {
		if !store.IsVisibleAIModel(model) {
			continue
		}
		safeModel := SafeModelConfig{
			ID:              model.ID,
			Name:            model.Name,
			Provider:        model.Provider,
			Enabled:         model.Enabled,
			HasAPIKey:       model.APIKey != "",
			CustomAPIURL:    model.CustomAPIURL,
			CustomModelName: model.CustomModelName,
		}

		if model.Provider == "claw402" {
			if privateKey := strings.TrimSpace(model.APIKey.String()); privateKey != "" {
				if walletAddress, addrErr := walletAddressFromPrivateKey(privateKey); addrErr == nil {
					safeModel.WalletAddress = walletAddress
					safeModel.BalanceUSDC = wallet.QueryUSDCBalanceStr(walletAddress)
				} else {
					logger.Warnf("⚠️ Failed to derive claw402 wallet address for model %s: %v", model.ID, addrErr)
				}
			}
		}

		safeModels = append(safeModels, safeModel)
	}

	if len(safeModels) == 0 {
		logger.Infof("⚠️ No visible AI models in database, returning defaults")
		defaultModels := []SafeModelConfig{
			{ID: "claw402", Name: "Claw402 (Base USDC)", Provider: "claw402", Enabled: false, HasAPIKey: false},
		}
		c.JSON(http.StatusOK, defaultModels)
		return
	}

	c.JSON(http.StatusOK, safeModels)
}

// handleUpdateModelConfigs Update AI model configurations (supports both encrypted and plain text based on config)
func (s *Server) handleUpdateModelConfigs(c *gin.Context) {
	userID := c.GetString("user_id")
	cfg := config.Get()

	// Read raw request body
	bodyBytes, err := c.GetRawData()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to read request body"})
		return
	}

	var req UpdateModelConfigRequest

	// Check if transport encryption is enabled
	if !cfg.TransportEncryption {
		// Transport encryption disabled, accept plain JSON
		if err := json.Unmarshal(bodyBytes, &req); err != nil {
			logger.Infof("❌ Failed to parse plain JSON request: %v", err)
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request format"})
			return
		}
		logger.Infof("📝 Received plain text model config (UserID: %s)", userID)
	} else {
		// Transport encryption enabled, require encrypted payload
		var encryptedPayload crypto.EncryptedPayload
		if err := json.Unmarshal(bodyBytes, &encryptedPayload); err != nil {
			logger.Infof("❌ Failed to parse encrypted payload: %v", err)
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request format, encrypted transmission required"})
			return
		}

		// Verify encrypted data
		if encryptedPayload.WrappedKey == "" {
			logger.Infof("❌ Detected unencrypted request (UserID: %s)", userID)
			c.JSON(http.StatusBadRequest, gin.H{
				"error":   "This endpoint only supports encrypted transmission, please use encrypted client",
				"code":    "ENCRYPTION_REQUIRED",
				"message": "Encrypted transmission is required for security reasons",
			})
			return
		}

		// Decrypt data
		decrypted, err := s.cryptoHandler.cryptoService.DecryptSensitiveData(&encryptedPayload)
		if err != nil {
			logger.Infof("❌ Failed to decrypt model config (UserID: %s): %v", userID, err)
			c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to decrypt data"})
			return
		}

		// Parse decrypted data
		if err := json.Unmarshal([]byte(decrypted), &req); err != nil {
			logger.Infof("❌ Failed to parse decrypted data: %v", err)
			c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to parse decrypted data"})
			return
		}
		logger.Infof("🔓 Decrypted model config data (UserID: %s)", userID)
	}

	userModels, listErr := s.store.AIModel().List(userID)
	if listErr != nil {
		SafeInternalError(c, "List AI models", listErr)
		return
	}

	// Update each model's configuration and track traders that need reload.
	// The request key may be either the model row id or the provider name
	// (legacy clients send the provider, e.g. "claw402", while trader rows
	// reference the full model id) — resolve both, mirroring the matching in
	// AIModelStore.Update, otherwise running traders keep the old model.
	modelIDCandidates := func(modelID string) map[string]bool {
		candidates := map[string]bool{modelID: true}
		for _, m := range userModels {
			if m != nil && (m.ID == modelID || m.Provider == modelID) {
				candidates[m.ID] = true
				candidates[m.Provider] = true
			}
		}
		return candidates
	}

	tradersToReload := make(map[string]bool)
	for modelID, modelData := range req.Models {
		provider := modelID
		hasExistingKey := false
		if existingModel := existingModelForUpdate(userModels, modelID); existingModel != nil {
			provider = existingModel.Provider
			hasExistingKey = strings.TrimSpace(existingModel.APIKey.String()) != ""
		}
		if err := validateProviderAPIKey(provider, modelData.Enabled, modelData.APIKey, hasExistingKey); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("Invalid %s configuration: %v", provider, err)})
			return
		}
		modelData, err = normalizeProviderModelConfig(provider, modelData)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("Invalid %s configuration: %v", provider, err)})
			return
		}
		req.Models[modelID] = modelData

		// SSRF protection: validate custom_api_url before storing
		if modelData.CustomAPIURL != "" {
			cleanURL := strings.TrimSuffix(modelData.CustomAPIURL, "#")
			if err := security.ValidateURL(cleanURL); err != nil {
				logger.Warnf("Invalid custom_api_url for model %s: %v", modelID, err)
				c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("Invalid custom_api_url for model %s: URL must be a valid HTTPS endpoint", modelID)})
				return
			}
		}

		// Find traders using this AI model BEFORE updating
		for candidateID := range modelIDCandidates(modelID) {
			traders, _ := s.store.Trader().ListByAIModelID(userID, candidateID)
			for _, t := range traders {
				tradersToReload[t.ID] = true
			}
		}

		err := s.store.AIModel().Update(userID, modelID, modelData.Enabled, modelData.APIKey, modelData.CustomAPIURL, modelData.CustomModelName)
		if err != nil {
			SafeInternalError(c, fmt.Sprintf("Update model %s", modelID), err)
			return
		}
	}

	// Remove affected traders from memory BEFORE reloading to pick up new config
	for traderID := range tradersToReload {
		logger.Infof("🔄 Removing trader %s from memory to reload with new AI model config", traderID)
		s.traderManager.RemoveTrader(traderID)
	}

	// Reload all traders for this user to make new config take effect immediately
	err = s.traderManager.LoadUserTradersFromStore(s.store, userID)
	if err != nil {
		logger.Infof("⚠️ Failed to reload user traders into memory: %v", err)
		// Don't return error here since model config was successfully updated to database
	}

	logger.Infof("✓ AI model config updated: %+v", SanitizeModelConfigForLog(req.Models))
	c.JSON(http.StatusOK, gin.H{"message": "Model configuration updated"})
}

// handleGetSupportedModels returns the credential-free provider templates that
// the UI may offer for configuration. No key or existing model record is exposed.
func (s *Server) handleGetSupportedModels(c *gin.Context) {
	c.JSON(http.StatusOK, supportedAIModelTemplates())
}
