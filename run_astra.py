"""Run the existing Node provider and the new FastAPI gateway in one deployment."""
from __future__ import annotations

import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parent


def main():
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env", override=False)
    public_port = int(os.getenv("PORT", "8000"))
    internal_port = int(os.getenv("LEGACY_PORT", "10000"))
    if public_port == internal_port:
        internal_port = public_port + 1
    if not (1 <= public_port <= 65535 and 1 <= internal_port <= 65535):
        raise ValueError("Invalid service port")
    legacy_env = dict(os.environ, PORT=str(internal_port), HOST="127.0.0.1")
    python_env = dict(os.environ, LEGACY_API_URL=f"http://127.0.0.1:{internal_port}")
    children = []
    stopping = False

    def stop(*_):
        nonlocal stopping
        stopping = True
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        children.append(subprocess.Popen([os.getenv("NODE_BINARY", "node"), "server.js"], cwd=ROOT, env=legacy_env))
        for _ in range(100):
            if stopping or children[0].poll() is not None:
                return 1
            try:
                with urllib.request.urlopen(python_env["LEGACY_API_URL"] + "/healthz", timeout=1) as response:
                    if response.status == 200:
                        break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("Legacy provider startup failed")
        children.append(subprocess.Popen([sys.executable, "-m", "uvicorn", "astra.app:create_app", "--factory",
            "--host", os.getenv("ASTRA_HOST", "127.0.0.1"), "--port", str(public_port),
            "--proxy-headers", "--forwarded-allow-ips", "127.0.0.1"], cwd=ROOT, env=python_env))
        while not stopping:
            if any(child.poll() is not None for child in children):
                return 1
            time.sleep(0.5)
        return 0
    finally:
        stop()
        for child in children:
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()


if __name__ == "__main__":
    raise SystemExit(main())
