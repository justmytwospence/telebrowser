"""Close a Chromium gracefully over CDP (Browser.close), so it flushes cookies to disk.

SIGTERM alone makes Chromium exit without committing recent cookie writes: a sign-in
made seconds before a stop or container restart would be lost. Runs with the Python that
ships in the linuxserver image (/lsiopy), which has `websockets`.

usage: close-browser.py <debug port>
"""

import json
import sys
import urllib.request

from websockets.sync.client import connect

port = int(sys.argv[1])
with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=3) as r:
    ws_url = json.load(r)["webSocketDebuggerUrl"]
with connect(ws_url, open_timeout=3, max_size=None) as ws:
    ws.send(json.dumps({"id": 1, "method": "Browser.close"}))
    try:
        ws.recv(timeout=5)
    except Exception:
        pass  # the browser may drop the connection as it exits
