"""Supervisor contract tests: no child process, socket or data provider is used."""
from types import SimpleNamespace

import dotenv
import pytest

import run_astra


class Child:
    def __init__(self):
        self.returncode = None
        self.terminated = 0
        self.killed = 0
        self.waits = []
        self.timeout = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated += 1
        if not self.timeout:
            self.returncode = -15

    def wait(self, timeout):
        self.waits.append(timeout)
        if self.timeout:
            raise run_astra.subprocess.TimeoutExpired("mock", timeout)
        return self.returncode

    def kill(self):
        self.killed += 1
        self.returncode = -9


class Healthy:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


@pytest.fixture
def harness(monkeypatch):
    state = SimpleNamespace(children=[], launches=[], handlers={}, requests=[], sleeps=[])
    for key in ("PORT", "LEGACY_PORT", "ASTRA_HOST", "NODE_BINARY"):
        monkeypatch.delenv(key, raising=False)
    # Never read a developer's .env or register a real signal handler.
    monkeypatch.setattr(dotenv, "load_dotenv", lambda *_a, **_kw: None)
    monkeypatch.setattr(run_astra.signal, "signal", lambda sig, handler: state.handlers.__setitem__(sig, handler))

    def launch(command, **kwargs):
        child = Child()
        state.children.append(child)
        state.launches.append((command, kwargs))
        return child

    def health(url, **kwargs):
        state.requests.append((url, kwargs))
        return Healthy()

    def sleep(seconds):
        state.sleeps.append(seconds)
        # Stop the supervisor after one simulated monitor cycle.
        state.handlers[run_astra.signal.SIGTERM](None, None)

    monkeypatch.setattr(run_astra.subprocess, "Popen", launch)
    monkeypatch.setattr(run_astra.urllib.request, "urlopen", health)
    monkeypatch.setattr(run_astra.time, "sleep", sleep)
    return state


def test_startup_binds_provider_to_loopback_and_shuts_down_children(harness, monkeypatch):
    monkeypatch.setenv("ASTRA_HOST", "0.0.0.0")
    assert run_astra.main() == 0
    assert len(harness.launches) == 2
    node, gateway = harness.launches
    assert node[0] == ["node", "server.js"]
    assert node[1]["env"]["HOST"] == "127.0.0.1"
    assert node[1]["env"]["PORT"] == "10000"
    assert gateway[1]["env"]["LEGACY_API_URL"] == "http://127.0.0.1:10000"
    assert gateway[0][gateway[0].index("--host") + 1] == "0.0.0.0"
    assert gateway[0][gateway[0].index("--port") + 1] == "8000"
    assert harness.requests == [("http://127.0.0.1:10000/healthz", {"timeout": 1})]
    assert all(child.terminated == 1 and child.waits == [10] for child in harness.children)


def test_equal_ports_are_separated(harness, monkeypatch):
    monkeypatch.setenv("PORT", "10000")
    assert run_astra.main() == 0
    assert harness.launches[0][1]["env"]["PORT"] == "10001"
    assert harness.launches[1][1]["env"]["LEGACY_API_URL"] == "http://127.0.0.1:10001"


@pytest.mark.parametrize("port", ["0", "65536", "not-a-number"])
def test_invalid_port_never_starts_a_child(harness, monkeypatch, port):
    monkeypatch.setenv("PORT", port)
    with pytest.raises(ValueError):
        run_astra.main()
    assert harness.launches == []


def test_dead_provider_prevents_gateway_start(harness, monkeypatch):
    original = run_astra.subprocess.Popen

    def launch(*args, **kwargs):
        child = original(*args, **kwargs)
        child.returncode = 1
        return child

    monkeypatch.setattr(run_astra.subprocess, "Popen", launch)
    assert run_astra.main() == 1
    assert len(harness.children) == 1
    assert harness.requests == []
    assert harness.children[0].waits == [10]


def test_failed_health_readiness_is_bounded_and_cleans_up(harness, monkeypatch):
    def unavailable(*_args, **_kwargs):
        raise OSError("mock unavailable")

    monkeypatch.setattr(run_astra.urllib.request, "urlopen", unavailable)
    monkeypatch.setattr(run_astra.time, "sleep", harness.sleeps.append)
    with pytest.raises(RuntimeError, match="Legacy provider startup failed"):
        run_astra.main()
    assert harness.sleeps == [0.1] * 100
    assert len(harness.children) == 1
    assert harness.children[0].terminated == 1
    assert harness.children[0].waits == [10]


def test_gateway_exit_stops_provider(harness, monkeypatch):
    original = run_astra.subprocess.Popen

    def launch(*args, **kwargs):
        child = original(*args, **kwargs)
        if len(harness.children) == 2:
            child.returncode = 1
        return child

    monkeypatch.setattr(run_astra.subprocess, "Popen", launch)
    assert run_astra.main() == 1
    assert harness.children[0].terminated == 1
    assert all(child.waits == [10] for child in harness.children)


def test_stubborn_child_is_killed_after_wait_timeout(harness, monkeypatch):
    original = run_astra.subprocess.Popen

    def launch(*args, **kwargs):
        child = original(*args, **kwargs)
        child.timeout = True
        return child

    monkeypatch.setattr(run_astra.subprocess, "Popen", launch)
    assert run_astra.main() == 0
    assert all(child.waits == [10] and child.killed == 1 for child in harness.children)


def test_gateway_launch_exception_cleans_up_provider(harness, monkeypatch):
    original = run_astra.subprocess.Popen

    def launch(*args, **kwargs):
        if harness.children:
            raise OSError("mock gateway launch failure")
        return original(*args, **kwargs)

    monkeypatch.setattr(run_astra.subprocess, "Popen", launch)
    with pytest.raises(OSError, match="mock gateway launch failure"):
        run_astra.main()
    assert len(harness.children) == 1
    assert harness.children[0].terminated == 1
    assert harness.children[0].waits == [10]


def test_shutdown_during_readiness_does_not_launch_gateway(harness, monkeypatch):
    def unavailable(*_args, **_kwargs):
        raise OSError("mock unavailable")

    monkeypatch.setattr(run_astra.urllib.request, "urlopen", unavailable)
    # Harness sleep delivers SIGTERM instead of waiting or touching real signals.
    assert run_astra.main() == 1
    assert len(harness.children) == 1
    assert harness.children[0].terminated == 1
    assert harness.children[0].waits == [10]
