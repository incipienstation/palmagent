// This experimental port is not used by Palmagent's application.
package model

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf16"
)

const MaxTextUnits = 160

// JS slice counts UTF-16 units and can leave a trailing high surrogate.
type Text []uint16

func (s Text) MarshalJSON() ([]byte, error) {
	if len(s) > 0 && s[len(s)-1] >= 0xD800 && s[len(s)-1] <= 0xDBFF {
		prefix, err := json.Marshal(string(utf16.Decode(s[:len(s)-1])))
		if err != nil {
			return nil, err
		}
		return []byte(string(prefix[:len(prefix)-1]) + fmt.Sprintf("\\u%04x\"", s[len(s)-1])), nil
	}
	return json.Marshal(string(utf16.Decode(s)))
}

type Choice struct {
	Value Text `json:"value"`
	Label Text `json:"label"`
}
type Model struct {
	Choice
	Efforts []Choice `json:"efforts"`
}
type Catalog struct {
	Agent     string  `json:"agent"`
	Source    string  `json:"source"`
	FetchedAt int     `json:"fetchedAt"`
	Models    []Model `json:"models"`
}

func record(v any) map[string]any {
	if r, ok := v.(map[string]any); ok {
		return r
	}
	return nil
}
func coalesce(values ...any) any {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}
func jsSpace(r rune) bool {
	return r == 0x09 || r == 0x0A || r == 0x0B || r == 0x0C || r == 0x0D || r == 0x20 || r == 0xA0 || r == 0x1680 || (r >= 0x2000 && r <= 0x200A) || r == 0x2028 || r == 0x2029 || r == 0x202F || r == 0x205F || r == 0x3000 || r == 0xFEFF
}
func text(v any) Text {
	s, ok := v.(string)
	if !ok {
		return nil
	}
	var out []rune
	space := false
	for _, r := range strings.TrimFunc(s, jsSpace) {
		if r == '\t' || r == '\r' || r == '\n' || r == ' ' {
			if !space {
				out = append(out, ' ')
			}
			space = true
		} else {
			out = append(out, r)
			space = false
		}
	}
	units := utf16.Encode(out)
	if len(units) > MaxTextUnits {
		units = units[:MaxTextUnits]
	}
	return units
}
func key(v Text) string { // Preserve even an unpaired surrogate in deduplication.
	var b strings.Builder
	for _, u := range v {
		b.WriteByte(byte(u >> 8))
		b.WriteByte(byte(u))
	}
	return b.String()
}
func choice(t Text) Choice { return Choice{t, t} }
func defaults() []Choice   { return []Choice{choice(text("default"))} }
func efforts(v any) []Choice {
	out := defaults()
	seen := map[string]bool{key(out[0].Value): true}
	rows, _ := v.([]any)
	for i, item := range rows {
		if i == 64 {
			break
		}
		value := item
		if _, ok := item.(string); !ok {
			r := record(item)
			value = coalesce(r["reasoningEffort"], r["effort"], r["value"])
		}
		t := text(value)
		if len(t) > 0 && !seen[key(t)] {
			seen[key(t)] = true
			out = append(out, choice(t))
		}
	}
	return out
}

func Parse(v any) (Catalog, error) {
	root := record(v)
	rows, ok := root["data"].([]any)
	if !ok {
		rows, _ = root["models"].([]any)
	}
	models := []Model{}
	seen := map[string]bool{key(text("default")): true}
	delegate := defaults()
	for i, item := range rows {
		if i == 128 {
			break
		}
		r := record(item)
		if r["hidden"] == true {
			continue
		}
		t := text(coalesce(r["model"], r["id"]))
		if len(t) == 0 || seen[key(t)] {
			continue
		}
		seen[key(t)] = true
		projected := Model{choice(t), efforts(r["supportedReasoningEfforts"])}
		models = append(models, projected)
		if r["isDefault"] == true {
			delegate = projected.Efforts
		}
	}
	if len(models) == 0 {
		return Catalog{}, errors.New("empty_catalog")
	}
	return Catalog{"codex", "runtime", 123, append([]Model{{choice(text("default")), delegate}}, models...)}, nil
}
