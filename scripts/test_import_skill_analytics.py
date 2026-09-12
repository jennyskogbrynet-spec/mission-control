import importlib.util
from pathlib import Path
import unittest
import copy
import json
import subprocess
import tempfile

spec = importlib.util.spec_from_file_location('adapter', Path(__file__).with_name('import-skill-analytics.py'))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)

INVENTORY = {'skills': [{'id': '1234567890abcdef', 'name': 'shared', 'words': 20, 'bytes': 100, 'canonical_path': '/private/a', 'origins': [{'kind': 'cache', 'status': 'enabled_config', 'path': '/private/a'}]}, {'id': '2234567890abcdef', 'name': 'shared', 'words': 30, 'bytes': 200, 'origins': []}]}
OBSERVATION = {'skill_id': '1234567890abcdef', 'name': 'shared', 'days_7': 0, 'days_30': 1, 'days_90': 1, 'unique_sessions': 1, 'targeted_reads': 1, 'last_seen': '2026-09-12T20:00:00+00:00'}
COVERAGE = [{'runtime': 'codex', 'start': '2026-06-01T00:00:00Z', 'end': '2026-09-12T20:00:00Z', 'files_parsed': 1}]


class SnapshotImportTests(unittest.TestCase):
    def test_pretty_published_bytes_are_the_size_boundary(self):
        row = {'id': '1234567890abcdef', 'name': 'x' * 300, 'origins': [], 'status': [], 'categories': {}, 'lastUse': None, 'days7': None, 'days30': None, 'days90': None, 'sessions': None, 'words': 20, 'bytes': 100, 'flags': ['x' * 100] * 3, 'proposal': 'x' * 300}
        snapshot = adapter.make_snapshot(INVENTORY)
        snapshot['skills'] = [{**row, 'id': f'{index:016x}'} for index in range(9000)]
        self.assertLess(len(json.dumps(snapshot, ensure_ascii=False).encode('utf8')), 10 * 1024 * 1024)
        self.assertGreater(len((json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n').encode('utf8')), 10 * 1024 * 1024)
        with self.assertRaises(ValueError): adapter.validate_snapshot(snapshot)
        with self.assertRaises(ValueError): adapter.serialize_snapshot(snapshot)

    def test_unavailable_hook_none_records_preserves_native_partial(self):
        result = adapter.make_snapshot(INVENTORY, {'skills': [{**OBSERVATION, 'supplemental_hook_observations': None}], 'coverage': COVERAGE + [{'runtime': 'claude_hook', 'records': None, 'files_discovered': None, 'readable': False}]})
        self.assertEqual(result['coverage']['status'], 'partial')
        self.assertEqual(result['skills'][0]['days7'], 0)
        self.assertNotIn('supplemental_hook', result['skills'][0]['categories'])
        self.assertEqual(adapter.validate_snapshot(result)['coverage']['sources'], ['codex'])
    def test_full_shared_schema_rejects_malformed_counts_ids_and_paths(self):
        valid = adapter.make_snapshot(INVENTORY, {'skills': [OBSERVATION], 'coverage': COVERAGE})
        self.assertEqual(adapter.validate_snapshot(valid)['version'], 1)
        for value in (-1, True, 1.5, '2'):
            for field in ('days7', 'days30', 'days90', 'sessions', 'words', 'bytes'):
                bad = copy.deepcopy(valid); bad['skills'][0][field] = value
                with self.assertRaisesRegex(ValueError, '^Invalid skill analytics snapshot$'):
                    adapter.validate_snapshot(bad)
        for field in ('name', 'proposal'):
            bad = copy.deepcopy(valid); bad['skills'][0][field] = '/synthetic/private/SKILL.md'
            with self.assertRaises(ValueError): adapter.validate_snapshot(bad)
        for field in ('origins', 'status', 'flags'):
            bad = copy.deepcopy(valid); bad['skills'][0][field] = ['/synthetic/private/SKILL.md']
            with self.assertRaises(ValueError): adapter.validate_snapshot(bad)
        for field in ('sources', 'limitations'):
            bad = copy.deepcopy(valid); bad['coverage'][field] = ['/synthetic/private/SKILL.md']
            with self.assertRaises(ValueError): adapter.validate_snapshot(bad)
        for ids in (['bad', '2234567890abcdef'], ['1234567890abcdef'] * 2):
            bad = copy.deepcopy(valid)
            for row, ident in zip(bad['skills'], ids): row['id'] = ident
            with self.assertRaises(ValueError): adapter.validate_snapshot(bad)

    def test_invalid_import_preserves_previous_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory); inventory = copy.deepcopy(INVENTORY)
            inventory['skills'][0]['words'] = True
            (path / 'inventory.json').write_text(json.dumps(inventory))
            output = path / 'snapshot.json'; output.write_text('previous-valid-data')
            result = subprocess.run(['python3', str(Path(adapter.__file__)), '--inventory', str(path / 'inventory.json'), '--output', str(output)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stderr.strip(), 'Invalid skill analytics snapshot')
            self.assertEqual(output.read_text(), 'previous-valid-data')
            self.assertFalse(output.with_suffix('.tmp').exists())
    def test_missing_or_empty_coverage_is_unknown(self):
        for usage in (None, {'skills': [OBSERVATION], 'coverage': []}):
            result = adapter.make_snapshot(INVENTORY, usage)
            self.assertEqual(result['coverage']['status'], 'unavailable')
            self.assertIsNone(result['skills'][0]['days7'])
            self.assertEqual(result['skills'][0]['categories'], {})

    def test_join_by_id_does_not_attribute_ambiguous_name(self):
        result = adapter.make_snapshot(INVENTORY, {'skills': [OBSERVATION], 'coverage': COVERAGE})
        self.assertEqual(result['skills'][0]['days7'], 0)
        self.assertEqual(result['skills'][0]['categories']['document_read'], 1)
        self.assertNotIn('script_execution', result['skills'][0]['categories'])
        self.assertEqual(result['skills'][0]['lastUse'], '2026-09-12T20:00:00Z')
        self.assertIsNone(result['skills'][1]['days7'])
        self.assertNotIn('/private', str(result))
        self.assertEqual(result['coverage']['status'], 'partial')

    def test_hook_only_cannot_create_native_zero_counts(self):
        result = adapter.make_snapshot(INVENTORY, {'skills': [OBSERVATION], 'coverage': [{'runtime': 'claude_hook', 'records': 1, 'start': '2026-09-12T20:00:00Z'}]})
        self.assertIsNone(result['skills'][0]['days7'])

    def test_loader_is_visible_but_never_native_coverage(self):
        obs = {**OBSERVATION, 'direct_tool_invocations': 2, 'wrapped_command_attempts': 1, 'supplemental_loader_counter_total': 900}
        result = adapter.make_snapshot(INVENTORY, {'skills': [obs], 'coverage': [{'runtime': 'openclaw_loader_counters', 'kind': 'supplemental_cumulative_counter', 'readable': True, 'start': '2026-09-12T20:00:00Z', 'files_parsed': 1}]})
        self.assertIsNone(result['skills'][0]['days7'])
        self.assertEqual(result['skills'][0]['categories'], {'supplemental_loader_counter_total': 900})
        self.assertEqual(result['coverage']['status'], 'unavailable')
        with_native = adapter.make_snapshot(INVENTORY, {'skills': [obs], 'coverage': COVERAGE})
        self.assertEqual(with_native['skills'][0]['categories']['wrapped_command_attempts'], 1)
        self.assertEqual(with_native['skills'][0]['categories']['direct_tool_invocations'], 2)
        missing = adapter.make_snapshot(INVENTORY, {'skills': [{**obs, 'supplemental_loader_counter_total': None, 'supplemental_hook_observations': None}], 'coverage': COVERAGE + [{'runtime': 'openclaw_loader_counters', 'readable': True}, {'runtime': 'claude_hook', 'files_discovered': 1}]})
        self.assertNotIn('supplemental_loader_counter_total', missing['skills'][0]['categories'])
        self.assertNotIn('supplemental_hook', missing['skills'][0]['categories'])
        self.assertEqual(adapter.validate_snapshot(missing)['skills'][0]['days7'], 0)

    def test_duplicate_aggregate_ids_are_rejected(self):
        with self.assertRaises(ValueError):
            adapter.make_snapshot(INVENTORY, {'skills': [OBSERVATION, OBSERVATION], 'coverage': COVERAGE})


if __name__ == '__main__':
    unittest.main()
