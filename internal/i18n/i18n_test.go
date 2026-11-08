package i18n

import (
	"regexp"
	"slices"
	"strings"
	"testing"
)

var placeholder = regexp.MustCompile(`\{\{(\w+)\}\}`)

func params(text string) []string {
	var names []string
	for _, m := range placeholder.FindAllStringSubmatch(text, -1) {
		names = append(names, m[1])
	}
	slices.Sort(names)
	return names
}

// Every language has every text, with the same params in each.
func TestPacksMatch(t *testing.T) {
	english := packs[Fallback]
	if len(english) == 0 {
		t.Fatal("no English texts")
	}
	for _, locale := range Locales {
		texts := packs[locale]
		for key, text := range english {
			other, ok := texts[key]
			if !ok {
				t.Errorf("%s lacks %s", locale, key)
				continue
			}
			if !slices.Equal(params(text), params(other)) {
				t.Errorf("%s: %s has %v, English %v", locale, key, params(other), params(text))
			}
		}
		for key := range texts {
			if _, ok := english[key]; !ok {
				t.Errorf("%s has %s, which English lacks", locale, key)
			}
		}
	}
}

func TestT(t *testing.T) {
	if got := T("zh-CN", "email.security.none", nil); got != "不加密" {
		t.Errorf("Chinese: %q", got)
	}
	if got := T("fr-FR", "email.test.subject", nil); got != "SupaBI test email" {
		t.Errorf("unknown language: %q", got)
	}
	if got := T("en-US", "no.such.key", nil); got != "no.such.key" {
		t.Errorf("unknown key: %q", got)
	}
	got := T("en-US", "email.test.body", map[string]string{"name": "Ann", "email": "ann@example.com", "server": "smtp.example.com:587", "security": "STARTTLS"})
	if !strings.Contains(got, "Ann (ann@example.com)") || !strings.Contains(got, "smtp.example.com:587, STARTTLS") || strings.Contains(got, "{{") {
		t.Errorf("params: %q", got)
	}
}
