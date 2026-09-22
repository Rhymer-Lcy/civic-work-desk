#!/usr/bin/env python3
"""CivicWorkDesk — RC1 candidate B: a minimal static server on the Python standard library.

The fallback, not the preference. BusyBox is candidate A because it is already on the target and
needs no interpreter; this exists so that if BusyBox fails a concrete acceptance requirement — a
MIME type Chromium rejects, a cache behaviour that hides an update — there is a second mechanism
that can be shown to pass it, rather than a decision made on taste.

Deliberately small. Everything here is either required by an acceptance criterion or by the
security boundary:

  * binds 127.0.0.1 only, never 0.0.0.0, so the application is never on the LAN;
  * serves one fixed document root, with path traversal blocked;
  * declares the MIME types CivicWorkDesk needs rather than trusting the system table, which on a
    minimal Linux can map .js to something Chromium refuses to execute as a module;
  * sets deliberate cache headers: the entrypoint and the service worker revalidate, fingerprinted
    assets are immutable — so a new release is discoverable without asking anyone to clear storage;
  * no directory listing;
  * no CGI, no symlink following outside the root, no upload, no write path of any kind;
  * fails loudly and specifically when the fixed port is taken, and never falls back to another
    port, because a different port is a different IndexedDB namespace.

Target interpreter is Python 3.7.3, so: no walrus, no f-string `=`, no `functools.cached_property`,
and `ThreadingHTTPServer` rather than anything newer. Standard library only.

Usage:
    python3 server.py --root /path/to/app [--port 8765] [--host 127.0.0.1]
"""

import argparse
import errno
import os
import posixpath
import socket
import sys
import urllib.parse
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

CANONICAL_HOST = "127.0.0.1"
CANONICAL_PORT = 8765

# The extensions CivicWorkDesk actually serves. Declared rather than inherited: mimetypes reads
# /etc/mime.types when present, and what that file says about .js varies between distributions.
MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}

# Files that must be revalidated on every load, or a release would be invisible until the browser
# felt like checking. Everything else under /assets/ carries a content hash in its name and can be
# cached hard.
NO_CACHE_NAMES = ("index.html", "sw.js", "registerSW.js", "manifest.webmanifest",
                  "deployment-health.json")


class CivicHandler(SimpleHTTPRequestHandler):
    """Static handler with explicit MIME, explicit caching and no directory listing."""

    server_version = "CivicWorkDeskStatic/1"
    sys_version = ""  # do not advertise the Python version to the browser

    def guess_type(self, path):
        """Return our declared type, falling back to octet-stream rather than to a guess.

        SimpleHTTPRequestHandler would consult `mimetypes`, which is exactly the source of
        uncertainty this server exists to remove.
        """
        _, extension = posixpath.splitext(path)
        return MIME_TYPES.get(extension.lower(), "application/octet-stream")

    def list_directory(self, path):
        """Never list a directory."""
        self.send_error(HTTPStatus.NOT_FOUND, "Not Found")
        return None

    def translate_path(self, path):
        """Resolve inside the document root, or nowhere.

        The base implementation is already careful, but it is careful about a *current working
        directory* model. Here the root is explicit and the result is checked with `realpath`, so a
        symlink inside the bundle cannot become a way out of it either.
        """
        path = urllib.parse.urlsplit(path).path
        path = urllib.parse.unquote(path, errors="surrogatepass")
        path = posixpath.normpath(path)
        parts = [part for part in path.split("/") if part and part not in (os.curdir, os.pardir)]
        resolved = os.path.join(self.directory, *parts)

        root_real = os.path.realpath(self.directory)
        target_real = os.path.realpath(resolved)
        if target_real != root_real and not target_real.startswith(root_real + os.sep):
            # Outside the root: report as missing rather than explaining the boundary.
            return os.path.join(root_real, "__forbidden__")
        return resolved

    def end_headers(self):
        self.send_header("Cache-Control", self._cache_control())
        # Meaningful on loopback: they constrain what a page served from this origin may do, which
        # matters because the application stores everything the user owns under this origin.
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        SimpleHTTPRequestHandler.end_headers(self)

    def _cache_control(self):
        name = posixpath.basename(urllib.parse.urlsplit(self.path).path)
        if name == "" or name in NO_CACHE_NAMES:
            return "no-cache"
        if "/assets/" in self.path:
            return "public, max-age=31536000, immutable"
        return "no-cache"

    def send_head(self):
        """Serve index.html for the application root; everything else is a plain file lookup.

        There is deliberately **no SPA catch-all**: CivicWorkDesk routes with a hash (`#/work`), so
        the server never sees a client route, and a catch-all would turn a genuinely missing asset
        into a silent 200 of the HTML shell — which is how a broken deployment comes to look like a
        broken application.
        """
        return SimpleHTTPRequestHandler.send_head(self)

    def log_message(self, fmt, *args):
        """One line per request, to stderr, without the client address.

        The address is always 127.0.0.1 here, and leaving it out keeps the log free of anything
        that could be mistaken for personal data when it is returned as acceptance evidence.
        """
        sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))


def build_parser():
    parser = argparse.ArgumentParser(description="CivicWorkDesk static server (stdlib only)")
    parser.add_argument("--root", required=True, help="document root (the app directory)")
    parser.add_argument("--host", default=CANONICAL_HOST, help="bind address (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=CANONICAL_PORT, help="bind port (default 8765)")
    return parser


def main(argv):
    args = build_parser().parse_args(argv)

    root = os.path.realpath(args.root)
    if not os.path.isdir(root):
        sys.stderr.write("错误：文档根目录不存在：%s\n" % root)
        return 2
    if not os.path.isfile(os.path.join(root, "index.html")):
        sys.stderr.write("错误：文档根目录中缺少 index.html：%s\n" % root)
        return 2

    if args.host not in ("127.0.0.1", "::1"):
        # Refuse rather than warn. An accidental 0.0.0.0 would put every record on the LAN.
        sys.stderr.write("错误：仅允许绑定回环地址，收到：%s\n" % args.host)
        return 2

    def handler(*handler_args, **handler_kwargs):
        return CivicHandler(*handler_args, directory=root, **handler_kwargs)

    # `allow_reuse_address` is deliberately NOT set.
    #
    # Its usual justification is avoiding a TIME_WAIT delay when restarting quickly. The cost here is
    # much larger than that benefit: with SO_REUSEADDR a second instance can bind a port that is
    # already serving — observed on the development machine, where a deliberate second launch bound
    # 8765 instead of failing — and the whole point of the fixed-port contract is that an occupied
    # port must stop the launch rather than produce a second, competing origin. If a TIME_WAIT delay
    # ever proves to be a real problem on the target, that is a measured decision to revisit, not a
    # default to carry.
    ThreadingHTTPServer.allow_reuse_address = False
    try:
        httpd = ThreadingHTTPServer((args.host, args.port), handler)
    except OSError as error:
        if error.errno == errno.EADDRINUSE:
            sys.stderr.write(
                "错误：端口 %d 已被占用，未启动服务。\n"
                "本程序不会改用其他端口：更换端口等于更换浏览器存储位置，"
                "会让已有数据看起来消失。\n"
                "请先确认占用者（ss -ltnp | grep %d）后再处理。\n" % (args.port, args.port)
            )
            return 3
        sys.stderr.write("错误：无法绑定 %s:%d —— %s\n" % (args.host, args.port, error))
        return 3

    bound_host, bound_port = httpd.socket.getsockname()[:2]
    sys.stderr.write(
        "CivicWorkDesk 静态服务已启动\n"
        "  地址：http://%s:%d/\n"
        "  文档根目录：%s\n"
        "  仅监听回环地址，不对局域网开放。\n"
        "  按 Ctrl-C 停止。\n" % (bound_host, bound_port, root)
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("\n已停止。\n")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except socket.error as error:  # pragma: no cover - defensive
        sys.stderr.write("错误：%s\n" % error)
        sys.exit(3)
