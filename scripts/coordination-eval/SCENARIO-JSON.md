# Scenario-specific Advisor JSON

Production instructions now depend on the decision being made:

- First routing step: next, instruction, reason; no empty history summary or false/null placeholders. A no-work completion remains available.
- Continuing or revising work: preserve the last-output summary, concrete worker instruction and reason; completion still requires a final summary.
- Pending question: route to a teammate or explicitly escalate to the user. Do not present escalation as successful completion.
- Finalize: final summary including incomplete work and blockers; no next-worker fields.

This is prompt-level JSON guidance, not a provider-enforced schema or hard output-token cap. The existing parser still accepts legacy responses and normalizes omitted defaults. Models, effort, timeouts and fallback behavior are unchanged. Flow Judge and task classification already request small decision-specific JSON objects, so they are unchanged.

## Live checks

`scenario-json.cjs` compares the previous PR commit `9cff31c6` with the built production code. It uses Codex gpt-5.6-terra at medium effort, fresh sessions and alternating paired order. Worker evidence is synthetic. No worker execution or whole-application cost is measured. The configured Claude Advisor remains unvalidated.

Initial run (`results/scenario-json.json`):

| Variant | Calls | Input | Output | Total | Checks |
|---|---:|---:|---:|---:|---:|
| Baseline | 9 | 176292 | 880 | 177172 | 9/9 |
| Initial specialized candidate | 9 | 170452 | 769 | 171221 | 8/9 |

The initial candidate used 3.4% fewer reported tokens and 12.6% fewer output tokens, but **failed a user-escalation check**. It sent a reviewer to reconsider a blocker instead of asking the user for a private deployment destination. These savings do not establish an acceptable implementation by themselves. The original task concerned search rather than deployment, making that case somewhat ambiguous; the baseline escalated, and the final instructions explicitly preserve the intended user-only escalation behavior.

Fixed the pending-question instructions to resolve the question itself and escalate directly when evidence says only the user has the required information. The initial failure remains in the raw evidence. The remaining seven scenario prompts are unchanged from the initial run. The two changed question scenarios are repeated separately, twice each, against the same baseline.

## Regression checks

Core 723 tests and Gateway 631 tests passed before the final question-wording repair. The 17-test Advisor file passed again after that repair. Core/Gateway builds, all-workspace typecheck and lint passed; existing lint warnings remain.

Reproduce the whole paired check (consumes CLI quota):

```sh
npm run build:core
node scripts/coordination-eval/scenario-json.cjs /tmp/new-scenario-results.json
```

Focused repeat: add `escalate,teammate 2` after the output path. The runner refuses to overwrite existing results. Raw records include the exact prompts, answers, normalized decisions and adapter-reported usage. The checks cover a small authored set; they are not a general proof of routing reliability or a billing estimate. CLI context and cache variation still affect total input usage.

## Final pending-question repeat

`results/scenario-json-questions.json`: two distinct question scenarios, each repeated twice with the repaired production prompt.

| Variant | Calls | Input | Output | Total | Checks |
|---|---:|---:|---:|---:|---:|
| baseline | 4 | 77090 | 421 | 77511 | 4/4 |
| specialized | 4 | 75134 | 289 | 75423 | 4/4 |

Both variants pass all four checks. Reported total usage falls 2.7%; output falls 31.4%. Calls remain four versus four. These focused results do not replace a complete nine-scenario measurement of the final version or establish production-wide savings.
