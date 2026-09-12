#!/usr/bin/env python3
"""Convert approved local collector aggregates into a path-free MC v1 snapshot."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path


def iso(value):
    if not value:
        return None
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(dt.timezone.utc).isoformat().replace('+00:00', 'Z')


def make_snapshot(inventory, usage=None):
    coverage = (usage or {}).get('coverage', [])
    native_coverage = [c for c in coverage if c.get('runtime') != 'claude_hook' and c.get('start') and (c.get('files_parsed', 0) + c.get('files_cached', 0) > 0)]
    aggregates = {}
    for row in (usage or {}).get('skills', []) if native_coverage else []:
        if row['skill_id'] in aggregates:
            raise ValueError('Duplicate skill_id in usage aggregates')
        aggregates[row['skill_id']] = row
    rows = []
    for skill in inventory['skills']:
        observed = aggregates.get(skill['id'])
        flags = list(skill.get('findings', []))
        if skill.get('name_collision_ids'):
            flags.append('name_collision_review')
        if skill.get('duplicate_group'):
            flags.append('duplicate_content_review')
        categories = {}
        if observed:
            categories = {key: observed[source] for key, source in [
                ('explicit_invocation', 'explicit_skill_invocations'),
                ('document_read', 'targeted_reads'), ('script_execution', 'script_executions'),
                ('completed_tool_calls', 'completed_tool_calls'), ('failed_tool_calls', 'failed_tool_calls'),
                ('unknown_outcome', 'unknown_outcome'), ('supplemental_hook', 'supplemental_hook_observations'),
            ] if source in observed}
        proposal = 'Vurder flaggene manuelt' if flags else 'Behold; vurder ved neste gjennomgang'
        if observed and observed.get('days_90') == 0:
            proposal = 'Ingen observert bruk på 90 dager; vurder relevans og avhengigheter før pensjonering'
        origins = skill.get('origins', [])
        rows.append({
            'id': skill['id'], 'name': skill['name'],
            'origins': sorted({str(o.get('kind', 'unknown')) for o in origins}),
            'status': sorted({str(o.get('status', 'unknown')) for o in origins}),
            'categories': categories, 'lastUse': iso(observed.get('last_seen')) if observed else None,
            'days7': observed.get('days_7') if observed else None,
            'days30': observed.get('days_30') if observed else None,
            'days90': observed.get('days_90') if observed else None,
            'sessions': observed.get('unique_sessions') if observed else None,
            'words': skill['words'], 'bytes': skill['bytes'], 'flags': flags, 'proposal': proposal,
        })
    return {
        'version': 1, 'workspaceId': 1,
        'generatedAt': iso((usage or {}).get('as_of')) or dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z'),
        'coverage': {
            'status': 'partial' if native_coverage else 'unavailable',
            'sources': sorted({str(c['runtime']) for c in native_coverage}),
            'limitations': [
                'Kun lokale, innsamlede spor er dekket; uobserverte samtaler og eldre historikk kan mangle.',
                'Dagtall summerer eksplisitte invokasjoner, dokumentlesing og skriptkjøring; kategoriene vises separat.',
                'Hook-observasjoner er supplerende og inngår ikke i dagtall eller sesjonstall.',
                'Verktøystatus dokumenterer verktøykallet; den beviser ikke effekt eller kvalitet på skillen.',
                'Ingen kostnadsbesparelse eller tokenbruk er målt. Pensjonering krever manuell vurdering.',
                'enabled_config viser aktivert plugin-ID; det beviser ikke at en bestemt cache-versjon er aktiv.',
            ] + ([f"Innlesing: {usage['native_events']} native observasjoner; {usage.get('aligned_native_events', 'ukjent')} koblet til skill-ID, {usage.get('ambiguous_native_events', 'ukjent')} tvetydige og {usage.get('unmapped_native_events', 'ukjent')} uten treff. Tvetydige og manglende treff er ikke fordelt på rader."] if 'native_events' in usage else []) + [f"{c['runtime']}: {iso(c['start'])} til {iso(c.get('end')) or 'ukjent'}; {c.get('files_parsed', 0) + c.get('files_cached', 0)} filer lest, {c.get('files_skipped_privacy', 0)} skjermet, {c.get('compressed_files_not_parsed', 0)} komprimerte filer utelatt." for c in native_coverage] if native_coverage else ['Brukshistorikk mangler; alle brukstall er ukjente.'],
        }, 'skills': rows,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', required=True, type=Path)
    parser.add_argument('--usage', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    inventory = json.loads(args.inventory.read_text())
    usage = json.loads(args.usage.read_text()) if args.usage else None
    snapshot = make_snapshot(inventory, usage)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temp = args.output.with_suffix('.tmp')
    temp.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n')
    os.chmod(temp, 0o600)
    temp.replace(args.output)
    print(f"Imported {len(snapshot['skills'])} skills; coverage={snapshot['coverage']['status']}")


if __name__ == '__main__':
    main()
