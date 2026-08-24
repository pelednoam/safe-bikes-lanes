#!/usr/bin/env python3
"""A threaded static server for the test suites.

`python3 -m http.server` is single-threaded: it serves one request at a time, so
one slow response blocks every other. That is fine until the thing being served
is half a gigabyte of map tiles and two browsers are asking for hundreds of them
at once — then requests queue behind each other, the map takes longer than its
45-second budget to load, and the server starts logging BrokenPipeError as
browsers give up waiting.

That is what happened to the deploy gate on 2026-08-24: three tests failed on a
commit that had passed eleven days earlier, with no code change between them. Only
the data had grown. A resource failure that reads exactly like a regression, which
is the most expensive kind to diagnose.

Usage: python3 scripts/testserver.py PORT [DIRECTORY]
"""

from __future__ import annotations

import functools
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8321
    directory = sys.argv[2] if len(sys.argv) > 2 else "."
    handler = functools.partial(SimpleHTTPRequestHandler, directory=directory)
    # daemon_threads: a browser that vanishes mid-download should not keep the
    # server alive at the end of a run
    ThreadingHTTPServer.daemon_threads = True
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"serving {directory} on 127.0.0.1:{port} (threaded)", flush=True)
        httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
