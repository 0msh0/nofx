package api

import (
	"strings"
	"testing"

	"nofx/store"
)

func TestSupportedAIModelTemplatesExposeDirectAndFallbackProviders(t *testing.T) {
	models := supportedAIModelTemplates()
	byID := make(map[string]SupportedAIModel, len(models))
	for _, model := range models {
		byID[model.ID] = model
	}

	for _, want := range []struct {
		id       string
		provider string
	}{
		{id: "openai", provider: "openai"},
		{id: "openrouter", provider: "openrouter"},
		{id: "custom", provider: "custom"},
		{id: "claw402", provider: "claw402"},
	} {
		model, ok := byID[want.id]
		if !ok {
			t.Fatalf("supported models missing %q", want.id)
		}
		if model.Provider != want.provider {
			t.Fatalf("model %q provider = %q, want %q", want.id, model.Provider, want.provider)
		}
	}

	if byID["openai"].DefaultModel == "" {
		t.Fatal("OpenAI Direct must have a default model")
	}
	if byID["openrouter"].DefaultURL == "" {
		t.Fatal("OpenRouter must have a default base URL")
	}
}

func TestNormalizeProviderModelConfigRejectsIncompleteDirectProviders(t *testing.T) {
	tests := []struct {
		name     string
		provider string
		config   ModelConfigUpdate
		wantErr  string
	}{
		{
			name:     "custom needs URL",
			provider: "custom",
			config:   ModelConfigUpdate{Enabled: true, CustomModelName: "my-model"},
			wantErr:  "base URL",
		},
		{
			name:     "custom needs model",
			provider: "custom",
			config:   ModelConfigUpdate{Enabled: true, CustomAPIURL: "https://example.test/v1"},
			wantErr:  "model name",
		},
		{
			name:     "disabled custom accepts cleared fields",
			provider: "custom",
			config:   ModelConfigUpdate{Enabled: false},
		},
		{
			name:     "openrouter needs model",
			provider: "openrouter",
			config:   ModelConfigUpdate{Enabled: true},
			wantErr:  "model name",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := normalizeProviderModelConfig(tt.provider, tt.config)
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("error = %v, want text %q", err, tt.wantErr)
			}
		})
	}
}

func TestExistingModelForUpdateFallsBackToProviderMatch(t *testing.T) {
	models := []*store.AIModel{
		{ID: "user-1_custom", Provider: "custom"},
		{ID: "user-1_openrouter", Provider: "openrouter"},
	}

	model := existingModelForUpdate(models, "custom")
	if model == nil || model.ID != "user-1_custom" {
		t.Fatalf("provider fallback returned %#v, want custom model", model)
	}
}

func TestValidateProviderAPIKeyRequiresKeyOnlyWhenEnablingNewDirectProvider(t *testing.T) {
	if err := validateProviderAPIKey("openrouter", true, "", false); err == nil {
		t.Fatal("enabling a new OpenRouter configuration without a key must fail")
	}
	if err := validateProviderAPIKey("custom", true, "", false); err == nil {
		t.Fatal("enabling a new Custom configuration without a key must fail")
	}
	for _, tt := range []struct {
		name           string
		provider       string
		enabled        bool
		incomingKey    string
		hasExistingKey bool
	}{
		{name: "disable custom", provider: "custom", enabled: false},
		{name: "edit saved openrouter", provider: "openrouter", enabled: true, hasExistingKey: true},
		{name: "new custom key", provider: "custom", enabled: true, incomingKey: "sk-test"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if err := validateProviderAPIKey(tt.provider, tt.enabled, tt.incomingKey, tt.hasExistingKey); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestNormalizeProviderModelConfigUsesOpenRouterDefaultURL(t *testing.T) {
	config, err := normalizeProviderModelConfig("openrouter", ModelConfigUpdate{
		Enabled:         true,
		CustomModelName: "openai/gpt-5.4",
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.CustomAPIURL != defaultOpenRouterBaseURL {
		t.Fatalf("openrouter URL = %q, want %q", config.CustomAPIURL, defaultOpenRouterBaseURL)
	}
}
