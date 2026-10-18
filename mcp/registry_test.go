package mcp

import "testing"

func TestNewAIClientByProviderSupportsOpenRouterAndCustom(t *testing.T) {
	for _, provider := range []string{ProviderOpenRouter, ProviderCustom} {
		client := NewAIClientByProvider(provider)
		if client == nil {
			t.Fatalf("provider %q must return a generic OpenAI-compatible client", provider)
		}
	}
}
