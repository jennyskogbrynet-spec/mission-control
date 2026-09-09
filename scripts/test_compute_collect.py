#!/usr/bin/env python3
"""Protocol and attribution tests; no provider requests or model generations."""
import copy
import contextlib
import io
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("compute_collect", Path(__file__).with_name("compute-collect.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

EMAIL = "Example@Example.com"
HASH = m.fingerprint(EMAIL)
AT = "2026-09-08T10:00:00.000Z"


def profile(provider="claude"):
    return {"provider": provider, "profileRef": "example-default", "accountId": "example-account",
            "bindingId": "example-cli", "expectedEmailHash": HASH,
            "pools": [{"poolId": "example-pool", "windows": [
                {"key": "primary", "source": "primary"}, {"key": "secondary", "source": "secondary"}]}]}


def claude_auth(email=EMAIL):
    return {"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty",
            "subscriptionType": "max", "email": email}


def claude_usage():
    return [{"provider": "claude", "source": "claude", "usage": {"updatedAt": AT,
             "primary": {"usedPercent": 3, "resetsAt": "2026-09-08T15:00:00Z"},
             "secondary": {"usedPercent": 38, "resetsAt": None}, "tertiary": None}}]


def claude_runner(before=None, usage=None, after=None):
    replies = iter([before or claude_auth(), usage or claude_usage(), after or claude_auth()])
    return lambda command, env, deadline, **options: next(replies)


class IdentityTests(unittest.TestCase):
    def test_normalized_email_matches(self):
        self.assertEqual(m.verified_identity({"email": " " + EMAIL + " "}, {"email": EMAIL.lower()}, HASH), HASH)

    def test_account_race_fails_closed(self):
        with self.assertRaisesRegex(m.CollectionError, "account_changed_during_collection"):
            m.collect_claude(profile(), claude_runner(after=claude_auth("other@example.com")))

    def test_expected_account_mismatch(self):
        p = profile(); p["expectedEmailHash"] = "0" * 64
        with self.assertRaisesRegex(m.CollectionError, "unexpected_account_identity"):
            m.collect_claude(p, claude_runner())

    def test_missing_identity_not_inherited(self):
        after = claude_auth(); after.pop("email")
        with self.assertRaisesRegex(m.CollectionError, "account_identity_unavailable"):
            m.collect_claude(profile(), claude_runner(after=after))

    def test_quota_identity_must_match_auth_if_provider_exposes_it(self):
        usage = claude_usage(); usage[0]["usage"]["identity"] = {"accountEmail": "other@example.com"}
        with self.assertRaisesRegex(m.CollectionError, "quota_account_identity_mismatch"):
            m.collect_claude(profile(), claude_runner(usage=usage))

    def test_api_auth_is_not_subscription(self):
        auth = {**claude_auth(), "authMethod": "api_key", "apiProvider": "anthropic"}
        with self.assertRaisesRegex(m.CollectionError, "subscription_auth_not_verified"):
            m.collect_claude(profile(), claude_runner(before=auth, after=auth))

    def test_unproven_plan_and_plan_race_fail(self):
        for plan in (None, "free", "pro"):
            with self.subTest(plan=plan), self.assertRaises(m.CollectionError):
                m.collect_claude(profile(), claude_runner(after={**claude_auth(), "subscriptionType": plan}))

    def test_oauth_child_environment_never_rewrites_home(self):
        with patch.dict(os.environ, {"HOME": "/real-home", "CODEX_HOME": "/existing",
                        "ANTHROPIC_API_KEY": "secret", "ANTHROPIC_AUTH_TOKEN": "secret",
                        "OPENAI_API_KEY": "secret", "ANTHROPIC_BASE_URL": "https://elsewhere",
                        "CLAUDE_CODE_OAUTH_TOKEN": "secret", "CLAUDE_CONFIG_DIR": "/other",
                        "CODEXBAR_ALLOW_BROWSER_COOKIE_IMPORT": "1"}, clear=True):
            result = m.oauth_environment("claude", profile())
        self.assertEqual(result["HOME"], "/real-home")
        self.assertEqual(result["CODEX_HOME"], "/existing")
        self.assertEqual(result["CODEXBAR_ALLOW_BROWSER_COOKIE_IMPORT"], "0")
        self.assertNotIn("CLAUDE_CONFIG_DIR", result)
        self.assertFalse(any(k.startswith("ANTHROPIC_") for k in result))
        self.assertNotIn("OPENAI_API_KEY", result)


class QuotaTests(unittest.TestCase):
    def test_source_time_and_missing_resets_are_preserved(self):
        observations = m.collect_claude(profile(), claude_runner())
        quota = next(o for o in observations if o["kind"] == "quota")
        self.assertEqual(quota["observedAt"], AT)
        self.assertEqual(quota["windows"][1]["usedPercent"], 38)
        self.assertIsNone(quota["windows"][1]["resetsAt"])
        self.assertNotIn(EMAIL, json.dumps(observations))

    def test_missing_window_is_atomic_failure(self):
        usage = claude_usage(); usage[0]["usage"].pop("secondary")
        observations = m.collect_claude(profile(), claude_runner(usage=usage))
        quota = next(o for o in observations if o["kind"] == "quota")
        self.assertEqual(quota["status"], "failed")
        self.assertEqual(quota["windows"], [])

    def test_missing_fable_does_not_erase_general_pool(self):
        p = profile(); p["pools"].append({"poolId": "fable-pool", "windows": [{"key": "tertiary", "source": "tertiary"}]})
        quotas = [o for o in m.collect_claude(p, claude_runner()) if o["kind"] == "quota"]
        self.assertEqual([o["status"] for o in quotas], ["success", "failed"])

    def test_null_percentage_stays_unknown(self):
        usage = claude_usage(); usage[0]["usage"]["primary"]["usedPercent"] = None
        quota = next(o for o in m.collect_claude(profile(), claude_runner(usage=usage)) if o["kind"] == "quota")
        self.assertIsNone(quota["windows"][0]["usedPercent"])
        self.assertIsNone(quota["windows"][0]["remainingPercent"])

    def test_invalid_percentages_not_zero_or_unlimited(self):
        for value in (True, -1, 101, float("nan"), "0"):
            self.assertIsNone(m.number(value, percentage=True))

    def test_no_source_time_cannot_claim_current(self):
        usage = claude_usage(); usage[0]["usage"].pop("updatedAt")
        with self.assertRaisesRegex(m.CollectionError, "source_observation_time_missing"):
            m.collect_claude(profile(), claude_runner(usage=usage))

    def test_no_naive_or_guessed_timestamps(self):
        for value in ("2026-09-08T10:00:00", "tomorrow", True, float("inf"), None):
            self.assertIsNone(m.timestamp(value))
        self.assertEqual(m.timestamp(1788861600000, milliseconds=True), AT)

    def test_multiple_bindings_reuse_same_identity_sample(self):
        p = profile(); p.pop("bindingId"); p["bindingIds"] = ["one", "two"]
        accesses = [o for o in m.collect_claude(p, claude_runner()) if o["kind"] == "access"]
        self.assertEqual([o["bindingId"] for o in accesses], ["one", "two"])
        self.assertTrue(all(o["identityFingerprint"] == HASH for o in accesses))


class CodexTests(unittest.TestCase):
    def fake_factory(self, before=None, after=None, limits=None):
        account = {"type": "chatgpt", "email": EMAIL, "planType": "pro"}
        self.calls = []
        outer = self

        class Fake:
            def __init__(self, *args): pass
            def rpc(self, ident, method, params):
                outer.calls.append(method)
                return {1: {}, 2: {"account": before or account}, 3: limits or {
                    "rateLimitsByLimitId": {"codex": {"primary": {"usedPercent": 32, "resetsAt": 1789435576}},
                        "codex_bengalfox": {"primary": {"usedPercent": 0}, "secondary": {"usedPercent": 1}}},
                    "rateLimitResetCredits": {"availableCount": 3}},
                    4: {"account": after or account}}[ident]
            def send(self, payload): outer.calls.append(payload["method"])
            def close(self): outer.calls.append("close")
        return Fake

    def test_distinct_codex_and_spark_pools(self):
        p = profile("codex"); p["pools"][0]["windows"] = [{"key": "primary", "source": "primary"}]
        p["pools"].append({"poolId": "spark", "limitId": "codex_bengalfox", "windows": [
            {"key": "primary", "source": "primary"}, {"key": "secondary", "source": "secondary"}]})
        result = m.collect_codex(p, self.fake_factory())
        quotas = [o for o in result if o["kind"] == "quota"]
        self.assertEqual(quotas[0]["windows"][0]["usedPercent"], 32)
        self.assertEqual(quotas[1]["windows"][0]["usedPercent"], 0)
        self.assertEqual(next(o for o in result if o["kind"] == "reset")["available"], 3)
        self.assertEqual(self.calls, ["initialize", "initialized", "account/read", "account/rateLimits/read", "account/read", "close"])

    def test_codex_identity_race_rejects_all_successes(self):
        with self.assertRaisesRegex(m.CollectionError, "account_changed_during_collection"):
            m.collect_codex(profile("codex"), self.fake_factory(after={"type": "chatgpt", "email": "other@example.com", "planType": "pro"}))


class ZaiTests(unittest.TestCase):
    def payload(self):
        return {"success": True, "data": {"level": "pro", "limits": [
            {"type": "TOKENS_LIMIT", "unit": 3, "number": 5, "percentage": 1, "nextResetTime": 1788874618356},
            {"type": "TOKENS_LIMIT", "unit": 6, "number": 1, "percentage": 0, "nextResetTime": 1789468281998},
            {"type": "TIME_LIMIT", "unit": 5, "number": 1, "percentage": 0, "usage": 1000, "currentValue": 0}]}}

    def p(self):
        p = profile("zai"); p.pop("expectedEmailHash"); p["pools"][0]["windows"] = [
            {"key": "primary", "source": "TOKENS_LIMIT:3:5"},
            {"key": "secondary", "source": "TOKENS_LIMIT:6:1"},
            {"key": "mcp", "source": "TIME_LIMIT:5:1"}]
        return p

    @patch.dict(os.environ, {"ZAI_API_KEY": "TEST_SECRET_DO_NOT_PRINT"})
    def test_all_windows_without_fake_account_access_or_tokens(self):
        observations = m.collect_zai(self.p(), lambda key: self.payload())
        self.assertEqual([o["kind"] for o in observations], ["quota"])
        windows = observations[0]["windows"]
        self.assertEqual([w["usedPercent"] for w in windows], [1, 0, 0])
        self.assertEqual(windows[2]["unit"], "calls")
        self.assertEqual(windows[2]["limit"], 1000)
        self.assertIsNone(windows[0]["limit"])
        self.assertEqual(windows[0]["unit"], "provider_units")
        self.assertNotIn("TEST_SECRET", json.dumps(observations))

    @patch.dict(os.environ, {"ZAI_API_KEY": "TEST_SECRET_DO_NOT_PRINT"})
    def test_duplicate_source_key_is_not_silently_overwritten(self):
        payload = self.payload(); payload["data"]["limits"].append(payload["data"]["limits"][0])
        with self.assertRaisesRegex(m.CollectionError, "ambiguous_quota_window"):
            m.collect_zai(self.p(), lambda key: payload)

    @patch.dict(os.environ, {"ZAI_API_KEY": "TEST_SECRET_DO_NOT_PRINT"})
    def test_unknown_new_type_cannot_replace_known_window(self):
        payload = self.payload(); payload["data"]["limits"][0]["type"] = "NEW_LIMIT"
        self.assertEqual(m.collect_zai(self.p(), lambda key: payload)[0]["status"], "failed")

    @patch.dict(os.environ, {}, clear=True)
    def test_missing_key_is_login_required(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(m, "OPENCLAW_ENV", Path(folder) / ".env"), \
                self.assertRaises(m.CollectionError) as error:
            m.collect_zai(self.p(), lambda key: self.fail("must not fetch"))
        self.assertTrue(error.exception.login)


class CredentialTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.path = Path(self.folder.name) / ".env"

    def read(self, contents, environ=None):
        self.path.write_text(contents)
        return m.read_zai_api_key(environ=environ or {}, dotenv_path=self.path)

    def test_environment_wins_without_reading_file(self):
        with patch.object(Path, "open", side_effect=AssertionError("must not read fallback")):
            self.assertEqual(m.read_zai_api_key(environ={"ZAI_API_KEY": "ENV_SECRET"}), "ENV_SECRET")

    def test_explicit_empty_environment_does_not_select_another_key(self):
        with self.assertRaisesRegex(m.CollectionError, "provider_api_key_unavailable"):
            self.read("ZAI_API_KEY=FILE_SECRET", {"ZAI_API_KEY": ""})

    def test_literal_unquoted_quoted_and_export_assignments(self):
        for assignment in ("ZAI_API_KEY=FILE_SECRET", "export ZAI_API_KEY='FILE_SECRET'",
                           ' ZAI_API_KEY = "FILE_SECRET" # local note', "ZAI_API_KEY=FILE_SECRET # note"):
            with self.subTest(assignment=assignment):
                self.assertEqual(self.read(assignment), "FILE_SECRET")

    def test_exact_name_only_and_no_shell_execution(self):
        marker = Path(self.folder.name) / "must-not-exist"
        contents = (f"UNRELATED=$(touch {marker})\nsource /other/file\n"
                    "# ZAI_API_KEY=COMMENT_SECRET\nPREFIX_ZAI_API_KEY=WRONG_SECRET\n"
                    "ZAI_API_KEY_OTHER=WRONG_SECRET\nZAI_API_KEY=FILE_SECRET\n")
        self.assertEqual(self.read(contents), "FILE_SECRET")
        self.assertFalse(marker.exists())
        with self.assertRaisesRegex(m.CollectionError, "collector_config_invalid"):
            m.read_zai_api_key("OTHER_SECRET", environ={"OTHER_SECRET": "SECRET"}, dotenv_path=self.path)

    def test_expressions_escapes_and_multiline_values_fail_without_key_output(self):
        for value in ('"${OTHER_SECRET}"', "`printf SECRET`", "$(printf SECRET)",
                      '"SECRET\\nVALUE"', '"SECRET\nVALUE"', "'SECRET VALUE'", "'SECRET"):
            with self.subTest(value=value), self.assertRaises(m.CollectionError) as error:
                self.read("ZAI_API_KEY=" + value)
            self.assertNotIn("SECRET", str(error.exception))

    def test_duplicate_missing_unreadable_and_oversized_files_fail_closed(self):
        cases = [("ZAI_API_KEY=ONE_SECRET\nZAI_API_KEY=TWO_SECRET", "ambiguous"),
                 ("OTHER=SECRET", "unavailable"), ("ZAI_API_KEY=", "invalid")]
        for contents, code in cases:
            with self.subTest(code=code), self.assertRaisesRegex(m.CollectionError, code):
                self.read(contents)
        with patch.object(m, "MAX_ENV_BYTES", 10), self.assertRaisesRegex(m.CollectionError, "file_invalid"):
            self.read("ZAI_API_KEY=LONG_SECRET")
        self.path.write_bytes(b"ZAI_API_KEY=\xff")
        with self.assertRaisesRegex(m.CollectionError, "file_unreadable"):
            m.read_zai_api_key(environ={}, dotenv_path=self.path)
        with patch.object(Path, "open", side_effect=PermissionError("SECRET")), \
                self.assertRaisesRegex(m.CollectionError, "^provider_api_key_file_unreadable$"):
            m.read_zai_api_key(environ={}, dotenv_path=self.path)

    def test_config_rejects_other_secret_names_and_paths(self):
        for name in ("OPENAI_API_KEY", "ZAI_API_KEY_OTHER", "../.env", None, 5):
            p = profile("zai"); p["apiKeyEnv"] = name
            with self.subTest(name=name), self.assertRaisesRegex(m.CollectionError, "collector_config_invalid"):
                m.validate_config({"version": 1, "profiles": [p]})
        p = profile("zai"); p["apiKeyEnv"] = "ZAI_API_KEY"
        self.assertEqual(m.validate_config({"version": 1, "profiles": [p]})["profiles"][0], p)

    def test_unattended_fallback_reaches_fetcher_without_leaking_key(self):
        self.path.write_text("ZAI_API_KEY=PRIVATE_FIXTURE_SECRET\n")
        seen = []
        def fetch(key):
            seen.append(key)
            return ZaiTests().payload()
        with patch.dict(os.environ, {}, clear=True), patch.object(m, "OPENCLAW_ENV", self.path):
            result = m.collect_zai(ZaiTests().p(), fetch)
        self.assertEqual(seen, ["PRIVATE_FIXTURE_SECRET"])
        self.assertEqual(result[0]["status"], "success")
        self.assertNotIn("PRIVATE_FIXTURE_SECRET", m.encode_result(result))

    def test_provider_exception_cannot_echo_fallback_key(self):
        self.path.write_text("ZAI_API_KEY=PRIVATE_FIXTURE_SECRET\n")
        def fetch(key):
            raise RuntimeError(key)
        with patch.dict(os.environ, {}, clear=True), patch.object(m, "OPENCLAW_ENV", self.path):
            result = m.collect_profiles({"profiles": [ZaiTests().p()]},
                collectors={"zai": lambda p: m.collect_zai(p, fetch)})
        self.assertEqual(result["attempts"][0]["error"], "collector_internal_error")
        self.assertNotIn("PRIVATE_FIXTURE_SECRET", m.encode_result(result))


class PacingTests(unittest.TestCase):
    def setUp(self):
        self.now = 100
        self.sleeps = []
        self.pacer = m.ApiPacer(clock=lambda: self.now, sleep=self.sleep)

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds

    def test_spacing_accounts_for_elapsed_time_and_failed_calls_without_retry(self):
        calls = []
        def request():
            calls.append(self.now)
            if len(calls) == 2:
                raise RuntimeError("failed request")
        paced = self.pacer.wrap(request)
        paced()
        self.now += 2
        with self.assertRaises(RuntimeError):
            paced()
        paced()
        self.now += 7
        paced()
        self.assertEqual(calls, [100, 105, 110, 117])
        self.assertEqual(self.sleeps, [3, 5])

    def test_each_provider_quota_read_uses_shared_pacer(self):
        self.pacer.wait()
        m.collect_claude(profile(), claude_runner(), pacer=self.pacer)
        m.collect_codex(profile("codex"), CodexTests().fake_factory(), pacer=self.pacer)
        m.collect_zai(ZaiTests().p(), lambda key: ZaiTests().payload(),
                      key_reader=lambda name: "FAKE_SECRET", pacer=self.pacer)
        self.assertEqual(self.sleeps, [5, 5, 5])

    def test_direct_main_shares_pacing_for_registry_provider_and_publication(self):
        calls = []
        p = ZaiTests().p()
        registry = {"accounts": [{"id": p["accountId"], "provider": "zai", "pools": [
            {"id": p["pools"][0]["poolId"], "windowKeys": [w["key"] for w in p["pools"][0]["windows"]]}]}],
            "bindings": [{"id": p["bindingId"], "accountId": p["accountId"], "profileRef": p["profileRef"]}]}
        def request(path, *args):
            calls.append(("mc", self.now))
            return {"created": True, "status": "success"} if args else registry
        def collect(p, pacer):
            pacer.wait()
            calls.append(("quota", self.now))
            return [m.base_observation(p, "quota", m.source_for("zai"), AT,
                    poolId=p["pools"][0]["poolId"], windows=[])]
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / "config.json"
            config.write_text(json.dumps({"version": 1, "profiles": [p]}))
            with patch.object(sys, "argv", ["compute-collect.py", "--config", str(config), "--publish"]), \
                    patch.object(m, "ApiPacer", return_value=self.pacer), \
                    patch.object(m, "load_mc_request", return_value=request), \
                    patch.object(m, "collect_zai", side_effect=collect), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(m.main(), 0)
        self.assertEqual(calls, [("mc", 100), ("quota", 105), ("mc", 110)])


class PublicationTests(unittest.TestCase):
    def registry(self):
        return {"accounts": [{"id": "example-account", "provider": "claude", "identityFingerprint": HASH,
                "pools": [{"id": "example-pool", "windowKeys": ["primary", "secondary"]}]}],
                "bindings": [{"id": "example-cli", "accountId": "example-account", "profileRef": "example-default"}]}

    def test_registry_identity_mismatch_blocks_provider_and_invalidates_access(self):
        registry = self.registry(); registry["accounts"][0]["identityFingerprint"] = "0" * 64
        result = m.collect_profiles({"profiles": [profile()]}, registry,
                    {"claude": lambda p: self.fail("must not run wrong account")})
        self.assertEqual(result["attempts"][0]["error"], "registry_identity_mismatch")
        self.assertTrue(all(o["status"] == "failed" for o in result["observations"]))
        self.assertFalse(next(o for o in result["observations"] if o["kind"] == "access")["identityVerified"])

    def test_registry_missing_required_constraint_blocks(self):
        registry = self.registry(); registry["accounts"][0]["pools"][0]["windowKeys"].append("model-limit")
        with self.assertRaisesRegex(m.CollectionError, "registry_quota_constraints_mismatch"):
            m.check_registry(profile(), registry)

    def test_registry_accepts_canonical_provider_not_other_provider(self):
        registry = self.registry(); registry["accounts"][0]["provider"] = "anthropic"
        m.check_registry(profile(), registry)
        registry["accounts"][0]["provider"] = "openai"
        with self.assertRaisesRegex(m.CollectionError, "registry_account_mismatch"):
            m.check_registry(profile(), registry)

    def test_observation_idempotence_and_changed_content(self):
        a = m.collect_claude(profile(), claude_runner())
        b = m.collect_claude(profile(), claude_runner())
        self.assertEqual(a, b)
        usage = claude_usage(); usage[0]["usage"]["primary"]["usedPercent"] = 4
        c = m.collect_claude(profile(), claude_runner(usage=usage))
        self.assertNotEqual(a[-1]["externalId"], c[-1]["externalId"])

    def test_publish_exact_payload_uuid_and_no_retry(self):
        result = {"observations": m.collect_claude(profile(), claude_runner())}
        calls = []
        def request(path, method, body, key):
            calls.append((path, method, copy.deepcopy(body), key))
            if len(calls) == 1: raise RuntimeError("SECRET provider output")
            return {"created": True, "status": "success"}
        receipts = m.publish_observations(result, request)
        self.assertEqual(len(calls), len(result["observations"]))
        self.assertFalse(receipts[0]["published"])
        self.assertEqual(calls[0][2]["observation"], result["observations"][0])
        self.assertEqual(calls[0][3], result["observations"][0]["externalId"])
        self.assertNotIn("SECRET", json.dumps(receipts))

    def test_failure_has_no_old_or_fabricated_quota_values(self):
        def bad(profile): raise RuntimeError("SECRET credential")
        result = m.collect_profiles({"profiles": [profile()]}, collectors={"claude": bad})
        quota = next(o for o in result["observations"] if o["kind"] == "quota")
        self.assertEqual(quota["windows"], [])
        self.assertNotIn("SECRET", json.dumps(result))

    def test_invalid_publication_receipt_not_reported_as_success(self):
        result = {"observations": m.collect_claude(profile(), claude_runner())}
        receipts = m.publish_observations(result, lambda *args: {"error": "not_saved"})
        self.assertTrue(all(not item["published"] for item in receipts))

    def test_manual_provider_fails_without_guessing(self):
        p = profile("grok"); p.pop("expectedEmailHash")
        result = m.collect_profiles({"profiles": [p]})
        self.assertEqual(result["attempts"][0]["error"], "manual_usage_observation_required")


class ProcessAndConfigTests(unittest.TestCase):
    def test_claude_quota_has_empty_neutral_cwd_without_changing_home_or_caller(self):
        caller_cwd = Path.cwd()
        quota_dirs = []
        expected_env = m.oauth_environment("claude", profile())
        def runner(command, env, deadline, *, cwd=None):
            self.assertEqual(Path.cwd(), caller_cwd)
            self.assertEqual(env, expected_env)
            if command[0] == "codexbar":
                folder = Path(cwd)
                quota_dirs.append(folder)
                self.assertNotEqual(folder, caller_cwd)
                self.assertEqual(list(folder.iterdir()), [])
                self.assertEqual(folder.stat().st_mode & 0o077, 0)
                return claude_usage()
            self.assertIsNone(cwd)
            return claude_auth()
        observations = m.collect_claude(profile(), runner)
        self.assertTrue(all(row["status"] == "success" for row in observations))
        self.assertEqual(len(quota_dirs), 1)
        self.assertFalse(quota_dirs[0].exists())
        self.assertEqual(Path.cwd(), caller_cwd)

    def test_neutral_quota_directory_is_removed_when_cli_fails(self):
        quota_dirs = []
        def runner(command, env, deadline, *, cwd=None):
            if command[0] == "codexbar":
                folder = Path(cwd); quota_dirs.append(folder)
                (folder / "temporary-cli-state").write_text("fixture")
                raise m.CollectionError("provider_cli_failed")
            return claude_auth()
        with self.assertRaisesRegex(m.CollectionError, "provider_cli_failed"):
            m.collect_claude(profile(), runner)
        self.assertEqual(len(quota_dirs), 1)
        self.assertFalse(quota_dirs[0].exists())

    def test_bounded_child_uses_supplied_cwd_and_preserves_oauth_environment(self):
        caller_cwd = Path.cwd()
        env = m.oauth_environment("claude", profile())
        with tempfile.TemporaryDirectory() as folder:
            result = m.command_json([sys.executable, "-c",
                "import json,os;print(json.dumps({'cwd':os.getcwd(),'home':os.environ.get('HOME')}))"],
                env, time.monotonic() + 2, cwd=folder)
            self.assertEqual(Path(result["cwd"]).resolve(), Path(folder).resolve())
            self.assertEqual(result["home"], env.get("HOME"))
        self.assertEqual(Path.cwd(), caller_cwd)

    def test_read_only_default_does_not_load_or_publish_to_mc(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / "config.json"
            config.write_text(json.dumps({"version": 1, "profiles": [profile()]}))
            with patch.object(sys, "argv", ["compute-collect.py", "--config", str(config)]), \
                    patch.object(m, "load_mc_request", side_effect=AssertionError("must stay read-only")), \
                    patch.object(m, "collect_profiles", return_value={"observations": [], "attempts": []}), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(m.main(), 0)

    def test_registry_outage_records_failed_attempt_and_never_publishes(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / "config.json"
            config.write_text(json.dumps({"version": 1, "profiles": [profile()]}))
            output = io.StringIO()
            with patch.object(sys, "argv", ["compute-collect.py", "--config", str(config), "--publish"]), \
                    patch.object(m, "load_mc_request", side_effect=RuntimeError("SECRET connection")), \
                    patch.object(m, "publish_observations", side_effect=AssertionError("no unchecked publication")), \
                    contextlib.redirect_stdout(output):
                self.assertEqual(m.main(), 1)
            result = json.loads(output.getvalue())
            self.assertEqual(result["attempts"][0]["error"], "registry_unavailable")
            self.assertTrue(all(row["status"] == "failed" for row in result["observations"]))
            self.assertNotIn("SECRET", output.getvalue())

    def test_process_output_bound_includes_stderr(self):
        with patch.object(m, "MAX_BYTES", 100), self.assertRaisesRegex(m.CollectionError, "provider_output_too_large"):
            m.command_json([sys.executable, "-c", "import sys;sys.stderr.write('x'*1000);print('{}')"], dict(os.environ), time.monotonic() + 2)

    def test_process_timeout(self):
        with self.assertRaisesRegex(m.CollectionError, "provider_timeout"):
            m.command_json([sys.executable, "-c", "import time;time.sleep(5)"], dict(os.environ), time.monotonic() + .1)

    def test_process_json_and_stderr_not_exposed(self):
        result = m.command_json([sys.executable, "-c", "import sys;sys.stderr.write('SECRET');print('{\"ok\":true}')"], dict(os.environ), time.monotonic() + 2)
        self.assertEqual(result, {"ok": True})

    def test_reject_credentials_and_ambiguous_profile_selection(self):
        for field, value in [("apiKey", "secret"), ("expectedEmailHash", HASH[:12]), ("bindingIds", ["a", "a"])]:
            config = {"version": 1, "profiles": [{**profile(), field: value}]}
            with self.subTest(field=field), self.assertRaises(m.CollectionError):
                m.validate_config(config)

    def test_codex_home_override_is_unsupported(self):
        p = profile("codex"); p["configDir"] = "/other"
        with self.assertRaisesRegex(m.CollectionError, "profile_directory_unsupported"):
            m.validate_config({"version": 1, "profiles": [p]})


if __name__ == "__main__":
    unittest.main()
