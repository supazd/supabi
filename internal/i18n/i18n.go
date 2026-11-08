// Package i18n holds what the server writes for people to read, such as
// emails, in each language the interface offers. Each language is a JSON
// file named as the interface names it. See .agents/design/architecture.md
// 10.1 and .agents/design/email.md 6.
package i18n

import (
	"embed"
	"encoding/json"
	"fmt"
	"strings"
)

//go:embed *.json
var files embed.FS

// Fallback is the language of a text that another lacks.
const Fallback = "en-US"

// Locales are the languages there are texts in.
var Locales = []string{"en-US", "zh-CN"}

var packs = func() map[string]map[string]string {
	out := make(map[string]map[string]string, len(Locales))
	for _, locale := range Locales {
		raw, err := files.ReadFile(locale + ".json")
		if err != nil {
			panic(err) // embedded at build time
		}
		var tree map[string]any
		if err := json.Unmarshal(raw, &tree); err != nil {
			panic(fmt.Sprintf("i18n: %s.json: %v", locale, err))
		}
		texts := map[string]string{}
		flatten("", tree, texts)
		out[locale] = texts
	}
	return out
}()

// flatten names each text by its path, such as email.test.subject.
func flatten(prefix string, tree map[string]any, into map[string]string) {
	for key, value := range tree {
		switch v := value.(type) {
		case string:
			into[prefix+key] = v
		case map[string]any:
			flatten(prefix+key+".", v, into)
		default:
			panic(fmt.Sprintf("i18n: %s%s is neither text nor a group", prefix, key))
		}
	}
}

// T is the text of key in the language, with each {{name}} replaced by its
// param. A language there are no texts in, or a key it lacks, falls back to
// English; a key none has is returned as it is.
func T(locale, key string, params map[string]string) string {
	text, ok := packs[locale][key]
	if !ok {
		if text, ok = packs[Fallback][key]; !ok {
			return key
		}
	}
	for name, value := range params {
		text = strings.ReplaceAll(text, "{{"+name+"}}", value)
	}
	return text
}
