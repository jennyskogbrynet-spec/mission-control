import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('adapter', Path(__file__).with_name('import-skill-analytics.py'))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)

INVENTORY = {'skills': [{'id': '1234567890abcdef', 'name': 'shared', 'words': 20, 'bytes': 100, 'canonical_path': '/private/a', 'origins': [{'kind': 'cache', 'status': 'enabled_config', 'path': '/private/a'}]}, {'id': '2234567890abcdef', 'name': 'shared', 'words': 30, 'bytes': 200, 'origins': []}]}
OBSERVATION = {'skill_id': '1234567890abcdef', 'name': 'shared', 'days_7': 0, 'days_30': 1, 'days_90': 1, 'unique_sessions': 1, 'targeted_reads': 1, 'last_seen': '2026-09-12T20:00:00+00:00'}
COVERAGE = [{'runtime': 'codex', 'start': '2026-06-01T00:00:00Z', 'end': '2026-09-12T20:00:00Z', 'files_parsed': 1}]


class SnapshotImportTests(unittest.TestCase):
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

    def test_duplicate_aggregate_ids_are_rejected(self):
        with self.assertRaises(ValueError):
            adapter.make_snapshot(INVENTORY, {'skills': [OBSERVATION, OBSERVATION], 'coverage': COVERAGE})


if __name__ == '__main__':
    unittest.main()
