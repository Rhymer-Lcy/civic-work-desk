// Package serverstate records which server process this installation started, and asks it whether it
// is healthy.
//
// The state file is the Windows counterpart of the UOS run directory: it holds the identity token the
// stop path re-proves before terminating anything, plus the token that authorises a graceful shutdown.
// It is written after the listener is already bound, so a state file never describes a server that
// failed to start.
package serverstate

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"civicworkdesk/windows/internal/httpserve"
	"civicworkdesk/windows/internal/winproc"
)

// FileName is the state file inside the installation's state directory.
const FileName = "server.json"

// ErrNoState reports that no server has recorded itself.
var ErrNoState = errors.New("no recorded server")

// State is what gets written. The shutdown token is a capability, so the file is created with an
// owner-only mode; on Windows the per-user profile is the real boundary, and %LOCALAPPDATA% is not
// readable by other unprivileged users.
type State struct {
	Identity      winproc.Identity `json:"identity"`
	ShutdownToken string           `json:"shutdownToken"`
	StartedAt     string           `json:"startedAt"`
	LogFile       string           `json:"logFile"`
}

// NewToken returns a fresh shutdown capability.
func NewToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("cannot generate a shutdown token: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

// TokenEquals compares tokens without leaking their contents through timing. The threat is remote, but
// a constant-time compare costs nothing and removes the need to argue about it.
func TokenEquals(a, b string) bool {
	return len(a) == len(b) && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// Path returns the state file path for a state directory.
func Path(stateDir string) string { return filepath.Join(stateDir, FileName) }

// Write replaces the state file atomically.
func Write(stateDir string, s State) error {
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		return fmt.Errorf("cannot create %s: %w", stateDir, err)
	}
	body, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("cannot encode the server state: %w", err)
	}
	body = append(body, '\n')
	final := Path(stateDir)
	tmp := final + ".new"
	if err := os.WriteFile(tmp, body, 0o600); err != nil {
		return fmt.Errorf("cannot write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, final); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("cannot move the server state into place: %w", err)
	}
	return nil
}

// Read loads the state file.
func Read(stateDir string) (State, error) {
	raw, err := os.ReadFile(Path(stateDir))
	if errors.Is(err, os.ErrNotExist) {
		return State{}, ErrNoState
	}
	if err != nil {
		return State{}, fmt.Errorf("cannot read %s: %w", Path(stateDir), err)
	}
	var s State
	if err := json.Unmarshal(raw, &s); err != nil {
		// A corrupt state file must not be fatal: the recovery is to treat it as "no recorded server"
		// and let the caller inspect the port instead. Anything else would leave a user unable to start
		// the program because of a file they cannot be expected to repair.
		return State{}, fmt.Errorf("%w: %s is not valid JSON (%v)", ErrNoState, Path(stateDir), err)
	}
	return s, nil
}

// Clear removes the state file. Absence is success.
func Clear(stateDir string) error {
	err := os.Remove(Path(stateDir))
	if err == nil || errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return fmt.Errorf("cannot remove %s: %w", Path(stateDir), err)
}

// Probe is the outcome of asking whatever is at the canonical origin who it is.
type Probe struct {
	Reachable bool
	Health    httpserve.Health
	Err       error
}

// probeClient never reuses connections and never follows redirects. A health check that silently
// followed a redirect would be answering about a different endpoint than the one it asked.
var probeClient = &http.Client{
	Timeout: 3 * time.Second,
	Transport: &http.Transport{
		DisableKeepAlives: true,
		Proxy:             nil, // an HTTP_PROXY in the environment must never intercept a loopback probe
	},
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return errors.New("the health endpoint must answer directly, not redirect")
	},
}

// ProbeHealth asks the server at origin for /__civic/health.
func ProbeHealth(origin string) Probe {
	url := strings.TrimSuffix(origin, "/") + httpserve.ReservedPrefix + "health"
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return Probe{Err: err}
	}
	resp, err := probeClient.Do(req)
	if err != nil {
		return Probe{Err: err}
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return Probe{Reachable: true, Err: fmt.Errorf("health returned HTTP %d", resp.StatusCode)}
	}
	var h httpserve.Health
	if err := json.NewDecoder(resp.Body).Decode(&h); err != nil {
		// Something is listening and speaking HTTP, but it is not ours. That distinction is the whole
		// point of the health endpoint, and the caller must be able to act on it.
		return Probe{Reachable: true, Err: fmt.Errorf("the response is not a CivicWorkDesk health document: %w", err)}
	}
	return Probe{Reachable: true, Health: h}
}

// PortOccupant reports whether anything at all is listening on the canonical host and port.
//
// Used when the health probe fails, to tell "nothing is there" apart from "something else is there" --
// the two cases need completely different messages to a user, and conflating them is how a port
// conflict gets reported as a crash.
func PortOccupied(hostPort string) bool {
	conn, err := net.DialTimeout("tcp", hostPort, 1500*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// RequestShutdown asks a server to stop gracefully, using its own token.
func RequestShutdown(origin, token string) error {
	url := strings.TrimSuffix(origin, "/") + httpserve.ReservedPrefix + "shutdown"
	req, err := http.NewRequest(http.MethodPost, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-Civic-Token", token)
	resp, err := probeClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("the shutdown request returned HTTP %d", resp.StatusCode)
	}
	return nil
}

// WaitUntilHealthy polls the health endpoint until it answers with the expected release, or the
// deadline passes.
//
// It requires the release id AND the install root to match. A server from another installation, or
// from the release that was active before an upgrade, is a wrong answer that a bare "did it respond"
// check would accept -- which is how a launcher ends up opening a browser onto the previous version.
func WaitUntilHealthy(origin, installRoot, releaseID string, timeout time.Duration) (httpserve.Health, error) {
	deadline := time.Now().Add(timeout)
	var last error
	for attempt := 1; ; attempt++ {
		p := ProbeHealth(origin)
		if p.Err == nil {
			if p.Health.ReleaseID != releaseID {
				last = fmt.Errorf("the server at %s is serving release %q, not %q",
					origin, p.Health.ReleaseID, releaseID)
			} else if !strings.EqualFold(filepath.Clean(p.Health.InstallRoot), filepath.Clean(installRoot)) {
				last = fmt.Errorf("the server at %s belongs to installation %q, not %q",
					origin, p.Health.InstallRoot, installRoot)
			} else {
				return p.Health, nil
			}
		} else {
			last = p.Err
		}
		if time.Now().After(deadline) {
			return httpserve.Health{}, fmt.Errorf("the server did not become healthy within %s: %w", timeout, last)
		}
		time.Sleep(150 * time.Millisecond)
	}
}
