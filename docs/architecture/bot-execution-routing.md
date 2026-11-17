# Bot roles and execution routing

Bot roles (represented internally by BotConfig) define personality, instructions, tools, avatars, and dispatch hints. The flat pre-#439 execution fields (`codingAgent`, `model`, `effort`) are still ignored on load and removed on save.

A Bot may opt into an explicit override with `execution: { agent?, model? }` in its `config.json` (set from the Bot editor's "Runs on" row). When present it wins over the chat setting and the gateway Default for every run of that Bot: direct Bot chats, `/bot`, and every team mode. An agent-only override runs on that agent's default model; a model-only override applies to the agent the run would otherwise use; a model that does not resolve logs a warning and runs on the agent's default model. Reasoning effort is not overridable per Bot. `gateway.resolveBotExecution` is the single resolver.

Without an override, Bot execution uses explicit chat settings or the gateway Default, whose agent is the first fallback entry. Teams use the same execution settings, including resumed steps. Existing failure fallback remains independent of role definitions. There is no new model-selection call before ordinary requests.

| Owner | Tasks |
| --- | --- |
| Aide | Titles, context summaries, task briefs, turn digests, Bot role drafts, team completion recaps, voice cleanup, quick questions, and existing bounded classifications |
| Advisor | Auto-team and group coordination, roundtables, conditional flow judging, optional stuck-agent guidance, and skill distillation |
| Default | Ordinary conversations, coding, file changes, and Bot task execution |

This change moves role generation and the existing sequential-team shortcut classifier to Aide, and group coordination to Advisor. The classifier makes one attempt with an eight-second limit; failure retains the full workflow. Single-member teams skip classification. Aide and Advisor inherit existing gateway defaults when their own settings are unset.
