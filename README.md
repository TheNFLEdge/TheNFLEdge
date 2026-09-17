# TheNFLEdge
home of G.T.G. NFL Score projection algorithm and historical records

The NFL projection site and historical archive for G.T.G.'s PanaGeoTech formula.

## Weekly rotation design

`nfl_rotation_state.json` is the authoritative pointer to the active canonical issue. The numbered file, such as `nfle26-02.htm`, is the source of truth; `nfleTMP.htm` is a disposable viewport copy. The viewport may be annotated during the week, but it never selects a week, changes the handoff, or controls archiving.

Normal rotation is strictly sequential:

1. `npm run fetch:nfl` runs rotate mode, validates the manifest and canonical checksum, fetches ESPN data, and resolves the calendar target using schedule dates.
2. If the active issue is incomplete, rotation stops without archiving or generating a later week.
3. Once complete, final scores and W/ATS/O-U annotations are finalized in the canonical issue, its manifest checksum is updated, and `npm run archive:nfl` moves it to `archives/2026/nfle26-NNF.htm` (for example, `nfle26-01F.htm`) and updates the season table.
4. `npm run generate:projections` validates that the handoff is exactly the next week, writes identical canonical and viewport files, and writes `nfl_rotation_state.json` last.

An anomalous ESPN completed event cannot advance the pointer. Normal rotation rejects a target more than one week beyond the validated active week.

## Modes and commands

```text
npm run fetch:nfl                         Scheduled rotate mode
npm run refresh:scores                   Update nfleTMP.htm only
npm run restore:viewport                 Copy validated canonical issue to viewport
NFL_CONFIRM_ROTATION_RECOVERY=yes npm run recover:rotation -- --week=2
npm run archive:nfl                      Archive the validated canonical issue
npm run generate:projections             Generate the next sequential issue
npm run rotate:nfl                       Run rotate, archive, and generation in order
```

Refresh mode fetches completed scores and changes only `nfleTMP.htm`. It does not read or write the rotation manifest or handoff, and it never modifies numbered issues or archives. If the viewport is malformed or missing, restore it from the validated canonical issue.

## Date resolution

Rotation groups regular-season ESPN events by week and uses each week's earliest and latest event dates. Defaults are `NFL_WEEK_LEAD_DAYS=3` and `NFL_WEEK_GRACE_HOURS=12`. `NFL_NOW_OVERRIDE` is available for deterministic tests. `NFL_TARGET_WEEK` is an explicit one-off override and must be an integer from 1 through 18; scheduled workflows do not set it. A non-sequential recovery requires `NFL_ALLOW_NONSEQUENTIAL_RECOVERY=true` and should be treated as an exceptional repair.

Completed ESPN events remain valid inputs for score finalization and rolling statistics, but their reported week numbers do not independently advance rotation.

## Recovery runbook

Inspect the state and publication files:

```text
Get-Content nfl_rotation_state.json
Get-Content nfl_data_handoff.json
Get-ChildItem nfle26-*.htm, archives/2026
```

If the viewport is stale or damaged:

```text
npm run restore:viewport
```

If the manifest is missing or invalid, first verify a canonical numbered issue and then explicitly recover it:

```text
$env:NFL_CONFIRM_ROTATION_RECOVERY = 'yes'
npm run recover:rotation -- --week=2
npm run restore:viewport
```

Do not recover from `nfleTMP.htm`, the highest numbered file, or a stale handoff. Do not leave `NFL_TARGET_WEEK` configured in scheduled automation.

## Tests

```text
python -m unittest discover -s tests
node --test tests/test_nfl_fetch.js
```

The tests cover calendar resolution, lead/grace windows, invalid overrides, sequential guardrails, manifest checksums, stray numbered files, viewport corruption, score annotation, archive validation, and Week 2 projection behavior.
