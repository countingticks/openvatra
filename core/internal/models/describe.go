package models

import (
	"regexp"
	"strings"

	"github.com/countingticks/openvatra/core/internal/fit"
)

// Owner is the catalog entry a model file belongs to.
type Owner struct {
	Name string
	Tags []string // the catalog's tags: "chat", "code", "vision"
}

var (
	quantRe = regexp.MustCompile(`(?i)(?:UD-)?(?:IQ\d_[A-Z0-9_]+|Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32|MXFP4)`)
	codeRe  = regexp.MustCompile(`(?i)coder|devstral|\bcode\b`)
)

// Quant is the last quantisation label in a file stem, upper-cased; "" when there is none.
func Quant(stem string) string {
	all := quantRe.FindAllString(stem, -1)
	if len(all) == 0 {
		return ""
	}
	return strings.ToUpper(all[len(all)-1])
}

// Describe returns list with Name, Quant and Tags set on every model. owner may be nil, and may answer false.
func Describe(list []Model, owner func(path string) (Owner, bool)) []Model {
	out := make([]Model, len(list))
	for i, m := range list {
		o, owned := Owner{}, false
		if owner != nil {
			o, owned = owner(m.Path)
		}
		switch {
		case owned && o.Name != "":
			m.Name = o.Name
		case m.GeneralName != "":
			m.Name = m.GeneralName
		default:
			m.Name = strings.NewReplacer("-", " ", "_", " ").Replace(m.ID)
		}
		m.Quant = Quant(m.ID)
		m.Tags = []string{}
		if owned && hasTag(o.Tags, "code") || codeRe.MatchString(m.ID) {
			m.Tags = append(m.Tags, "Code")
		}
		if m.Kind != KindUnreadable {
			if m.MMProj != "" {
				m.Tags = append(m.Tags, "Vision")
			}
			if m.Kind == KindChat && fit.MoE(m.Shape) {
				m.Tags = append(m.Tags, "MoE")
			}
			if m.Kind == KindEmbedding {
				m.Tags = append(m.Tags, "Embeddings")
			}
		}
		out[i] = m
	}
	return out
}

func hasTag(tags []string, tag string) bool {
	for _, t := range tags {
		if strings.EqualFold(t, tag) {
			return true
		}
	}
	return false
}
