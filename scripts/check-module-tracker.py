#!/usr/bin/env python3
"""Validate the canonical module registry against its implementation backlog."""
import csv
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
registry = json.loads((root / 'docs/freehr-module-registry.json').read_text())
rows = list(csv.DictReader((root / 'docs/freehr-implementation-backlog.csv').open()))
errors, features, modules = [], {}, set()
for module in registry['modules']:
    if module['id'] in modules:
        errors.append('Duplicate module: ' + module['id'])
    modules.add(module['id'])
    for feature in module['features']:
        key = feature['id']
        if key in features:
            errors.append('Duplicate feature: ' + key)
        features[key] = (module['id'], feature)
        evidence = feature.get('evidence_ref')
        if evidence and not (root / 'docs' / evidence).is_file():
            errors.append('Missing evidence for ' + key + ': ' + evidence)
seen = set()
for row in rows:
    key = row['package_id']
    if key in seen:
        errors.append('Duplicate backlog package: ' + key)
    seen.add(key)
    if key not in features:
        errors.append('Unknown backlog package: ' + key)
        continue
    module_id, feature = features[key]
    if row['module_id'] != module_id or row['status'] != feature['status']:
        errors.append('Registry/backlog mismatch: ' + key)
for key in features.keys() - seen:
    errors.append('Missing backlog package: ' + key)
# The comprehensive remaining register must cover every unfinished package once.
remaining = list(csv.DictReader((root / 'docs/REMAINING_IMPLEMENTATION_REGISTER.csv').open()))
remaining_seen = set()
expected_remaining = {key for key, (_, feature) in features.items() if feature['status'] != 'complete'}
for row in remaining:
    key = row['package_id']
    if key in remaining_seen:
        errors.append('Duplicate remaining package: ' + key)
    remaining_seen.add(key)
    if key not in expected_remaining:
        errors.append('Unknown or complete remaining package: ' + key)
        continue
    module_id, feature = features[key]
    if (row['module_id'], row['status'], row['planned_scope'], row['evidence_ref']) != (module_id, feature['status'], feature['description'], feature.get('evidence_ref', '')):
        errors.append('Registry/remaining register mismatch: ' + key)
    if not row['full_module_acceptance_gate'].strip():
        errors.append('Missing remaining acceptance gate: ' + key)
for key in expected_remaining - remaining_seen:
    errors.append('Missing remaining package: ' + key)
if errors:
    raise SystemExit('\n'.join(errors))
print(f'PASS: {len(modules)} modules, {len(features)} unique feature packages, matching backlog/remaining statuses and existing evidence links.')
