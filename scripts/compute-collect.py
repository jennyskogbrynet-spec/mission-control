#!/usr/bin/env python3
"""Read subscription capacity; publish observations to local MC only with --publish.

Private configuration (no credentials): version=1, profiles=[{provider, profileRef,
accountId, bindingId? or bindingIds?, expectedEmailHash?, configDir? (Claude only), apiKeyEnv?
(ZAI only), pools:[{poolId, limitId? (Codex), windows:[{key, source, label?}]}]}].
ZAI accepts only ZAI_API_KEY: the environment takes precedence over the literal
assignment in ~/.openclaw/.env. That file is never sourced or evaluated.
Direct runs space quota reads and MC requests by at least five seconds; publishing
many observations therefore takes longer than a read-only collection.
Claude sources: primary/secondary/tertiary. Codex uses those per limitId. ZAI
sources are exact TYPE:unit:number, e.g. TOKENS_LIMIT:3:5 and TOKENS_LIMIT:6:1.
Configure all required windows; never remove constraints because a read omits one.
No generations, browser cookies, credential exports, global login changes or
automatic resets. Output contains observations only, never raw provider responses.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

MAX_BYTES = 2 * 1024 * 1024
TIMEOUT = 60
REGISTRY_PROVIDERS = {"claude": {"claude", "anthropic"}, "codex": {"codex", "openai"}, "zai": {"zai"}}
DEFAULT_CONFIG = Path.home() / ".openclaw/mission-control/compute-collectors.json"
OPENCLAW_ENV = Path.home() / ".openclaw/.env"
ZAI_KEY_ENV = "ZAI_API_KEY"
MAX_ENV_BYTES = 128 * 1024
API_INTERVAL = 5
MC_HELPER = Path.home() / ".openclaw/workspace/skills/mission-control/scripts/mc-api.py"
ZAI_QUOTA = "https://api.z.ai/api/monitor/usage/quota/limit"
SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")


class CollectionError(Exception):
    def __init__(self, code, login=False):
        super().__init__(code)
        self.code = code
        self.login = login


class ApiPacer:
    """Space outbound call starts within one run; never retry a failed call."""
    def __init__(self, clock=time.monotonic, sleep=time.sleep):
        self.clock, self.sleep, self.last = clock, sleep, None

    def wait(self):
        if self.last is not None:
            remaining = API_INTERVAL - (self.clock() - self.last)
            if remaining > 0:
                self.sleep(remaining)
        self.last = self.clock()

    def wrap(self, request):
        def paced(*args, **kwargs):
            self.wait()
            return request(*args, **kwargs)
        return paced


def read_zai_api_key(api_key_env=ZAI_KEY_ENV, *, environ=None, dotenv_path=None):
    """Read only the allowed key; path injection is for local fixture tests only."""
    if api_key_env != ZAI_KEY_ENV:
        raise CollectionError("collector_config_invalid")
    env = os.environ if environ is None else environ
    if api_key_env in env:
        # An explicitly empty override must not silently select another credential.
        value = env[api_key_env]
    else:
        path = OPENCLAW_ENV if dotenv_path is None else dotenv_path
        try:
            with Path(path).open("rb") as stream:
                raw = stream.read(MAX_ENV_BYTES + 1)
            if len(raw) > MAX_ENV_BYTES:
                raise CollectionError("provider_api_key_file_invalid", login=True)
            lines = raw.decode("utf-8").splitlines()
        except FileNotFoundError:
            raise CollectionError("provider_api_key_unavailable", login=True) from None
        except (OSError, UnicodeDecodeError):
            raise CollectionError("provider_api_key_file_unreadable", login=True) from None
        matches = []
        for line in lines:
            assignment = re.fullmatch(r"\s*(?:export\s+)?ZAI_API_KEY\s*=(.*)", line)
            if assignment:
                # Literal one-line dotenv values only; no interpolation or escape
                # expansion, shell commands, unrelated variables or sourced files.
                parsed = re.fullmatch(r'''\s*(?:'([^']*)'|"([^"]*)"|([^\s#'"]+))\s*(?:#.*)?''', assignment[1])
                if not parsed:
                    raise CollectionError("provider_api_key_file_invalid", login=True)
                matches.append(next(item for item in parsed.groups() if item is not None))
        if len(matches) > 1:
            raise CollectionError("provider_api_key_file_ambiguous", login=True)
        value = matches[0] if matches else None
    if not isinstance(value, str) or not value.strip():
        raise CollectionError("provider_api_key_unavailable", login=True)
    # Fail closed on expressions rather than forwarding unevaluated shell syntax.
    if any(char.isspace() or ord(char) < 32 or ord(char) == 127 or char in "$`\\" for char in value):
        raise CollectionError("provider_api_key_invalid", login=True)
    return value


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def timestamp(value, milliseconds=False):
    """Preserve missing/invalid timestamps, never guess a reset or timezone."""
    if value is None or isinstance(value, bool):
        return None
    try:
        if isinstance(value, (float, int)):
            if not math.isfinite(value):
                return None
            dt = datetime.fromtimestamp(value / (1000 if milliseconds else 1), timezone.utc)
        elif isinstance(value, str):
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                return None
        else:
            return None
        return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (ValueError, OverflowError, OSError):
        return None


def number(value, percentage=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    if value < 0 or (percentage and value > 100):
        return None
    return value


def fingerprint(email):
    if not isinstance(email, str) or not email.strip() or "@" not in email:
        raise CollectionError("account_identity_unavailable", login=True)
    return hashlib.sha256(email.strip().lower().encode()).hexdigest()


def verified_identity(before, after, expected):
    if not isinstance(before, dict) or not isinstance(after, dict):
        raise CollectionError("account_identity_unavailable", login=True)
    first, last = fingerprint(before.get("email")), fingerprint(after.get("email"))
    if first != last:
        raise CollectionError("account_changed_during_collection")
    if not expected or first != expected:
        raise CollectionError("unexpected_account_identity")
    return first


def oauth_environment(provider, profile):
    env = dict(os.environ)
    for key in list(env):
        if key.startswith("ANTHROPIC_") or key in {
            "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
            "CLAUDE_CONFIG_DIR", "CODEXBAR_ALLOW_BROWSER_COOKIE_IMPORT",
        }:
            env.pop(key, None)
    env["CODEXBAR_ALLOW_BROWSER_COOKIE_IMPORT"] = "0"
    # CODEX_HOME/HOME are never rewritten. Existing default Codex auth is retained.
    if profile.get("configDir"):
        if provider != "claude":
            raise CollectionError("profile_directory_unsupported")
        folder = Path(profile["configDir"]).expanduser()
        if not folder.is_dir():
            raise CollectionError("profile_directory_missing", login=True)
        env["CLAUDE_CONFIG_DIR"] = str(folder)
    return env


class BoundedProcess:
    """Drain both streams in memory; cap total bytes and the complete protocol run."""
    def __init__(self, command, env, deadline, *, cwd=None):
        self.deadline = deadline
        self.total = 0
        self.pending = bytearray()
        self.lines = []
        try:
            self.process = subprocess.Popen(command, env=env, cwd=cwd, stdin=subprocess.PIPE,
                                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                            start_new_session=True)
        except OSError:
            raise CollectionError("provider_cli_unavailable") from None
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ, "stdout")
        self.selector.register(self.process.stderr, selectors.EVENT_READ, "stderr")

    def close(self):
        if self.process.poll() is None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
                self.process.wait(timeout=1)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.process.wait(timeout=2)
        self.selector.close()
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            stream.close()

    def read_chunk(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise CollectionError("provider_timeout")
        events = self.selector.select(remaining)
        if not events:
            raise CollectionError("provider_timeout")
        chunks = []
        for event, _ in events:
            block = os.read(event.fileobj.fileno(), 65536)
            if not block:
                self.selector.unregister(event.fileobj)
                continue
            self.total += len(block)
            if self.total > MAX_BYTES:
                raise CollectionError("provider_output_too_large")
            if event.data == "stdout":
                chunks.append(block)
        return b"".join(chunks)

    def send(self, data):
        try:
            self.process.stdin.write(json.dumps(data, separators=(",", ":")).encode() + b"\n")
            self.process.stdin.flush()
        except (BrokenPipeError, OSError):
            raise CollectionError("provider_protocol_closed") from None

    def rpc(self, ident, method, params):
        self.send({"jsonrpc": "2.0", "id": ident, "method": method, "params": params})
        while True:
            while b"\n" in self.pending:
                line, _, tail = self.pending.partition(b"\n")
                self.pending = bytearray(tail)
                try:
                    obj = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    continue
                if not isinstance(obj, dict) or obj.get("id") != ident:
                    continue
                if "error" in obj:
                    raise CollectionError("provider_rpc_failed")
                if not isinstance(obj.get("result"), dict):
                    raise CollectionError("provider_response_invalid")
                return obj["result"]
            if not self.selector.get_map():
                raise CollectionError("provider_protocol_closed")
            self.pending.extend(self.read_chunk())


def command_json(command, env, deadline, *, cwd=None):
    proc = BoundedProcess(command, env, deadline, cwd=cwd)
    output = bytearray()
    try:
        proc.process.stdin.close()
        while proc.selector.get_map():
            output.extend(proc.read_chunk())
        proc.process.wait(timeout=max(0.01, deadline - time.monotonic()))
        if proc.process.returncode:
            raise CollectionError("provider_cli_failed")
        try:
            return json.loads(output)
        except (ValueError, UnicodeDecodeError):
            raise CollectionError("provider_response_invalid") from None
    finally:
        proc.close()


def base_observation(profile, kind, source, observed_at, **fields):
    value = {"kind": kind, "accountId": profile["accountId"], "observedAt": observed_at,
             "source": source, "status": "success", **fields}
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    value["externalId"] = str(uuid.uuid5(uuid.NAMESPACE_URL, "mc-compute:" + canonical))
    return value


def source_for(provider):
    return {"kind": "provider_api" if provider == "zai" else "cli",
            "label": {"claude": "Claude auth status and CodexBar CLI",
                      "codex": "Codex app-server account and rate limits",
                      "zai": "ZAI coding-plan quota endpoint"}.get(provider, "Manual provider usage required"),
            "evidenceRef": ZAI_QUOTA if provider == "zai" else "supported-cli:" + provider}


def access_observation(profile, identity, observed_at):
    return base_observation(profile, "access", source_for(profile["provider"]), observed_at,
                            bindingId=profile.get("bindingId"), identityFingerprint=identity,
                            identityVerified=True, entitlementVerified=True)


def profile_bindings(profile):
    return profile.get("bindingIds") or [profile.get("bindingId")]


def access_observations(profile, identity, observed_at):
    return [access_observation({**profile, "bindingId": binding}, identity, observed_at)
            for binding in profile_bindings(profile)]


def failure_observations(profile, error, observed_at=None):
    moment = observed_at or utc_now()
    status = "login_required" if error.login else "failed"
    source = source_for(profile["provider"])
    observations = [base_observation(profile, "quota", source, moment,
                    poolId=pool["poolId"], windows=[], status=status, error=error.code)
                    for pool in profile.get("pools", [])]
    # Any failed read also invalidates that OAuth binding's currently executable proof.
    if profile["provider"] in {"claude", "codex"}:
        for binding in profile_bindings(profile):
            observations.append(base_observation(profile, "access", source, moment,
                                bindingId=binding, identityFingerprint=None,
                                identityVerified=False, entitlementVerified=False,
                                status=status, error=error.code))
    return observations


def mapped_window(mapping, raw, provider):
    if not isinstance(raw, dict):
        raise CollectionError("required_quota_window_missing")
    unit = "percent"
    limit = used = None
    reset = timestamp(raw.get("resetsAt"))
    percentage = number(raw.get("usedPercent"), percentage=True)
    if provider == "zai":
        reset = timestamp(raw.get("nextResetTime"), milliseconds=True)
        percentage = number(raw.get("percentage"), percentage=True)
        # Only counts actually exposed by the provider are retained. TOKENS_LIMIT
        # names do not prove a token budget in the current credit-based plans.
        if raw.get("type") == "TIME_LIMIT":
            unit = "calls"
        elif raw.get("type") == "CREDIT_LIMIT":
            unit = "credits"
        else:
            unit = "provider_units"
        limit, used = number(raw.get("usage")), number(raw.get("currentValue"))
    return {"key": mapping["key"], "label": mapping.get("label", mapping["key"]),
            "usedPercent": percentage, "remainingPercent": None,
            "limit": limit, "used": used, "unit": unit, "resetsAt": reset}


def quota_observations(profile, get_window, observed_at):
    observations = []
    for pool in profile.get("pools", []):
        try:
            windows = [mapped_window(mapping, get_window(pool, mapping), profile["provider"])
                       for mapping in pool["windows"]]
            observations.append(base_observation(profile, "quota", source_for(profile["provider"]),
                                                 observed_at, poolId=pool["poolId"], windows=windows))
        except CollectionError as error:
            observations.append(base_observation(profile, "quota", source_for(profile["provider"]),
                                observed_at, poolId=pool["poolId"], windows=[],
                                status="failed", error=error.code))
    return observations


def collect_claude(profile, runner=command_json, *, pacer=None):
    env = oauth_environment("claude", profile)
    deadline = time.monotonic() + TIMEOUT
    before = runner(["claude", "auth", "status"], env, deadline)
    if pacer:
        pacer.wait()
    # CodexBar opens Claude's usage UI internally. A repository cwd can load
    # project context and stall that probe; quota reads need no project files.
    # Keep HOME/OAuth unchanged and isolate only this child's working directory.
    with tempfile.TemporaryDirectory(prefix="mc-compute-quota-") as quota_cwd:
        payload = runner(["codexbar", "usage", "--provider", "claude", "--source", "cli",
                          "--json", "--no-credits"], env, deadline, cwd=quota_cwd)
    after = runner(["claude", "auth", "status"], env, deadline)
    identity = verified_identity(before, after, profile.get("expectedEmailHash"))
    for auth in (before, after):
        if auth.get("loggedIn") is not True or auth.get("authMethod") != "claude.ai" \
                or auth.get("apiProvider") != "firstParty":
            raise CollectionError("subscription_auth_not_verified", login=True)
        if auth.get("subscriptionType") not in {"pro", "max", "team", "enterprise"}:
            raise CollectionError("subscription_entitlement_unavailable")
    if before.get("subscriptionType") != after.get("subscriptionType"):
        raise CollectionError("subscription_changed_during_collection")
    matches = [item for item in payload if isinstance(item, dict) and item.get("provider") == "claude"] \
        if isinstance(payload, list) else []
    if len(matches) != 1 or matches[0].get("error") or matches[0].get("source") not in {"claude", "cli"}:
        raise CollectionError("provider_response_invalid")
    usage = matches[0].get("usage")
    if not isinstance(usage, dict):
        raise CollectionError("provider_response_invalid")
    usage_identity = usage.get("identity")
    if isinstance(usage_identity, dict) and usage_identity.get("accountEmail") \
            and fingerprint(usage_identity["accountEmail"]) != identity:
        raise CollectionError("quota_account_identity_mismatch")
    observed_at = timestamp(usage.get("updatedAt"))
    if not observed_at:
        raise CollectionError("source_observation_time_missing")
    if datetime.fromisoformat(observed_at.replace("Z", "+00:00")).timestamp() > time.time() + 60:
        raise CollectionError("source_observation_time_in_future")
    return [*access_observations(profile, identity, observed_at),
            *quota_observations(profile, lambda pool, mapping: usage.get(mapping["source"]), observed_at)]


def collect_codex(profile, process_factory=BoundedProcess, *, pacer=None):
    env = oauth_environment("codex", profile)
    proc = process_factory(["codex", "app-server"], env, time.monotonic() + TIMEOUT)
    try:
        proc.rpc(1, "initialize", {"clientInfo": {"name": "mission-control-compute", "version": "1"}})
        proc.send({"jsonrpc": "2.0", "method": "initialized"})
        before = proc.rpc(2, "account/read", {"refreshToken": False}).get("account")
        if pacer:
            pacer.wait()
        data = proc.rpc(3, "account/rateLimits/read", {})
        observed_at = utc_now()
        after = proc.rpc(4, "account/read", {"refreshToken": False}).get("account")
    finally:
        proc.close()
    identity = verified_identity(before, after, profile.get("expectedEmailHash"))
    if before.get("type") != "chatgpt" or after.get("type") != "chatgpt":
        raise CollectionError("subscription_auth_not_verified", login=True)
    if not before.get("planType") or before.get("planType") != after.get("planType"):
        raise CollectionError("subscription_entitlement_unavailable")
    limits = data.get("rateLimitsByLimitId")
    if not isinstance(limits, dict) or not limits:
        legacy = data.get("rateLimits")
        limits = {legacy.get("limitId", "codex"): legacy} if isinstance(legacy, dict) else {}

    def get_window(pool, mapping):
        limit = limits.get(pool.get("limitId", "codex"))
        return limit.get(mapping["source"]) if isinstance(limit, dict) else None

    observations = [*access_observations(profile, identity, observed_at),
                    *quota_observations(profile, get_window, observed_at)]
    credits = data.get("rateLimitResetCredits")
    count = number(credits.get("availableCount")) if isinstance(credits, dict) else None
    if count is not None and int(count) == count:
        observations.append(base_observation(profile, "reset", source_for("codex"), observed_at,
                                            available=int(count), event="availability"))
    return observations


def fetch_zai(key):
    # Fixed official host, no redirects or configurable destination for the credential.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    request = urllib.request.Request(ZAI_QUOTA, headers={"Authorization": "Bearer " + key,
                                                       "Accept": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=15) as response:
            raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise CollectionError("provider_output_too_large")
            return json.loads(raw)
    except CollectionError:
        raise
    except Exception:
        raise CollectionError("provider_quota_fetch_failed") from None


def collect_zai(profile, fetcher=fetch_zai, *, key_reader=None, pacer=None):
    key = (key_reader or read_zai_api_key)(profile.get("apiKeyEnv", ZAI_KEY_ENV))
    if pacer:
        pacer.wait()
    payload = fetcher(key)
    observed_at = utc_now()
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(payload, dict) or payload.get("success") is not True or not isinstance(data, dict) or not isinstance(data.get("limits"), list):
        raise CollectionError("provider_response_invalid")
    limits = {}
    for item in data["limits"]:
        if not isinstance(item, dict):
            raise CollectionError("provider_response_invalid")
        key = ":".join(str(item.get(field)) for field in ("type", "unit", "number"))
        if key in limits:
            raise CollectionError("ambiguous_quota_window")
        limits[key] = item
    # The supported endpoint exposes no account identity. Never claim that it
    # independently verifies the configured account or authorizes a harness.
    return quota_observations(profile, lambda pool, mapping: limits.get(mapping["source"]), observed_at)


def validate_config(config):
    if not isinstance(config, dict) or set(config) - {"version", "profiles"} \
            or config.get("version") != 1 or not isinstance(config.get("profiles"), list):
        raise CollectionError("collector_config_invalid")
    if not 1 <= len(config["profiles"]) <= 24:
        raise CollectionError("collector_config_invalid")
    seen = set()
    allowed = {"provider", "profileRef", "accountId", "bindingId", "bindingIds", "expectedEmailHash",
               "configDir", "apiKeyEnv", "pools"}
    for profile in config["profiles"]:
        if not isinstance(profile, dict) or set(profile) - allowed:
            raise CollectionError("collector_config_invalid")
        for field in ("provider", "profileRef", "accountId"):
            if not isinstance(profile.get(field), str) or not SLUG.fullmatch(profile[field]):
                raise CollectionError("collector_config_invalid")
        if profile["profileRef"] in seen:
            raise CollectionError("duplicate_profile_reference")
        seen.add(profile["profileRef"])
        if profile.get("bindingId") is not None and not SLUG.fullmatch(str(profile["bindingId"])):
            raise CollectionError("collector_config_invalid")
        if "bindingIds" in profile:
            ids = profile["bindingIds"]
            if "bindingId" in profile or not isinstance(ids, list) or not 1 <= len(ids) <= 24 \
                    or any(not isinstance(item, str) or not SLUG.fullmatch(item) for item in ids) \
                    or len(set(ids)) != len(ids):
                raise CollectionError("collector_config_invalid")
        expected = profile.get("expectedEmailHash")
        if expected is not None and (not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected)):
            raise CollectionError("collector_config_invalid")
        if profile["provider"] in {"claude", "codex"} and not expected:
            raise CollectionError("expected_account_identity_required")
        if profile.get("configDir") is not None and (profile["provider"] != "claude" or not isinstance(profile["configDir"], str)):
            raise CollectionError("profile_directory_unsupported")
        if "apiKeyEnv" in profile and (profile["provider"] != "zai" or profile["apiKeyEnv"] != ZAI_KEY_ENV):
            raise CollectionError("collector_config_invalid")
        if not isinstance(profile.get("pools"), list) or len(profile["pools"]) > 24:
            raise CollectionError("collector_config_invalid")
        for pool in profile["pools"]:
            if not isinstance(pool, dict) or set(pool) - {"poolId", "limitId", "windows"} \
                    or not SLUG.fullmatch(str(pool.get("poolId", ""))) \
                    or not isinstance(pool.get("windows"), list) or not 1 <= len(pool["windows"]) <= 16:
                raise CollectionError("collector_config_invalid")
            keys = set()
            for window in pool["windows"]:
                if not isinstance(window, dict) or set(window) - {"key", "source", "label"} \
                        or any(not SLUG.fullmatch(str(window.get(field, ""))) for field in ("key", "source")):
                    raise CollectionError("collector_config_invalid")
                if window["key"] in keys:
                    raise CollectionError("duplicate_quota_window")
                keys.add(window["key"])
                if "label" in window and (not isinstance(window["label"], str) or len(window["label"]) > 120):
                    raise CollectionError("collector_config_invalid")
    return config


def check_registry(profile, overview):
    account = next((item for item in overview.get("accounts", []) if item.get("id") == profile["accountId"]), None)
    if not account or account.get("provider") not in REGISTRY_PROVIDERS.get(profile["provider"], {profile["provider"]}):
        raise CollectionError("registry_account_mismatch")
    expected = profile.get("expectedEmailHash")
    if expected and account.get("identityFingerprint") != expected:
        raise CollectionError("registry_identity_mismatch")
    for pool in profile["pools"]:
        registered = next((item for item in account.get("pools", []) if item.get("id") == pool["poolId"]), None)
        if not registered or set(registered.get("windowKeys", [])) != {w["key"] for w in pool["windows"]}:
            raise CollectionError("registry_quota_constraints_mismatch")
    for binding_id in profile_bindings(profile):
        if binding_id is None:
            continue
        binding = next((item for item in overview.get("bindings", []) if item.get("id") == binding_id), None)
        if not binding or binding.get("accountId") != profile["accountId"] or binding.get("profileRef") != profile["profileRef"]:
            raise CollectionError("registry_binding_mismatch")


def collect_profiles(config, overview=None, collectors=None):
    collectors = collectors or {"claude": collect_claude, "codex": collect_codex, "zai": collect_zai}
    observations, attempts = [], []
    for profile in config["profiles"]:
        started = time.monotonic()
        try:
            if overview is not None:
                check_registry(profile, overview)
            collector = collectors.get(profile["provider"])
            if collector is None:
                raise CollectionError("manual_usage_observation_required")
            result = collector(profile)
            errors = [row.get("error", "incomplete_provider_observation") for row in result if row["status"] != "success"]
            status = "failed" if errors else "success"
            error = errors[0] if errors else None
        except CollectionError as exc:
            result = failure_observations(profile, exc)
            status, error = ("login_required" if exc.login else "failed"), exc.code
        except Exception:
            # Provider stderr, config contents and transport exception strings may
            # contain credentials. Only stable internal diagnostic codes escape.
            error, status = "collector_internal_error", "failed"
            result = failure_observations(profile, CollectionError(error))
        observations.extend(result)
        attempts.append({"profileRef": profile["profileRef"], "provider": profile["provider"],
                         "status": status, "error": error, "durationMs": round((time.monotonic() - started) * 1000)})
    return {"schemaVersion": 1, "observations": observations, "attempts": attempts}


def load_mc_request():
    spec = importlib.util.spec_from_file_location("mc_private_api", MC_HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.request


def publish_observations(result, request):
    receipts = []
    for observation in result["observations"]:
        try:
            reply = request("/api/compute", "POST", {"action": "record_observation", "observation": observation},
                            observation["externalId"])
            if not isinstance(reply, dict) or not isinstance(reply.get("created"), bool) \
                    or reply.get("status") not in {"success", "failed", "login_required"}:
                raise CollectionError("publication_receipt_invalid")
            receipts.append({"externalId": observation["externalId"], "published": True,
                             "created": reply.get("created"), "status": reply.get("status")})
        except Exception:
            # Keep exact UUID/payload in output for reconciliation; no automatic retry.
            receipts.append({"externalId": observation["externalId"], "published": False,
                             "error": "publication_unconfirmed"})
    return receipts


def encode_result(result):
    encoded = json.dumps(result, indent=2, allow_nan=False) + "\n"
    if len(encoded.encode()) > MAX_BYTES:
        raise CollectionError("collector_output_too_large")
    return encoded


def persist_result(path, result):
    encoded = encode_result(result)
    if path:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(encoded)
    return encoded


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--profile", action="append", help="Collect only this configured opaque profile reference")
    parser.add_argument("--publish", action="store_true", help="Append observations to authenticated local Mission Control")
    parser.add_argument("--output", type=Path, help="Write sanitized receipt with restrictive permissions")
    args = parser.parse_args()
    try:
        if args.config.stat().st_size > MAX_BYTES:
            raise CollectionError("collector_config_too_large")
        config = validate_config(json.loads(args.config.read_text()))
        if args.profile:
            selected = set(args.profile)
            if not selected.issubset({p["profileRef"] for p in config["profiles"]}):
                raise CollectionError("profile_not_configured")
            config = {**config, "profiles": [p for p in config["profiles"] if p["profileRef"] in selected]}
        pacer = ApiPacer()
        request, overview, registry_unavailable = None, None, False
        if args.publish:
            try:
                request = pacer.wrap(load_mc_request())
                overview = request("/api/compute")
                if not isinstance(overview, dict) or not isinstance(overview.get("accounts"), list):
                    raise CollectionError("registry_unavailable")
            except Exception:
                registry_unavailable = True
        if registry_unavailable:
            def unavailable(profile):
                raise CollectionError("registry_unavailable")
            result = collect_profiles(config, collectors={p["provider"]: unavailable for p in config["profiles"]})
            result["publication"] = [{"externalId": row["externalId"], "published": False,
                                       "error": "registry_unavailable"} for row in result["observations"]]
        else:
            result = collect_profiles(config, overview, collectors={
                "claude": lambda profile: collect_claude(profile, pacer=pacer),
                "codex": lambda profile: collect_codex(profile, pacer=pacer),
                "zai": lambda profile: collect_zai(profile, pacer=pacer),
            })
        # Preserve UUIDs and exact payloads before a possibly interrupted append.
        persist_result(args.output, result)
        if request and not registry_unavailable:
            result["publication"] = publish_observations(result, request)
        encoded = persist_result(args.output, result)
        print(encoded, end="")
        return 1 if any(a["status"] != "success" for a in result["attempts"]) or \
            any(not p["published"] for p in result.get("publication", [])) else 0
    except CollectionError as exc:
        print(json.dumps({"error": exc.code}), file=sys.stderr)
        return 1
    except Exception:
        print(json.dumps({"error": "collector_configuration_or_transport_failed"}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
