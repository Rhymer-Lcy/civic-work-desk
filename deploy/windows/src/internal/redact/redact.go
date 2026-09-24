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
// This is deliberately NOT a general anonymiser. It rewrites a fixed list of known prefixes, longest
// first, and leaves everything else exactly as it is. A custom installation directory such as
// `D:\Applications\CivicWorkDesk` stays verbatim, because it carries no identity and because losing it
// would make a custom-path installation impossible to diagnose — which is the failure mode this whole
// feature exists to support.
package redact

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

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
		out = replaceFold(out, r.value, "%"+r.name+"%")
		// Paths also travel with forward slashes (URLs, Go's own error strings, JSON), so the same
		// prefix is replaced in that form too. Without this, half the report is redacted and half is not.
		out = replaceFold(out, filepath.ToSlash(r.value), "%"+r.name+"%")
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
