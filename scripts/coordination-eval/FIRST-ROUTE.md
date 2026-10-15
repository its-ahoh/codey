# Automatic team first-route experiment

The production change admits only short, single-line explanation/definition/translation/summary requests through a conservative local gate. Recognized implementation, investigation, review, validation, planning, team-wide or compound requests go directly to Advisor. Unsupported languages/shapes and long requests also retain Advisor. The gate is an optimization heuristic, not a general intent classifier; Aide can reject requests it finds complex or unclear.

Aide returns only a roster name and short reason. The worker instruction is the original task verbatim. No worker is silently selected on failure: malformed, uncertain or failed Aide responses fall back once to Advisor. No Aide retries or cross-model fallback are used. Cancellation stops further routing. Later steps, completion, revision and user-question arbitration remain with Advisor. If Aide is not configured, behavior is unchanged.

## Live measurement

Six synthetic first-step scenarios, one pair each, alternating order, medium effort and fresh sessions. Both sides use Codex gpt-5.6-terra to isolate the prompt change. Configured Aide uses this model. The configured Claude Code / claude-fable-5-1 Advisor failed a fresh canary without usage; its real comparative cost and routing quality could not be measured. No configuration was changed.

| Scenario | Before calls | After calls | Before total tokens | After total tokens | After roles |
|---|---:|---:|---:|---:|---|
| explain | 1 | 1 | 20499 | 18673 | aide |
| translate | 1 | 1 | 18760 | 18645 | aide |
| chinese | 1 | 1 | 18749 | 18665 | aide |
| implement | 1 | 1 | 20512 | 18763 | advisor |
| compound | 1 | 1 | 18792 | 18760 | advisor |
| uncertain | 1 | 2 | 18805 | 37422 | aide, advisor |

Simple tasks: 3 → 3 calls; 58,008 → 55,983 reported input/output tokens (-3.5%).

Whole sample: 6 → 7 calls; 116,117 → 130,928 reported input/output tokens (+12.8%).

The 3.5% simple-task aggregate is dominated by roughly 1,756 extra CLI input tokens in one baseline request; it is not a stable estimate of prompt-only savings.

For the three simple tasks, first-step Advisor calls fall from three to zero and Aide calls rise from zero to three. This replaces calls rather than eliminating them. The unclear task correctly adds an Aide call before Advisor, and that overhead outweighs the small prompt savings across this particular six-case mix. Do not claim aggregate token savings. The intended benefit is moving straightforward decisions to the configured lightweight role; pricing/latency gains require validation on the actual Advisor model.

Complex-task prompts are unchanged. Their token counts still vary because CLI context/cache/service overhead varies; their measured difference is not an optimization saving. Worker input/output, later coordination calls and provider cache/reasoning breakdown are outside this measurement.

## Behavior checks

All optimized cases passed the authored routing/bypass/abstention checks. Baseline strict expected-name checks passed 5/6: the hash-table explanation went to writer rather than the expected coder. Its concrete instruction was appropriate, and the writer roster included user documentation. This is a valid alternative on manual inspection, not evidence of baseline failure or quality improvement. The original strict score and raw answers are retained. The unclear-roster case checks abstention and fallback invocation only, not the quality of the fallback Advisor answer.

Gateway full regression: 657 tests passed. After adding one disabled-Aide test, all 28 focused routing tests passed. Gateway build, all-workspace typecheck and lint pass (existing warnings remain). Tests cover original-task preservation, non-roster names, malformed/uncertain results, runner failure, disabled configuration, complex-task bypass, cancellation and continued Advisor completion handling.

## Reproduce

Build Core/Gateway, then run `node scripts/coordination-eval/first-route.cjs /tmp/fresh-first-route-results.json`. Live runs consume CLI quota and refuse to overwrite existing evidence. Exact prompts, outputs, normalized decisions, roles and token usage are in `results/first-route.json`. This small authored set is not proof of general routing reliability.
