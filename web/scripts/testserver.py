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

Usage: python3 scripts/testserver.py PORT [DIRECTORY] [--data DATA_DIR] [--basemap FILE]

--data serves /data/ from DATA_DIR instead of DIRECTORY/data: the browser
suites run on the pinned test snapshot (test-data.json, scripts/test-data.sh)
while the app itself comes from the working tree. --basemap serves
/basemap.pmtiles from FILE, the pinned test copy of the basemap.

Byte ranges are served (a single range, 206), because the map reads its
basemap a tile at a time out of one file, and GitHub Pages serves them.
http.server on its own always sends the whole file.
"""

from __future__ import annotations

import argparse
import functools
import os
import re
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


class Handler(SimpleHTTPRequestHandler):
    """Static files from `directory`, except /data/ from `data_dir` if given."""

    def __init__(
        self,
        *args: Any,
        data_dir: str | None = None,
        basemap: str | None = None,
        **kwargs: Any,
    ) -> None:
        self.data_dir = data_dir
        self.basemap = basemap
        super().__init__(*args, **kwargs)

    def translate_path(self, path: str) -> str:
        local = super().translate_path(path)
        if self.basemap is not None and local == os.path.join(self.directory, "basemap.pmtiles"):
            return os.path.abspath(self.basemap)
        if self.data_dir is None:
            return local
        data_root = os.path.join(self.directory, "data")
        if local == data_root or local.startswith(data_root + os.sep):
            return os.path.join(os.path.abspath(self.data_dir), os.path.relpath(local, data_root))
        return local


RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")


class RangeHandler(Handler):
    """Handler, plus one byte range per request, the way PMTiles reads."""

    def do_GET(self) -> None:
        spec = RANGE.match(self.headers.get("Range", "").strip())
        path = self.translate_path(self.path)
        if spec is None or not os.path.isfile(path):
            super().do_GET()
            return
        size = os.path.getsize(path)
        first, last = spec.group(1), spec.group(2)
        if first == "":  # the last N bytes
            start, end = max(0, size - int(last or 0)), size - 1
        else:
            start, end = int(first), min(size - 1, int(last) if last else size - 1)
        if start >= size or start > end:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            self.wfile.write(f.read(end - start + 1))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("port", type=int, nargs="?", default=8321)
    ap.add_argument("directory", nargs="?", default=".")
    ap.add_argument("--data", dest="data_dir", default=None)
    ap.add_argument("--basemap", default=None)
    args = ap.parse_args()
    port, directory = args.port, args.directory
    if args.data_dir is not None and not os.path.isfile(os.path.join(args.data_dir, "meta.json")):
        # fail loudly rather than serve a map with no data behind it
        raise SystemExit(f"--data {args.data_dir}: no meta.json there (run npm run test-data)")
    if args.basemap is not None and not os.path.isfile(args.basemap):
        raise SystemExit(f"--basemap {args.basemap}: no such file (run npm run test-data)")
    handler = functools.partial(
        RangeHandler, directory=directory, data_dir=args.data_dir, basemap=args.basemap
    )
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
