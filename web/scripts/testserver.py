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

Usage: python3 scripts/testserver.py PORT [DIRECTORY] [--data DATA_DIR]

--data serves /data/ from DATA_DIR instead of DIRECTORY/data: the browser
suites run on the pinned test snapshot (test-data.json, scripts/test-data.sh)
while the app itself comes from the working tree.
"""

from __future__ import annotations

import argparse
import functools
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


class Handler(SimpleHTTPRequestHandler):
    """Static files from `directory`, except /data/ from `data_dir` if given."""

    def __init__(self, *args: Any, data_dir: str | None = None, **kwargs: Any) -> None:
        self.data_dir = data_dir
        super().__init__(*args, **kwargs)

    def translate_path(self, path: str) -> str:
        local = super().translate_path(path)
        if self.data_dir is None:
            return local
        data_root = os.path.join(self.directory, "data")
        if local == data_root or local.startswith(data_root + os.sep):
            return os.path.join(os.path.abspath(self.data_dir), os.path.relpath(local, data_root))
        return local


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("port", type=int, nargs="?", default=8321)
    ap.add_argument("directory", nargs="?", default=".")
    ap.add_argument("--data", dest="data_dir", default=None)
    args = ap.parse_args()
    port, directory = args.port, args.directory
    if args.data_dir is not None and not os.path.isfile(os.path.join(args.data_dir, "meta.json")):
        # fail loudly rather than serve a map with no data behind it
        raise SystemExit(f"--data {args.data_dir}: no meta.json there (run npm run test-data)")
    handler = functools.partial(Handler, directory=directory, data_dir=args.data_dir)
    # daemon_threads: a browser that vanishes mid-download should not keep the
    # server alive at the end of a run
    ThreadingHTTPServer.daemon_threads = True
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        data = f", /data/ from {args.data_dir}" if args.data_dir else ""
        print(f"serving {directory}{data} on 127.0.0.1:{port} (threaded)", flush=True)
        httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
