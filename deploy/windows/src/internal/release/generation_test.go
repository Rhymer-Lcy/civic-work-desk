package release

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// generationRelease writes the two files DataGeneration reads. health == "" means no health file.
func generationRelease(t *testing.T, health, version string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "app"), 0o755); err != nil {
		t.Fatal(err)
	}
	if health != "" {
		if err := os.WriteFile(filepath.Join(dir, "app", HealthName), []byte(health), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, VersionName), []byte(version), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

const rc3Health = `{"application":"civic-work-desk","releaseChannel":"windows-x64","releaseId":"2026.09.24-win-rc3","appVersion":"0.1.0"}`

func TestLegacyReleaseIsSchemaOne(t *testing.T) {
	dir := generationRelease(t, rc3Health, "CivicWorkDesk\nreleaseId=2026.09.24-win-rc3\n")
	g, err := DataGeneration(dir)
	if err != nil {
		t.Fatal(err)
	}
	if g.Schema != 1 {
		t.Fatalf("an RC3-shaped release reads as %s, want schema 1", g)
	}
}

func TestRecordedSchemaIsRead(t *testing.T) {
	dir := generationRelease(t,
		`{"application":"civic-work-desk","databaseSchemaVersion":2}`,
		"CivicWorkDesk\ndatabaseSchemaVersion=2\n")
	g, err := DataGeneration(dir)
	if err != nil {
		t.Fatal(err)
	}
	if g.Schema != 2 || g.Source != HealthName {
		t.Fatalf("got %s", g)
	}
}

// Every malformed shape is an error, never a default. The caller is deciding whether to run an
// application against a person's records.
func TestMalformedGenerationIsRefused(t *testing.T) {
	cases := map[string][2]string{
		"no health file":      {"", "x\n"},
		"not JSON":            {"{", "x\n"},
		"another application": {`{"application":"something-else","databaseSchemaVersion":2}`, "x\n"},
		"schema as a string":  {`{"application":"civic-work-desk","databaseSchemaVersion":"2"}`, "x\n"},
		"schema as a float":   {`{"application":"civic-work-desk","databaseSchemaVersion":2.0}`, "x\n"},
		"schema zero":         {`{"application":"civic-work-desk","databaseSchemaVersion":0}`, "x\n"},
		"schema negative":     {`{"application":"civic-work-desk","databaseSchemaVersion":-1}`, "x\n"},
		"health and VERSION disagree": {
			`{"application":"civic-work-desk","databaseSchemaVersion":2}`, "x\ndatabaseSchemaVersion=3\n"},
		"only VERSION carries it": {rc3Health, "x\ndatabaseSchemaVersion=2\n"},
		"VERSION value malformed": {
			`{"application":"civic-work-desk","databaseSchemaVersion":2}`, "x\ndatabaseSchemaVersion=two\n"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if g, err := DataGeneration(generationRelease(t, c[0], c[1])); err == nil {
				t.Fatalf("accepted as %s", g)
			}
		})
	}
}

func TestTransitionRefusesOnlyAnOlderSchema(t *testing.T) {
	one := Generation{Schema: 1, Source: "legacy"}
	two := Generation{Schema: 2, Source: HealthName}
	if err := CheckTransition(one, two); err != nil {
		t.Errorf("upgrade 1 -> 2 refused: %v", err)
	}
	if err := CheckTransition(two, two); err != nil {
		t.Errorf("repair 2 -> 2 refused: %v", err)
	}
	err := CheckTransition(two, one)
	if !errors.Is(err, ErrOlderDataGeneration) {
		t.Fatalf("downgrade 2 -> 1 was not refused with ErrOlderDataGeneration: %v", err)
	}
	if !strings.Contains(err.Error(), "schema 2") || !strings.Contains(err.Error(), "schema 1") {
		t.Errorf("the refusal does not name both schemas: %v", err)
	}
}
