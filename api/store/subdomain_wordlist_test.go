package store

import "testing"

func TestNormalizeSubdomainGenerationMode(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		"":           SubdomainModeRandom,
		"random":     SubdomainModeRandom,
		"RANDOM":     SubdomainModeRandom,
		"wordlist":   SubdomainModeWordlist,
		" WORDLIST ": SubdomainModeWordlist,
		"custom":     "",
	}

	for input, expected := range cases {
		if got := NormalizeSubdomainGenerationMode(input); got != expected {
			t.Fatalf("NormalizeSubdomainGenerationMode(%q) = %q, want %q", input, got, expected)
		}
	}
}

func TestGenerateSubdomainLabelModes(t *testing.T) {
	t.Parallel()

	if len(DefaultSubdomainWordlist) < 100 {
		t.Fatalf("DefaultSubdomainWordlist should contain at least 100 entries, got %d", len(DefaultSubdomainWordlist))
	}

	for _, mode := range []string{SubdomainModeRandom, SubdomainModeWordlist} {
		for i := 0; i < 20; i++ {
			label := GenerateSubdomainLabel(mode)
			if normalizeSubdomainWord(label) != label {
				t.Fatalf("GenerateSubdomainLabel(%q) returned invalid label %q", mode, label)
			}
		}
	}
}

func TestNormalizeSubdomainWordlist(t *testing.T) {
	t.Parallel()

	input := " Support-Center \napi\ninvalid_label\nsupport-center\nx\nmx\n"
	got := NormalizeSubdomainWordlist(input)
	want := "support-center\napi\nmx"
	if got != want {
		t.Fatalf("NormalizeSubdomainWordlist() = %q, want %q", got, want)
	}
}

func TestGenerateSubdomainLabelWithCustomWordlist(t *testing.T) {
	t.Parallel()

	custom := []string{"support-center", "api-gateway", "mail-hub"}
	for i := 0; i < 20; i++ {
		label := GenerateSubdomainLabelWithWordlist(SubdomainModeWordlist, custom)
		found := false
		for _, item := range custom {
			if label == item {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("GenerateSubdomainLabelWithWordlist returned %q, not present in custom list", label)
		}
	}
}
