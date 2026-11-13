package api

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"sync"
)

// maxUITokens bounds the ui tokens alive at once; issuing one more drops the oldest.
const maxUITokens = 8

// tokens holds every token valid for this core run, in memory only: the shell token from the environment, and the
// ui tokens main asked for, oldest first.
type tokens struct {
	mu    sync.Mutex
	shell string
	ui    []string
}

func newTokens(shell string) *tokens {
	return &tokens{shell: shell}
}

// issue returns a new token with the given scope. Only ui tokens are issued; the shell token comes from main.
func (t *tokens) issue(scope Scope) (string, error) {
	if scope != UI {
		return "", errors.New("only a ui token can be issued")
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	tok := hex.EncodeToString(b)
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.ui) == maxUITokens {
		t.ui = append(t.ui[:0], t.ui[1:]...)
	}
	t.ui = append(t.ui, tok)
	return tok, nil
}

// scopeOf reports the scope of a live token. Every token is compared in constant time and none is skipped, so the
// answer's timing says nothing about which token, or how much of one, matched.
func (t *tokens) scopeOf(token string) (Scope, bool) {
	if token == "" {
		return None, false
	}
	got := []byte(token)
	t.mu.Lock()
	defer t.mu.Unlock()
	scope := None
	if t.shell != "" && subtle.ConstantTimeCompare(got, []byte(t.shell)) == 1 {
		scope = Shell
	}
	for _, u := range t.ui {
		if subtle.ConstantTimeCompare(got, []byte(u)) == 1 {
			scope = UI
		}
	}
	return scope, scope != None
}
