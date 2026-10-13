package forge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"
)

type TestCase struct {
	Name        string          `json:"name"`
	Args        map[string]any  `json:"args"`
	Expected    json.RawMessage `json:"expected,omitempty"`
	ExpectError bool            `json:"expect_error,omitempty"`
}
type Definition struct {
	ID          string     `json:"id"`
	Description string     `json:"description"`
	Source      string     `json:"source"`
	Tests       []TestCase `json:"tests"`
}
type Report struct {
	Name   string `json:"name"`
	Passed bool   `json:"passed"`
	Error  string `json:"error,omitempty"`
}
type Artifact struct {
	Definition
	SessionID string    `json:"session_id"`
	Hash      string    `json:"hash"`
	Status    string    `json:"status"`
	Enabled   bool      `json:"enabled"`
	Created   time.Time `json:"created"`
	Reports   []Report  `json:"reports"`
}
type Registry struct {
	mu    sync.Mutex
	path  string
	items map[string]Artifact
}

var idPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)

func cloneArtifact(a Artifact) Artifact {
	raw, _ := json.Marshal(a)
	var copy Artifact
	_ = json.Unmarshal(raw, &copy)
	return copy
}
func digest(session string, d Definition) string {
	b, _ := json.Marshal(struct {
		Session    string
		Definition Definition
	}{session, d})
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func Open(path string) (*Registry, error) {
	r := &Registry{path: path, items: map[string]Artifact{}}
	if path == "" {
		return r, nil
	}
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return r, nil
	}
	if err != nil {
		return nil, err
	}
	if len(raw) > 5<<20 {
		return nil, errors.New("现场插件存储超限")
	}
	if err = json.Unmarshal(raw, &r.items); err != nil {
		return nil, errors.New("现场插件存储无效")
	}
	if len(r.items) > 64 {
		return nil, errors.New("现场插件版本超过限制")
	}
	for hash, a := range r.items {
		if hash != a.Hash || hash != digest(a.SessionID, a.Definition) || !idPattern.MatchString(a.ID) || (a.Status != "passed" && a.Status != "failed") {
			return nil, errors.New("现场插件版本校验失败")
		}
	}
	return r, nil
}
func (r *Registry) save(items map[string]Artifact) error {
	if r.path == "" {
		r.items = items
		return nil
	}
	raw, err := json.MarshalIndent(items, "", "  ")
	if err != nil || len(raw) > 5<<20 {
		return errors.New("现场插件存储超限")
	}
	if err = os.MkdirAll(filepath.Dir(r.path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(r.path), ".forge-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(raw)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(f.Name(), r.path)
	}
	if err == nil {
		r.items = items
	}
	return err
}
func (r *Registry) copy() map[string]Artifact {
	out := map[string]Artifact{}
	for k, v := range r.items {
		out[k] = v
	}
	return out
}
func fixtureMarket() map[string]any {
	return map[string]any{"venue": "binance", "symbol": "BTCUSDT", "bid": "99999.9", "ask": "100000.1", "mid": "100000", "tick": "0.1"}
}
func (r *Registry) Develop(ctx context.Context, session string, d Definition) (Artifact, error) {
	if session == "" || len(session) > 80 || !idPattern.MatchString(d.ID) || len(d.Description) == 0 || len(d.Description) > 500 || len(d.Tests) < 2 || len(d.Tests) > 6 {
		return Artifact{}, errors.New("现场插件需要ID、说明、当前会话及2–6个测试")
	}
	if len(d.Source) > MaxSource {
		return Artifact{}, errors.New("插件代码超过16KiB")
	}
	raw, marshalErr := json.Marshal(d)
	if marshalErr != nil {
		return Artifact{}, errors.New("插件包的测试JSON无效")
	}
	if len(raw) > 60000 {
		return Artifact{}, errors.New("插件包超过限制")
	}
	var detached Definition
	if err := json.Unmarshal(raw, &detached); err != nil {
		return Artifact{}, err
	}
	d = detached
	hash := digest(session, d)
	r.mu.Lock()
	if a, ok := r.items[hash]; ok {
		r.mu.Unlock()
		return cloneArtifact(a), nil
	}
	full := len(r.items) >= 64
	r.mu.Unlock()
	if full {
		return Artifact{}, errors.New("现场插件最多保存64个版本")
	}
	a := Artifact{Definition: d, SessionID: session, Hash: hash, Status: "failed", Created: time.Now().UTC(), Reports: []Report{}}
	if err := ValidateSource(d.Source); err != nil {
		a.Reports = append(a.Reports, Report{Name: "代码边界检查", Error: err.Error()})
	} else {
		successes := 0
		all := true
		for _, test := range d.Tests {
			report := Report{Name: test.Name}
			if test.Name == "" || len(test.Name) > 80 {
				report.Error = "测试名称无效"
			} else {
				out, err := Run(ctx, Invocation{Source: d.Source, Market: fixtureMarket(), Args: test.Args})
				if test.ExpectError {
					report.Passed = err != nil
					if err == nil {
						report.Error = "预期拒绝，但运行成功"
					}
				} else if err != nil {
					report.Error = err.Error()
				} else {
					expected, err := decodeOutput(test.Expected)
					if err != nil {
						report.Error = "预期输出必须是合法草案JSON"
					} else {
						actual, _ := json.Marshal(out)
						want, _ := json.Marshal(expected)
						report.Passed = string(actual) == string(want)
						if !report.Passed {
							report.Error = "实际输出与预期不一致: " + string(actual)
						} else {
							successes++
						}
					}
				}
			}
			if !report.Passed {
				all = false
			}
			a.Reports = append(a.Reports, report)
			if ctx.Err() != nil {
				return a, ctx.Err()
			}
		}
		if all && successes > 0 {
			a.Status = "passed"
			a.Enabled = true
		} else if successes == 0 {
			a.Reports = append(a.Reports, Report{Name: "至少一个成功输出测试", Error: "不能只测试错误路径"})
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.items) >= 64 {
		return a, errors.New("现场插件版本超过限制")
	}
	items := r.copy()
	items[hash] = a
	if err := r.save(items); err != nil {
		return a, err
	}
	return cloneArtifact(a), nil
}
func (r *Registry) List(session string) []Artifact {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []Artifact{}
	for _, a := range r.items {
		if a.SessionID == session {
			out = append(out, a)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created.After(out[j].Created) })
	raw, _ := json.Marshal(out)
	var copies []Artifact
	_ = json.Unmarshal(raw, &copies)
	return copies
}
func (r *Registry) Get(session, hash string) (Artifact, error) {
	for _, a := range r.List(session) {
		if a.Hash == hash {
			return a, nil
		}
	}
	return Artifact{}, errors.New("当前会话没有此插件版本")
}
func (r *Registry) SetEnabled(session, hash string, enabled bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	a, ok := r.items[hash]
	if !ok || a.SessionID != session {
		return errors.New("当前会话没有此插件版本")
	}
	if enabled && a.Status != "passed" {
		return errors.New("测试未通过的插件不能装载")
	}
	a.Enabled = enabled
	items := r.copy()
	items[hash] = a
	return r.save(items)
}
func (r *Registry) Run(ctx context.Context, session, hash string, market, args map[string]any) (Output, error) {
	a, err := r.Get(session, hash)
	if err != nil {
		return Output{}, err
	}
	if a.Status != "passed" || !a.Enabled {
		return Output{}, errors.New("插件尚未通过测试或已停用")
	}
	out, err := Run(ctx, Invocation{Source: a.Source, Market: market, Args: args})
	if err != nil {
		return out, fmt.Errorf("插件 %s: %w", a.ID, err)
	}
	return out, nil
}
