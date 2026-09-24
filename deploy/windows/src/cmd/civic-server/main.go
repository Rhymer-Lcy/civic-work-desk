// Command civic-server serves the CivicWorkDesk PWA payload at the canonical origin.
//
//	civic-server.exe --root <install-root> --release <release-id>
//
// It binds 127.0.0.1:8765 and nothing else. If that address is taken it exits 3 without touching the
// occupant: a program that decided for itself which process deserved the port would eventually take a
// port from something a user cared about, and there is no version of that trade worth making for a
// static file server.
//
// Exit codes are stable because the launcher and the installer branch on them:
//
//	0  clean shutdown
//	2  usage error
//	3  the canonical port is occupied
//	4  the release or its payload is not usable
//	5  an internal failure
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"civicworkdesk/windows/internal/httpserve"
	"civicworkdesk/windows/internal/layout"
	"civicworkdesk/windows/internal/serverstate"
	"civicworkdesk/windows/internal/winproc"
)

// The canonical origin is a compatibility invariant, not a setting. Browser storage is bound to
// scheme+host+port, so a different port is a different application with none of the user's records in
// it. There is deliberately no flag to change these.
const (
	canonicalHost   = "127.0.0.1"
	canonicalPort   = 8765
	canonicalOrigin = "http://127.0.0.1:8765"
	serverVersion   = "civic-server/1.0 (windows-rc1)"
)

const (
	exitOK       = 0
	exitUsage    = 2
	exitPortBusy = 3
	exitRelease  = 4
	exitInternal = 5
)

func main() {
	os.Exit(run())
}

func run() int {
	root := flag.String("root", "", "installation root (default: %LOCALAPPDATA%\\CivicWorkDesk)")
	releaseID := flag.String("release", "", "release id to serve (default: the id in current.txt)")
	foreground := flag.Bool("foreground", false, "log to stderr as well as to the log file")
	flag.Parse()

	tree, err := resolveTree(*root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return exitUsage
	}

	id := *releaseID
	if id == "" {
		id, err = tree.ActiveRelease()
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: no release to serve: %v\n", err)
			return exitRelease
		}
	}
	appDir, err := tree.AppDir(id)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return exitUsage
	}
	if info, err := os.Stat(filepath.Join(appDir, "index.html")); err != nil || info.IsDir() {
		fmt.Fprintf(os.Stderr, "error: %s does not contain index.html; the release is not usable\n", appDir)
		return exitRelease
	}

	logger, closeLog, err := openLog(tree.Logs(), *foreground)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return exitInternal
	}
	defer closeLog()

	// Bind BEFORE recording anything. A state file written first would describe a server that never
	// started, and the next launcher would try to prove the identity of a process that does not exist.
	addr := fmt.Sprintf("%s:%d", canonicalHost, canonicalPort)
	listener, err := net.Listen("tcp4", addr)
	if err != nil {
		if isAddrInUse(err) {
			logger(fmt.Sprintf("fatal: %s is already in use; refusing to start", addr))
			fmt.Fprintf(os.Stderr,
				"error: %s is already in use.\n"+
					"       CivicWorkDesk will not take the port from another program, and will not\n"+
					"       use a different one: the application's saved data belongs to this exact\n"+
					"       address, so a different port would be a different, empty application.\n", addr)
			return exitPortBusy
		}
		logger(fmt.Sprintf("fatal: cannot bind %s: %v", addr, err))
		fmt.Fprintf(os.Stderr, "error: cannot bind %s: %v\n", addr, err)
		return exitInternal
	}

	identity, err := winproc.Current(tree.Root, id, canonicalOrigin)
	if err != nil {
		_ = listener.Close()
		fmt.Fprintf(os.Stderr, "error: cannot determine this process's own identity: %v\n", err)
		return exitInternal
	}
	token, err := serverstate.NewToken()
	if err != nil {
		_ = listener.Close()
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return exitInternal
	}

	startedAt := time.Now().Format(time.RFC3339)
	health := httpserve.Health{
		Application:     "civic-work-desk",
		Component:       "civic-server",
		ReleaseID:       id,
		InstallRoot:     tree.Root,
		AppDir:          appDir,
		CanonicalOrigin: canonicalOrigin,
		PID:             identity.PID,
		ExePath:         identity.ExePath,
		StartedAt:       startedAt,
		ServerVersion:   serverVersion,
	}

	shutdown := make(chan struct{})
	var shutdownOnce bool
	requestShutdown := func() {
		if !shutdownOnce {
			shutdownOnce = true
			close(shutdown)
		}
	}

	srv := &http.Server{
		Handler: httpserve.Handler(httpserve.Config{
			AppDir:        appDir,
			Health:        health,
			Log:           logger,
			ShutdownToken: token,
			Shutdown:      requestShutdown,
		}),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	if err := serverstate.Write(tree.State(), serverstate.State{
		Identity:      identity,
		ShutdownToken: token,
		StartedAt:     startedAt,
		LogFile:       logPath(tree.Logs()),
	}); err != nil {
		_ = listener.Close()
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return exitInternal
	}

	logger(fmt.Sprintf("started release=%s pid=%d origin=%s root=%s", id, identity.PID, canonicalOrigin, appDir))
	if *foreground {
		fmt.Printf("CivicWorkDesk server listening on %s (release %s, pid %d)\n",
			canonicalOrigin, id, identity.PID)
	}

	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(listener) }()

	// Ctrl+C and the graceful-shutdown endpoint end up in the same place, so there is one shutdown
	// path rather than two that can diverge.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)

	exit := exitOK
	select {
	case err := <-serveErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger(fmt.Sprintf("fatal: serve failed: %v", err))
			exit = exitInternal
		}
	case sig := <-signals:
		logger(fmt.Sprintf("stopping on signal %v", sig))
	case <-shutdown:
		logger("stopping on an authenticated shutdown request")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		logger(fmt.Sprintf("warning: graceful shutdown did not complete: %v", err))
		_ = srv.Close()
	}
	// Remove the state file last. While it exists it means "a server of this installation is running",
	// and that has to stop being true only once it is no longer serving.
	if err := serverstate.Clear(tree.State()); err != nil {
		logger(fmt.Sprintf("warning: %v", err))
	}
	logger("stopped")
	return exit
}

func resolveTree(root string) (layout.Tree, error) {
	if root != "" {
		abs, err := filepath.Abs(root)
		if err != nil {
			return layout.Tree{}, fmt.Errorf("cannot resolve --root %q: %w", root, err)
		}
		return layout.At(abs), nil
	}
	return layout.Default()
}

// isAddrInUse recognises the one bind failure that has its own exit code and its own message.
func isAddrInUse(err error) bool {
	if errors.Is(err, syscall.EADDRINUSE) {
		return true
	}
	// WSAEADDRINUSE (10048) is what Windows actually reports, and it is a different value from the
	// POSIX EADDRINUSE that errors.Is above matches. Checking only the portable constant would send
	// every port conflict on Windows down the generic "internal failure" path -- the opposite of the
	// loud, specific failure this case is supposed to produce.
	const wsaeaddrinuse = syscall.Errno(10048)
	// WSAEACCES (10013) appears instead when an exclusive-use socket or a reserved port range owns the
	// address; for a user it is the same situation and deserves the same message.
	const wsaeacces = syscall.Errno(10013)
	return errors.Is(err, wsaeaddrinuse) || errors.Is(err, wsaeacces)
}
