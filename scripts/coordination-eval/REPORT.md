# Coordination token experiment

Model: codex / gpt-5.6-terra, effort medium. Baseline: 80071d138e6e65b63fff758663576d56ca2fe040.

This is a synthetic coordination workload, not the percentage saved across the whole application. All usage values below were returned by real model calls.

## Call elimination

| Scenario | Before calls | After calls | Before input / output | After input / output | Total-token reduction | Checks before / after |
|---|---:|---:|---:|---:|---:|---|
| single-edge | 1 | 0 | 17646 / 27 | 0 / 0 | 100.0% | pass / pass |
| title-reuse | 1 | 0 | 17576 / 7 | 0 / 0 | 100.0% | pass / pass |
| overview-three-reads | 3 | 1 | 55918 / 249 | 18063 / 168 | 67.5% | pass / pass |
| clean-team-summary | 2 | 1 | 35893 / 129 | 18184 / 81 | 49.3% | pass / pass |
| failed-team-summary | 1 | 1 | 17711 / 44 | 17711 / 49 | -0.0% | pass / pass |
| unchanged-three-polls | 3 | 1 | 53670 / 173 | 17890 / 42 | 66.7% | pass / pass |
| unused-closing | 1 | 0 | 18209 / 97 | 0 / 0 | 100.0% | pass / pass |
| **Total** | **12** | **4** | **216623 / 726** | **71848 / 340** | **66.8%** | |

## Compact output (same effort and transport)

| Variant | Calls | Input | Output | Total | Correct routing + required instruction | Median ms |
|---|---:|---:|---:|---:|---:|---:|
| baseline | 12 | 221912 | 1152 | 223064 | 12/12 | 11036 |
| compact | 12 | 221764 | 968 | 222732 | 12/12 | 10612 |

| Case | Baseline input / output | Compact input / output | Correct baseline / compact |
|---|---:|---:|---|
| first-implementation | 36348 / 164 | 36616 / 108 | 2/2 / 2/2 |
| first-docs | 36358 / 188 | 36626 / 177 | 2/2 / 2/2 |
| review-next | 36370 / 216 | 38394 / 150 | 2/2 / 2/2 |
| revision | 38144 / 204 | 36656 / 162 | 2/2 / 2/2 |
| human-question | 38316 / 225 | 36828 / 198 | 2/2 / 2/2 |
| complete | 36376 / 155 | 36644 / 173 | 2/2 / 2/2 |

## Scope and interpretation

- Counts are actual Codey adapter invocations in this synthetic replay, not production telemetry or provider-internal inference round trips. The workload intentionally exercises repeated reads/polls; savings depend on how frequently those occur in real chats.
- Workers are represented by fixed synthetic results. Worker coding tokens, production task classification, and end-to-end desktop interactions are not measured. The common task classification call that supplied the reused title is outside this comparison.
- Parallel polling replays three unchanged observations versus one; the production change-trigger behavior is verified separately by regression tests. Unused closing replays one former summary request versus zero.
- Baseline judge and finalizer run frozen original source. Cache/title use current production helpers versus their former unconditional calls. Same configured Aide model is deliberately used for every scenario to isolate the code changes.
- The configured Advisor (Claude Code / claude-fable-5-1) failed its canary without reported usage. Advisor figures here use the controlled Codex model and cannot establish savings or correctness on that unavailable model.
- Tokens are CLI-reported input/output, including CLI context overhead. Cached input/reasoning breakdown is not retained by this adapter. These are not a dollar-cost estimate; missing usage is unknown, not zero.
- All requests use fresh sessions, medium effort, no cross-model fallback or retry, and 30-second per-call limits. Global CLI context/cache/service variation remains; observed input overhead sometimes changes by roughly 1,756 tokens, larger than the compact-output savings. Variant order alternates. Output cases repeat six authored examples twice, not twelve independent examples.
- Compact candidate only changes output instructions and omitted empty/default fields. It is not a hard token cap and has NOT been enabled in production. Instruction, summary, completion and escalation semantics are scored as well as the Bot name.
- Runtime: codex-cli 0.160.1; Claude Code 2.1.299. Existing CLI configuration/global instructions apply. No production model configuration was changed.
- Files: results/calls.json contains raw prompts/answers/usage; canary.json records model availability; results/evaluated/ freezes the compiled modules under test; *.baseline freezes original source.

## Verification

Core: 713 tests; Gateway: 649 tests. Initial full runs had only sandbox permission failures (5 + 22); rerunning their affected files with required permissions passed all 8 + 22 tests. This combines full-suite results with targeted environment retries, not a single unrestricted full run.
Additional cache validation regression: malformed model output must not be cached as a permanent successful overview. Strict validation added for the Gateway cache path; legacy display-fallback behavior remains available. Three new Core cases and one Gateway cache integration case pass; Core/Gateway rebuild and desktop typecheck also pass.

## Decision

Keep call elimination. The measured coordination replay saves 66.8% of reported tokens (12 adapter calls become 4), with all seven scenario checks passing on both sides. This is workload-specific, not an application-wide percentage.

Do not enable the appended compact-output candidate: output falls from 1,152 to 968 tokens (16.0%), but total only falls from 223,064 to 222,732 (0.15%). Round 0 saves 2.5% while round 1 costs 2.3% more. Both variants pass all 12 scored cases; correctness on this small authored set does not establish general reliability. CLI input overhead and variation dominate. Hard token truncation was not tested and is not recommended for structured routing JSON because it can destroy the required fields.

## First-turn-only specialized instructions

A separate fresh paired experiment replaces the general Instructions section with a first-turn-specific schema; it does not append a second instruction block. Same task and roster, same model/effort. Two unique tasks repeated twice. Not enabled in production.

| Variant | Calls | Input | Output | Total | Correct |
|---|---:|---:|---:|---:|---:|
| baseline | 4 | 74438 | 351 | 74789 | 4/4 |
| specialized | 4 | 72654 | 181 | 72835 | 4/4 |

Total-token reduction: 2.6%. Raw evidence: results/first-turn.json. Treat this as a pilot for the first routing step only; no conclusion about revising workers, finalizing tasks, or escalating questions.

The specialized first-turn pilot reduces reported output from 351 to 181 tokens (48.4%) and total usage from 74,789 to 72,835 (2.6%). Both variants pass 4/4 scored samples (only two unique tasks). By round, total usage falls 2.5% and 2.7%. Each side also contains one larger CLI-context input, so the aggregate does not favor one side solely through that extra context. Retain this as a candidate rather than enabling it: broader first-turn assignments and the actually configured Advisor remain unvalidated. Replacing irrelevant first-turn instructions is more promising than appending output-limit instructions. Keep concrete worker instructions and the UI reason; do not reduce the result to a Bot name only.

Reproduction: build Core and Gateway, run `node scripts/coordination-eval/run.cjs <fresh-result-directory>` for the primary live experiment. The follow-up reads the default `results/calls.json` and writes a new `results/first-turn.json`; it refuses to overwrite existing evidence. `summarize.cjs` renders the default results. All live runners consume the user's configured CLI subscription/quota. The canary reads only configured model identities; secrets are not included in artifacts.

## Isolated PR verification

Rebased onto main `d4ed6532` with only the coordination changes included. Core: 715/715; Gateway: 631/631; desktop: 1,109/1,109. Core/Gateway builds, all-workspace typecheck, and lint pass (existing warnings remain). The initial desktop run lacked the Electron binary after installing dependencies without lifecycle scripts; installing that binary and rerunning the full desktop suite passed. Counts differ from the earlier working-directory runs because unrelated in-progress changes are excluded from this PR.

## Follow-up: scenario-specific JSON

The later production change replaces generic Advisor instructions with scenario-specific JSON guidance. See [SCENARIO-JSON.md](SCENARIO-JSON.md) for its separate paired experiment, the initial escalation failure, and the repair/retest evidence. This is distinct from the earlier appended-budget and first-turn-only candidates above.
