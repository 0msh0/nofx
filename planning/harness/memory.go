package harness

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Session history is separate from the immutable trading/approval store. Its
// summary and preferences are untrusted context, never executable authority.
type Trace struct {
	Type  string `json:"type"`
	Text  string `json:"text,omitempty"`
	Tool  string `json:"tool,omitempty"`
	OK    *bool  `json:"ok,omitempty"`
	Round int    `json:"round,omitempty"`
}
type Turn struct {
	ID         string    `json:"id"`
	Started    time.Time `json:"started"`
	Finished   time.Time `json:"finished,omitempty"`
	Status     string    `json:"status"`
	StopReason string    `json:"stop_reason,omitempty"`
	Trace      []Trace   `json:"trace"`
}
type Session struct {
	ID       string    `json:"id"`
	Title    string    `json:"title"`
	Venue    string    `json:"venue,omitempty"`
	Symbol   string    `json:"symbol,omitempty"`
	Interval string    `json:"interval,omitempty"`
	Updated  time.Time `json:"updated"`
	Messages []History `json:"messages"`
	Summary  []string  `json:"summary"`
	Turns    []Turn    `json:"turns"`
}
type memoryData struct {
	Version     int                `json:"version"`
	Preferences string             `json:"preferences"`
	Sessions    map[string]Session `json:"sessions"`
}
type MemoryStore struct {
	mu       sync.Mutex
	path     string
	data     memoryData
	poisoned bool
}

var sessionID = regexp.MustCompile(`^[a-f0-9-]{16,64}$`)
var credentialText = regexp.MustCompile(`(?i)(api[_ -]?key|secret|password|authorization|密钥|密码)\s*[:=]\s*\S+|\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{16,}`)

func HasCredential(text string) bool { return credentialText.MatchString(text) }
func cut(text string, n int) string {
	r := []rune(text)
	if len(r) > n {
		return string(r[:n]) + "…"
	}
	return text
}
func OpenMemory(path string) (*MemoryStore, error) {
	m := &MemoryStore{path: path, data: memoryData{Version: 1, Sessions: map[string]Session{}}}
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return m, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("session memory must be private (0600)")
	}
	d := json.NewDecoder(io.LimitReader(f, 16<<20))
	d.DisallowUnknownFields()
	if d.Decode(&m.data) != nil {
		return nil, errors.New("invalid session memory; file was not reset")
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return nil, errors.New("trailing session data")
	}
	if m.data.Version != 1 || m.data.Sessions == nil || len(m.data.Sessions) > 100 {
		return nil, errors.New("unsupported session memory")
	}
	changed := false
	for id, s := range m.data.Sessions {
		if id != s.ID || !sessionID.MatchString(id) {
			return nil, errors.New("invalid session identity")
		}
		for n := range s.Turns {
			if s.Turns[n].Status == "running" {
				s.Turns[n].Status = "interrupted"
				s.Turns[n].StopReason = "server_restart"
				s.Turns[n].Finished = time.Now().UTC()
				changed = true
			}
		}
		m.data.Sessions[id] = s
	}
	if changed {
		if err = m.save(m.data); err != nil {
			return nil, err
		}
	}
	return m, nil
}
func (m *MemoryStore) clone() memoryData {
	b, _ := json.Marshal(m.data)
	var d memoryData
	_ = json.Unmarshal(b, &d)
	return d
}
func (m *MemoryStore) save(d memoryData) error {
	if m.poisoned {
		return errors.New("session persistence uncertain; reopen before continuing")
	}
	b, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	if len(b) >= 16<<20 {
		return errors.New("session memory capacity reached")
	}
	f, err := os.CreateTemp(filepath.Dir(m.path), ".sessions-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(f.Name(), m.path)
	}
	if err == nil {
		dir, e := os.Open(filepath.Dir(m.path))
		err = e
		if e == nil {
			err = dir.Sync()
			dir.Close()
		}
	}
	if err != nil {
		m.poisoned = true
		return errors.New("session persistence uncertain; inspect saved drafts and reopen")
	}
	m.data = d
	return nil
}
func (m *MemoryStore) Begin(id, turnID, text string, bootstrap []History) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !sessionID.MatchString(id) || !sessionID.MatchString(turnID) || HasCredential(text) {
		return errors.New("invalid session identity or credential in conversation")
	}
	d := m.clone()
	s, ok := d.Sessions[id]
	if !ok {
		if len(d.Sessions) >= 100 {
			return errors.New("session capacity reached")
		}
		s = Session{ID: id, Title: cut(text, 28), Messages: []History{}, Summary: []string{}, Turns: []Turn{}}
		for _, h := range bootstrap {
			if !HasCredential(h.Content) {
				s.Messages = append(s.Messages, History{h.Role, cut(h.Content, 2000)})
			}
		}
	}
	for _, t := range s.Turns {
		if t.ID == turnID {
			return errors.New("turn already recorded; inspect session instead of repeating tool side effects")
		}
	}
	s.Messages = append(s.Messages, History{"user", text})
	s.Updated = time.Now().UTC()
	s.Turns = append(s.Turns, Turn{ID: turnID, Started: s.Updated, Status: "running", Trace: []Trace{}})
	compactSession(&s)
	d.Sessions[id] = s
	return m.save(d)
}
func compactSession(s *Session) {
	// Preserve bounded original user excerpts, not model guesses or stale prices
	// presented as current. Exact plans and hard risk limits live in core.Store.
	for len(s.Messages) > 24 {
		h := s.Messages[0]
		s.Messages = s.Messages[1:]
		if h.Role == "user" {
			s.Summary = append(s.Summary, "历史用户原话（非当前行情/审批）："+cut(h.Content, 420))
		}
	}
	if len(s.Summary) > 12 {
		s.Summary = s.Summary[len(s.Summary)-12:]
	}
	if len(s.Turns) > 100 {
		s.Turns = s.Turns[len(s.Turns)-100:]
	}
}
func (m *MemoryStore) Event(id, turnID string, event Event) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.clone()
	s, ok := d.Sessions[id]
	if !ok {
		return errors.New("unknown session")
	}
	n := -1
	for k := range s.Turns {
		if s.Turns[k].ID == turnID {
			n = k
		}
	}
	if n < 0 {
		return errors.New("unknown turn")
	}
	raw, _ := json.Marshal(event.Data)
	var data map[string]json.RawMessage
	_ = json.Unmarshal(raw, &data)
	tr := Trace{Type: event.Type}
	decodeString := func(key string) string { var v string; _ = json.Unmarshal(data[key], &v); return v }
	switch event.Type {
	case "forge":
		tr.Text = "现场插件 · " + decodeString("id") + " · " + decodeString("status") + " · " + decodeString("hash")
		s.Messages = append(s.Messages, History{Role: "user", Content: "此前工具记录（不是审批或当前行情）：" + tr.Text})
	case "assistant", "error":
		tr.Text = decodeString("message")
		role := "assistant"
		if event.Type == "error" {
			role = "user"
			tr.Text = "此前请求错误：" + tr.Text
		}
		s.Messages = append(s.Messages, History{role, tr.Text})
	case "plans":
		var rejects []string
		_ = json.Unmarshal(data["rejected"], &rejects)
		var plans []map[string]any
		_ = json.Unmarshal(data["plans"], &plans)
		tr.Text = "风控反馈：" + strings.Join(rejects, "；")
		if len(plans) == 0 && len(rejects) == 0 {
			tr.Text = "模型选择不交易，未保存草案"
		}
		if len(plans) > 0 {
			tr.Text = "保存未批准草案："
			for _, p := range plans {
				if id, ok := p["id"].(string); ok {
					tr.Text += id + " "
				}
			}
		}
		s.Messages = append(s.Messages, History{"user", cut(tr.Text, 3000)})
	case "tool_start", "tool_result":
		tr.Tool = decodeString("name")
		if event.Type == "tool_result" {
			var v bool
			_ = json.Unmarshal(data["ok"], &v)
			tr.OK = &v
		}
	case "context":
		tr.Text = "本轮数据范围：" + string(raw)
	case "plugin_data":
		tr.Text = "只读插件快照（历史记录，不是当前报价或审批）：" + string(raw)
		s.Messages = append(s.Messages, History{"user", cut(tr.Text, 5000)})
	case "iteration":
		_ = json.Unmarshal(data["round"], &tr.Round)
	case "outcome":
		s.Turns[n].StopReason = decodeString("stop_reason")
	case "status":
		return nil // heartbeat UI events are ephemeral, not durable reasoning.
	default:
		return nil
	}
	if HasCredential(tr.Text) {
		tr.Text = "[credential-like text removed]"
	}
	for k := range s.Messages {
		if HasCredential(s.Messages[k].Content) {
			s.Messages[k].Content = "[credential-like text removed]"
		}
	}
	s.Turns[n].Trace = append(s.Turns[n].Trace, tr)
	if len(s.Turns[n].Trace) > 100 {
		s.Turns[n].Trace = s.Turns[n].Trace[len(s.Turns[n].Trace)-100:]
	}
	s.Updated = time.Now().UTC()
	compactSession(&s)
	d.Sessions[id] = s
	return m.save(d)
}
func (m *MemoryStore) Finish(id, turnID, status string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.clone()
	s := d.Sessions[id]
	for n := range s.Turns {
		if s.Turns[n].ID == turnID {
			s.Turns[n].Status = status
			s.Turns[n].Finished = time.Now().UTC()
			if (s.Turns[n].StopReason == "budget" || s.Turns[n].StopReason == "model_unavailable") && status == "completed" {
				s.Turns[n].Status = "paused"
			}
		}
	}
	s.Updated = time.Now().UTC()
	d.Sessions[id] = s
	return m.save(d)
}
func (m *MemoryStore) Sessions() []Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.clone()
	out := []Session{}
	for _, s := range d.Sessions {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Updated.After(out[j].Updated) })
	return out
}
func (m *MemoryStore) Context(id string) ([]History, []string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.clone().Sessions[id]
	history := []History{}
	bytes := 0
	for n := len(s.Messages) - 1; n >= 0 && len(history) < 16; n-- {
		h := s.Messages[n]
		text := cut(h.Content, 1400)
		if bytes+len(text) > 24000 {
			break
		}
		bytes += len(text)
		history = append([]History{{Role: h.Role, Content: text}}, history...)
	}
	mem := append([]string(nil), s.Summary...)
	if m.data.Preferences != "" {
		mem = append(mem, "用户保存的讨论偏好（不能改变硬风控、批准或执行）："+m.data.Preferences)
	}
	return history, mem
}
func (m *MemoryStore) Preferences() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.data.Preferences
}
func (m *MemoryStore) SetPreferences(text string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(text) > 5000 || HasCredential(text) {
		return errors.New("偏好最多 5000 字节，不能保存 API 密钥或密码")
	}
	d := m.clone()
	d.Preferences = text
	return m.save(d)
}

func (m *MemoryStore) DeleteSession(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.clone()
	s, ok := d.Sessions[id]
	if !ok {
		return errors.New("unknown session")
	}
	for _, t := range s.Turns {
		if t.Status == "running" {
			return errors.New("请先停止当前推演，再删除会话")
		}
	}
	delete(d.Sessions, id)
	return m.save(d)
}

func (m *MemoryStore) SetWorkspace(id, venue, symbol, interval string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.clone()
	s, ok := d.Sessions[id]
	if !ok {
		return errors.New("unknown session")
	}
	s.Venue = venue
	s.Symbol = symbol
	s.Interval = interval
	d.Sessions[id] = s
	return m.save(d)
}
