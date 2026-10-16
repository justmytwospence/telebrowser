"""Raise (and unminimize) a project's browser window in labwc.

Wayland gives clients no way to raise themselves, and labwc ignores Chromium's own
activation (CDP Target.activateTarget changes the tab, not the stacking). Taskbars use the
wlr-foreign-toplevel-management protocol for this, so this speaks it directly: a minimal
Wayland client over the raw wire protocol (the image has no pywayland or wlrctl).

usage: raise-window.py <project>     match the window title [<project>] (Chromium --window-name)
       raise-window.py --list        print app_id and title of every toplevel
Needs XDG_RUNTIME_DIR and WAYLAND_DISPLAY (labwc's socket).
"""

import os
import socket
import struct
import sys


class Wayland:
    def __init__(self):
        path = os.path.join(os.environ["XDG_RUNTIME_DIR"], os.environ.get("WAYLAND_DISPLAY", "wayland-0"))
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(path)
        self.next_id = 2  # 1 is wl_display
        self.buf = b""

    def new_id(self):
        self.next_id += 1
        return self.next_id - 1

    def send(self, obj, opcode, payload=b""):
        self.sock.sendall(struct.pack("<II", obj, (8 + len(payload)) << 16 | opcode) + payload)

    def events(self):
        """Yield (object, opcode, payload) until a read would block after a roundtrip."""
        while True:
            while len(self.buf) < 8:
                self.buf += self.sock.recv(65536)
            obj, word = struct.unpack("<II", self.buf[:8])
            size, opcode = word >> 16, word & 0xFFFF
            while len(self.buf) < size:
                self.buf += self.sock.recv(65536)
            payload, self.buf = self.buf[8:size], self.buf[size:]
            yield obj, opcode, payload

    def roundtrip(self, handler):
        """wl_display.sync, dispatching events to handler until its callback fires."""
        cb = self.new_id()
        self.send(1, 0, struct.pack("<I", cb))
        for obj, opcode, payload in self.events():
            if obj == cb:
                return
            if obj == 1 and opcode == 0:  # wl_display.error
                raise RuntimeError(f"wayland error: {payload!r}")
            handler(obj, opcode, payload)


def string(s):
    data = s.encode() + b"\0"
    pad = (4 - len(data) % 4) % 4
    return struct.pack("<I", len(data)) + data + b"\0" * pad


def read_string(payload, off=0):
    (n,) = struct.unpack_from("<I", payload, off)
    return payload[off + 4 : off + 4 + n - 1].decode(errors="replace"), off + 4 + n + (4 - n % 4) % 4


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else "--list"
    wl = Wayland()
    registry = wl.new_id()
    wl.send(1, 1, struct.pack("<I", registry))  # wl_display.get_registry
    globals_ = {}

    def on_registry(obj, opcode, payload):
        if obj == registry and opcode == 0:
            (name,) = struct.unpack_from("<I", payload)
            iface, off = read_string(payload, 4)
            (version,) = struct.unpack_from("<I", payload, off)
            globals_[iface] = (name, version)

    wl.roundtrip(on_registry)
    if "zwlr_foreign_toplevel_manager_v1" not in globals_ or "wl_seat" not in globals_:
        sys.exit("compositor lacks wlr-foreign-toplevel-management or a seat")

    def bind(iface, version):
        name, have = globals_[iface]
        oid = wl.new_id()
        wl.send(registry, 0, struct.pack("<I", name) + string(iface) + struct.pack("<II", min(version, have), oid))
        return oid

    seat = bind("wl_seat", 1)
    manager = bind("zwlr_foreign_toplevel_manager_v1", 3)
    toplevels = {}  # handle id -> {"app_id", "title"}

    def on_event(obj, opcode, payload):
        if obj == manager and opcode == 0:  # toplevel(new_id)
            (hid,) = struct.unpack_from("<I", payload)
            toplevels[hid] = {"app_id": "", "title": ""}
        elif obj in toplevels and opcode in (0, 1):  # title, app_id
            toplevels[obj]["title" if opcode == 0 else "app_id"] = read_string(payload)[0]
        elif obj in toplevels and opcode == 6:  # closed
            toplevels.pop(obj, None)

    wl.roundtrip(on_event)
    wl.roundtrip(on_event)  # handles announce their title/app_id after creation

    if target == "--list":
        for t in toplevels.values():
            print(f"{t['app_id']}\t{t['title']}")
        return
    # The app_id stays "chromium": labwc's rules draw no server titlebar for it.
    matches = [h for h, t in toplevels.items() if t["title"] == f"[{target}]"]
    if not matches:
        sys.exit(f"no window for project {target}")
    for h in matches:
        wl.send(h, 3)  # unset_minimized
        wl.send(h, 4, struct.pack("<I", seat))  # activate(seat): raise and focus
    wl.roundtrip(lambda *a: None)
    print(f"raised {len(matches)} window(s) for {target}")


if __name__ == "__main__":
    main()
