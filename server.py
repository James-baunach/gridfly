#!/usr/bin/env python3
"""GridFly local helper.

Serves the web app and, on Windows, installs missions onto a DJI Fly controller connected
by USB (via installer/mtp.ps1). Standard library only; listens on 127.0.0.1.

    python server.py [--port 8765] [--no-browser]
"""
import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid
import webbrowser
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

VERSION = "0.2.0"
FROZEN = getattr(sys, "frozen", False)
ROOT = Path(sys._MEIPASS) if FROZEN else Path(__file__).resolve().parent  # bundled resources
APP_DIR = Path(sys.executable).parent if FROZEN else ROOT                 # user data (backups)
WEB = ROOT / "web"
PS_SCRIPT = ROOT / "installer" / "mtp.ps1"
BACKUPS = APP_DIR / "backups"
IS_WINDOWS = os.name == "nt"
UUID_RE = re.compile(r"^[0-9A-Fa-f]{8}-[0-9A-Fa-f-]{27}$")
BACKUP_RE = re.compile(r"^\d{8}-\d{6}-[0-9A-Fa-f]{8}$")
HOST_RE = re.compile(r"^(127\.0\.0\.1|localhost)(:\d+)?$")
MAX_KMZ = 20 * 1024 * 1024
MTP_LOCK = threading.Lock()  # one device operation at a time


def run_ps(*args, timeout=240):
    cmd = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
           "-File", str(PS_SCRIPT), *args]
    with MTP_LOCK:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    out = proc.stdout.decode("utf-8", "replace").lstrip("﻿").strip()
    data = None
    for line in reversed(out.splitlines()):
        line = line.strip()
        if line.startswith(("{", "[")):
            data = json.loads(line)
            break
    if isinstance(data, dict) and data.get("error"):
        raise RuntimeError(data["error"])
    if proc.returncode != 0 or data is None:
        err = proc.stderr.decode("utf-8", "replace").strip() or out or f"exit code {proc.returncode}"
        raise RuntimeError(err.splitlines()[-1])
    return data


def check_arg(value, name):
    if not isinstance(value, str) or not value or value.startswith("-") or len(value) > 200:
        raise ValueError(f"invalid {name}")
    return value


def check_id(value):
    if not isinstance(value, str) or not UUID_RE.match(value):
        raise ValueError("invalid mission id")
    return value


def check_backup(value):
    if not isinstance(value, str) or not BACKUP_RE.match(value):
        raise ValueError("invalid backup name")
    return value


def decode_kmz(body):
    kmz = base64.b64decode(body.get("kmz", ""), validate=True)
    if len(kmz) > MAX_KMZ:
        raise ValueError("KMZ too large")
    if not kmz.startswith(b"PK"):
        raise ValueError("not a KMZ (zip) file")
    return kmz


def read_back(device, storage, mission):
    tmp = tempfile.mkdtemp(prefix="gridfly-")
    try:
        r = run_ps("-Action", "fetch", "-Device", device, "-Storage", storage, "-Mission", mission, "-Dest", tmp)
        return Path(r["path"]).read_bytes()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def verify(kmz, device, storage, mission, warning):
    """Read the file back from the controller and compare SHA-256 -> (verified, warning)."""
    try:
        ok = hashlib.sha256(read_back(device, storage, mission)).digest() == hashlib.sha256(kmz).digest()
    except Exception as e:
        return False, "; ".join(filter(None, [warning, f"Could not read the file back to verify it: {e}"]))
    if not ok:
        warning = "; ".join(filter(None, [warning, "The file on the controller does not match what was sent. Install it again."]))
    return ok, warning


def first_kmz(folder):
    return next((f for f in sorted(folder.iterdir()) if f.is_file() and f.suffix.lower() == ".kmz"), None)


def install_kmz(device, storage, mission, kmz):
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = BACKUPS / f"{stamp}-{mission[:8]}"
    backup_dir.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="gridfly-"))
    try:
        src = tmp / f"{mission}.kmz"
        src.write_bytes(kmz)
        r = run_ps("-Action", "install", "-Device", device, "-Storage", storage,
                   "-Mission", mission, "-Source", str(src), "-Dest", str(backup_dir))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        # The moved-off-device original is already copied to the backup; drop the duplicate.
        shutil.rmtree(backup_dir / "moved", ignore_errors=True)
        if not any(backup_dir.iterdir()):
            backup_dir.rmdir()
    if backup_dir.exists():
        (backup_dir / "meta.json").write_text(json.dumps({"mission": mission, "device": device, "storage": storage}))
    else:
        r["backup"] = None
    r["verified"], r["warning"] = verify(kmz, device, storage, mission, r.get("warning"))
    r["ok"] = True
    return r


def create_kmz(device, storage, template, kmz):
    new = str(uuid.uuid4())
    # Match the folder-name case on the device.
    new = new.lower() if template == template.lower() else new.upper()
    tmp = Path(tempfile.mkdtemp(prefix="gridfly-"))
    try:
        src = tmp / f"{new}.kmz"
        src.write_bytes(kmz)
        run_ps("-Action", "create", "-Device", device, "-Storage", storage,
               "-Template", template, "-Mission", new, "-Source", str(src))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    verified, warning = verify(kmz, device, storage, new, None)
    return {"ok": True, "id": new, "verified": verified, "warning": warning}


def list_backups():
    out = []
    if not BACKUPS.is_dir():
        return out
    for d in BACKUPS.iterdir():
        if not d.is_dir() or not BACKUP_RE.match(d.name):
            continue
        kmz = first_kmz(d)
        if not kmz:
            continue
        mission = None
        try:
            mission = json.loads((d / "meta.json").read_text()).get("mission")
        except Exception:
            pass
        if not (isinstance(mission, str) and UUID_RE.match(mission)):
            mission = kmz.stem if UUID_RE.match(kmz.stem) else None
        try:
            created = datetime.strptime(d.name[:15], "%Y%m%d-%H%M%S").isoformat()
        except ValueError:
            created = datetime.fromtimestamp(d.stat().st_mtime).isoformat()
        out.append({"folder": d.name, "mission": mission, "file": kmz.name,
                    "size": kmz.stat().st_size, "created": created})
    out.sort(key=lambda b: b["created"], reverse=True)
    return out


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            sys.stderr.write("%s\n" % (fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def api_allowed(self):
        # The custom header forces a CORS preflight for cross-site requests, which we never
        # answer; the Host check blocks DNS-rebinding.
        if self.headers.get("X-GridFly") != "1" or not HOST_RE.match(self.headers.get("Host", "")):
            self.send_json(403, {"error": "forbidden"})
            return False
        return True

    def do_GET(self):
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            return super().do_GET()
        if not self.api_allowed():
            return
        try:
            if url.path == "/api/status":
                return self.send_json(200, {"helper": True, "installer": IS_WINDOWS and PS_SCRIPT.exists(),
                                            "platform": sys.platform, "version": VERSION,
                                            "experimentalCreate": True})
            if url.path == "/api/backups":
                return self.send_json(200, list_backups())
            if not IS_WINDOWS:
                return self.send_json(501, {"error": "Direct install is only supported on Windows."})
            if url.path == "/api/devices":
                return self.send_json(200, run_ps("-Action", "list"))
            if url.path == "/api/mission":
                q = {k: v[0] for k, v in parse_qs(url.query).items()}
                data = read_back(check_arg(q.get("device"), "device"), check_arg(q.get("storage"), "storage"),
                                 check_id(q.get("id")))
                self.send_response(200)
                self.send_header("Content-Type", "application/vnd.google-earth.kmz")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            self.send_json(404, {"error": "unknown endpoint"})
        except Exception as e:  # report to the UI
            self.send_json(500, {"error": str(e)})

    def do_POST(self):
        url = urlparse(self.path)
        if not self.api_allowed():
            return
        try:
            if url.path not in ("/api/install", "/api/restore", "/api/create"):
                return self.send_json(404, {"error": "unknown endpoint"})
            if not IS_WINDOWS:
                return self.send_json(501, {"error": "Direct install is only supported on Windows."})
            length = int(self.headers.get("Content-Length", 0))
            if length <= 0 or length > MAX_KMZ * 2:
                return self.send_json(413, {"error": "request too large"})
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("invalid request")
            device = check_arg(body.get("device"), "device")
            storage = check_arg(body.get("storage"), "storage")
            if url.path == "/api/install":
                r = install_kmz(device, storage, check_id(body.get("id")), decode_kmz(body))
            elif url.path == "/api/restore":
                mission = check_id(body.get("id"))
                folder = BACKUPS / check_backup(body.get("backup"))
                kmz = first_kmz(folder) if folder.is_dir() else None
                if not kmz:
                    return self.send_json(404, {"error": "backup not found"})
                data = kmz.read_bytes()
                if not data.startswith(b"PK"):
                    raise ValueError("backup is not a KMZ (zip) file")
                r = install_kmz(device, storage, mission, data)
            else:
                r = create_kmz(device, storage, check_id(body.get("template")), decode_kmz(body))
            self.send_json(200, r)
        except Exception as e:
            self.send_json(500, {"error": str(e)})


def main():
    ap = argparse.ArgumentParser(description="GridFly local helper")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://localhost:{args.port}/"
    print(f"GridFly {VERSION} running at {url}  (Ctrl+C to stop)")
    if not IS_WINDOWS:
        print("Note: direct install to the controller is Windows-only; download KMZ files instead.")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
