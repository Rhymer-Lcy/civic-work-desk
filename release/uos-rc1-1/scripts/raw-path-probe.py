#!/usr/bin/env python3
"""Send an HTTP request with the path EXACTLY as written, and report what came back.

An acceptance tool, not a server. It exists because the traversal probe has to reach the server
unnormalised, and most clients will not let it: curl rewrites `/../` out of the path unless told
`--path-as-is`, and a target without curl has no obvious way to send a raw request line at all.
This writes the request line byte for byte on a socket, so `GET /../SHA256SUMS.txt HTTP/1.1` really
is what the server receives.

Standard library only; written for the Python 3.7.3 on the target. Using it here says nothing about
which server is selected for production.

    python3 raw-path-probe.py --host 127.0.0.1 --port 8765 --raw-path /../SHA256SUMS.txt
    python3 raw-path-probe.py --host 127.0.0.1 --port 8765 --raw-path / --headers-only

Prints the request line, the status line and the response headers. The body is written to
--body-out when given, so the caller can assert on it and then delete it; it is never printed.
"""

import argparse
import socket
import sys

TIMEOUT = 10
MAX_BODY = 64 * 1024


def build_parser():
    parser = argparse.ArgumentParser(description="raw-path HTTP probe (acceptance tool)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--raw-path", required=True, help="sent verbatim, never normalised")
    parser.add_argument("--headers-only", action="store_true")
    parser.add_argument("--body-out", default=None, help="write the body here (not printed)")
    return parser


def main(argv):
    args = build_parser().parse_args(argv)

    if args.host not in ("127.0.0.1", "::1"):
        sys.stderr.write("错误：本探测只允许回环地址。\n")
        return 2

    request = (
        "GET %s HTTP/1.1\r\n"
        "Host: %s:%d\r\n"
        "User-Agent: CivicWorkDesk-RC-probe/1\r\n"
        "Accept: */*\r\n"
        "Connection: close\r\n"
        "\r\n" % (args.raw_path, args.host, args.port)
    )

    print("REQUEST-LINE: GET %s HTTP/1.1" % args.raw_path)

    try:
        connection = socket.create_connection((args.host, args.port), TIMEOUT)
    except OSError as error:
        print("CONNECT-FAILED: %s" % error)
        return 3

    raw = b""
    try:
        connection.sendall(request.encode("ascii", "strict"))
        while len(raw) < MAX_BODY:
            chunk = connection.recv(8192)
            if not chunk:
                break
            raw += chunk
    except OSError as error:
        print("READ-FAILED: %s" % error)
        return 3
    finally:
        connection.close()

    separator = raw.find(b"\r\n\r\n")
    if separator < 0:
        head, body = raw, b""
    else:
        head, body = raw[:separator], raw[separator + 4 :]

    for line in head.decode("iso-8859-1").split("\r\n"):
        if line:
            print(line)

    if args.body_out and not args.headers_only:
        try:
            with open(args.body_out, "wb") as handle:
                handle.write(body)
        except OSError as error:
            print("BODY-WRITE-FAILED: %s" % error)
    print("BODY-BYTES: %d" % len(body))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
