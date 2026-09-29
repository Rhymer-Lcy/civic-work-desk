package release

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

// HealthName is the deployment-health file inside a release's app\ directory. It is part of the payload,
// so the manifest covers it, which VERSION is not.
const HealthName = "deployment-health.json"

// LegacyDataGeneration is the browser-database schema of every release built before releases recorded
// one. Windows RC1, RC2 and RC3 all shipped application 0.1.0, whose IndexedDB schema is 1.
const LegacyDataGeneration = 1

// ErrOlderDataGeneration reports a switch to a release whose application uses an older browser-database
// schema than the one being left.
//
// ## Why this is refused rather than warned about
//
// The records live in the browser, and the first run of a newer application migrates them in place. An
// older application does not know the newer fields: measured against Windows RC3 on a schema-2 profile,
// editing a sub-task silently dropped its parent link, and deleting a parent from RC3's recycle bin left
// its children pointing at nothing. Nothing on disk can undo that, and there is no safe database
// downgrade, so the only safe answer is not to start the older application against newer data.
var ErrOlderDataGeneration = errors.New("the destination release uses an older browser-database schema")

// Generation is a release's browser-database schema and where that number came from.
type Generation struct {
	Schema int
	Source string
}

func (g Generation) String() string { return fmt.Sprintf("schema %d (%s)", g.Schema, g.Source) }

// DataGeneration reads which browser-database schema a release's application uses.
//
// The number is read from app\deployment-health.json, and cross-checked against VERSION when VERSION
// carries it too. A release that predates the field is schema 1 by definition. Anything malformed is an
// error, never a guess: the caller is deciding whether it is safe to run an application against a
// user's records, and "probably fine" is not an answer to that.
func DataGeneration(releaseDir string) (Generation, error) {
	path := filepath.Join(releaseDir, "app", HealthName)
	raw, err := os.ReadFile(path)
	if err != nil {
		return Generation{}, fmt.Errorf("cannot read %s: %w", path, err)
	}
	var health map[string]json.RawMessage
	if err := json.Unmarshal(raw, &health); err != nil {
		return Generation{}, fmt.Errorf("%s is not a JSON object: %w", path, err)
	}
	var application string
	if err := json.Unmarshal(health["application"], &application); err != nil || application != "civic-work-desk" {
		return Generation{}, fmt.Errorf("%s does not describe the civic-work-desk application", path)
	}

	fromVersion, versionHasIt, err := versionSchema(releaseDir)
	if err != nil {
		return Generation{}, err
	}

	field, present := health["databaseSchemaVersion"]
	if !present {
		if versionHasIt {
			return Generation{}, fmt.Errorf("VERSION says databaseSchemaVersion=%d but %s does not carry it",
				fromVersion, HealthName)
		}
		return Generation{Schema: LegacyDataGeneration,
			Source: "not recorded; every release before the field existed used schema 1"}, nil
	}
	schema, err := positiveInteger(field)
	if err != nil {
		return Generation{}, fmt.Errorf("%s: databaseSchemaVersion %s", path, err)
	}
	if versionHasIt && fromVersion != schema {
		return Generation{}, fmt.Errorf("%s says databaseSchemaVersion %d but VERSION says %d",
			HealthName, schema, fromVersion)
	}
	return Generation{Schema: schema, Source: HealthName}, nil
}

// positiveInteger accepts a JSON integer of at least 1 and nothing else: not 2.0, not "2", not 0.
func positiveInteger(field json.RawMessage) (int, error) {
	text := string(bytes.TrimSpace(field))
	n, err := strconv.Atoi(text)
	if err != nil || n < 1 || strconv.Itoa(n) != text {
		return 0, fmt.Errorf("is %s, not a positive integer", text)
	}
	return n, nil
}

func versionSchema(releaseDir string) (value int, present bool, err error) {
	v, err := ReadVersion(releaseDir)
	if err != nil {
		// VERSION is required by the release shape; its absence is reported there. Here it only matters
		// as a second opinion.
		return 0, false, nil
	}
	text, ok := v.Values["databaseSchemaVersion"]
	if !ok {
		return 0, false, nil
	}
	n, err := strconv.Atoi(text)
	if err != nil || n < 1 || strconv.Itoa(n) != text {
		return 0, true, fmt.Errorf("VERSION: databaseSchemaVersion is %q, not a positive integer", text)
	}
	return n, true, nil
}

// CheckTransition refuses moving from a release to one whose application uses an older schema.
// Equal and newer are allowed: a repair and an upgrade are both safe.
func CheckTransition(from, to Generation) error {
	if to.Schema < from.Schema {
		return fmt.Errorf("%w: leaving %s for %s", ErrOlderDataGeneration, from, to)
	}
	return nil
}
