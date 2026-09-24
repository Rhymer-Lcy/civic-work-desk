// Package redact rewrites user-identifying path prefixes into the environment variables they came from.
//
// ## What this is for, and what it is not
//
// Every diagnostic this deployment produces is meant to be forwarded by an ordinary colleague, to a
// maintainer, through whatever chat application they happen to use. The technical content — which
// release is active, whether the port is free, whether process ownership is provable — needs none of
// that person's identity to be useful, and RC1's report carried their Windows account name in every
// path plus the machine name as a field of its own.
//
// So paths are reported as `%LOCALAPPDATA%\CivicWorkDesk\...` rather than
// `C:\Users\<someone>\AppData\Local\CivicWorkDesk\...`. The information a maintainer actually reads is
// identical; the identity is gone.
//
// ## Why a custom installation path is masked too
//
// RC2 left a user-chosen installation directory verbatim, on the stated grounds that "it identifies
// nobody". That is false, and an external audit was right to call it out. A user is free to install to
//
//	D:\张三\政务工作记录台
//	D:\Users\Alice\CivicWorkDesk
//	D:\某单位\李某\CivicWorkDesk
//
// and a report that promises to carry no account name while printing any of those is making a promise
// it cannot keep. So a non-default root is reported as `D:\<CUSTOM_INSTALL_ROOT>` — the volume, which is
// the part that actually matters for diagnosis, without the directory names the user chose.
//
// What is lost is recovered by reporting the path's *characteristics* instead: whether it has spaces,
// whether it is non-ASCII, how long it is, whether it is writable. Those answer the questions a
// custom-path bug actually raises, and none of them name anybody. Exact disclosure remains possible as a
// deliberate support step; it is not part of the default forwardable report.
package redact

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"unicode"
)

// CustomRootPlaceholder is what a user-chosen installation directory is reported as.
const CustomRootPlaceholder = "<CUSTOM_INSTALL_ROOT>"

var (
	extraMu    sync.RWMutex
	extraRules []rule
)

// MaskInstallRoot registers a non-default installation root for redaction.
//
// Registering it here, rather than rewriting each field at the point of use, is what makes the guarantee
// hold: every line of a diagnostic report already passes through Paths, so the root cannot reach the
// file through a field somebody forgot to wrap — a log line, an error string, a health document, an
// executable path. That is the difference between "the fields I remembered are clean" and "the file is
// clean".
//
// A root that IS the default location is left to the ordinary %LOCALAPPDATA% substitution.
func MaskInstallRoot(root string) {
	if root == "" {
		return
	}
	clean := filepath.Clean(root)
	if local := os.Getenv("LOCALAPPDATA"); local != "" {
		if strings.EqualFold(clean, filepath.Join(filepath.Clean(local), "CivicWorkDesk")) {
			return
		}
	}
	volume := filepath.VolumeName(clean)
	replacement := volume + string(filepath.Separator) + CustomRootPlaceholder
	extraMu.Lock()
	defer extraMu.Unlock()
	extraRules = append(extraRules, rule{value: clean, name: "", replacement: replacement})
}

// ResetForTest drops registered custom roots. Tests only.
func ResetForTest() {
	extraMu.Lock()
	defer extraMu.Unlock()
	extraRules = nil
}

// RootKind classifies an installation root without naming it.
func RootKind(root string) string {
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		return "unknown (LOCALAPPDATA is not set)"
	}
	if strings.EqualFold(filepath.Clean(root), filepath.Join(filepath.Clean(local), "CivicWorkDesk")) {
		return "default (%LOCALAPPDATA%\\CivicWorkDesk)"
	}
	return "custom"
}

// Characteristics describes a path in the terms a custom-path problem is actually diagnosed in, with no
// directory name in any field.
type Characteristics struct {
	Volume      string
	HasSpaces   bool
	HasNonASCII bool
	Depth       int
	Length      int
}

// Describe measures a path without disclosing it.
func Describe(root string) Characteristics {
	clean := filepath.Clean(root)
	volume := filepath.VolumeName(clean)
	rest := strings.TrimPrefix(clean, volume)
	depth := 0
	for _, part := range strings.Split(rest, string(filepath.Separator)) {
		if part != "" {
			depth++
		}
	}
	nonASCII := false
	for _, r := range clean {
		if r > unicode.MaxASCII {
			nonASCII = true
			break
		}
	}
	return Characteristics{
		Volume:      volume,
		HasSpaces:   strings.Contains(rest, " "),
		HasNonASCII: nonASCII,
		Depth:       depth,
		Length:      len([]rune(clean)),
	}
}

// prefixes are the environment variables whose values identify a person, in the order they must be
// tried. Order is computed rather than written down: LOCALAPPDATA lives inside USERPROFILE, so
// replacing the shorter one first would leave `%USERPROFILE%\AppData\Local\...` and never produce
// `%LOCALAPPDATA%\...`.
var prefixes = []string{
	"LOCALAPPDATA",
	"APPDATA",
	"TEMP",
	"TMP",
	"USERPROFILE",
	"PUBLIC",
	"HOMEPATH",
}

type rule struct {
	value string
	name  string
	// replacement overrides the "%NAME%" form, for rules that are not environment variables.
	replacement string
}

func (r rule) to() string {
	if r.replacement != "" {
		return r.replacement
	}
	return "%" + r.name + "%"
}

// rules returns the active substitutions, longest value first.
func rules() []rule {
	var out []rule
	for _, name := range prefixes {
		value := os.Getenv(name)
		if value == "" {
			continue
		}
		clean := filepath.Clean(value)
		// A one- or two-character value would match almost anything; a value that is a bare drive root
		// would rewrite every path on the volume. Neither identifies a person, so neither is worth the
		// damage.
		if len(clean) < 4 || clean == filepath.VolumeName(clean)+string(filepath.Separator) {
			continue
		}
		out = append(out, rule{value: clean, name: name})
	}
	extraMu.RLock()
	out = append(out, extraRules...)
	extraMu.RUnlock()
	// Longest first, always: a registered custom root may sit inside %USERPROFILE%, and replacing the
	// shorter prefix first would leave the user-chosen directory names in the output.
	sort.SliceStable(out, func(i, j int) bool { return len(out[i].value) > len(out[j].value) })
	return out
}

// Paths rewrites every known user-identifying prefix in text.
//
// Matching is case-insensitive because Windows paths are, and it is done on the ORIGINAL text with
// positions found in a lower-cased copy, so the parts that are kept retain their real casing.
func Paths(text string) string {
	if text == "" {
		return text
	}
	out := text
	for _, r := range rules() {
		to := r.to()
		// Three spellings, because a path reaches a report in all three and redacting only the first
		// leaves the other two intact. The JSON form is not hypothetical: a health document or a state
		// file quoted into an error message carries doubled backslashes, and an adversarial test with a
		// custom root of `D:\某单位\李某\CivicWorkDesk` caught exactly that leak.
		for _, spelling := range []string{
			r.value,                                // D:\某单位\李某\CivicWorkDesk
			filepath.ToSlash(r.value),              // D:/某单位/李某/CivicWorkDesk
			strings.ReplaceAll(r.value, `\`, `\\`), // D:\\某单位\\李某\\CivicWorkDesk  (JSON)
		} {
			out = replaceFold(out, spelling, to)
		}
	}
	return out
}

// UserName reports whether the current account name still appears anywhere in text.
//
// Used by the tests, and by the diagnostics tool's own self-check: a redaction that is asserted only
// against the prefixes it knows about cannot notice a path that arrived by some other route.
func UserName() string { return os.Getenv("USERNAME") }

// ContainsUserName reports whether the account name appears in text as a whole word-ish run. A very
// short account name would produce constant false positives, so names under three characters are not
// searched for at all; that is stated rather than hidden, because it is a real limit of the check.
func ContainsUserName(text string) bool {
	name := UserName()
	if len(name) < 3 {
		return false
	}
	return strings.Contains(strings.ToLower(text), strings.ToLower(name))
}

func replaceFold(text, old, replacement string) string {
	if old == "" {
		return text
	}
	lowerText := strings.ToLower(text)
	lowerOld := strings.ToLower(old)
	var b strings.Builder
	for {
		i := strings.Index(lowerText, lowerOld)
		if i < 0 {
			b.WriteString(text)
			return b.String()
		}
		b.WriteString(text[:i])
		b.WriteString(replacement)
		text = text[i+len(old):]
		lowerText = lowerText[i+len(old):]
	}
}
