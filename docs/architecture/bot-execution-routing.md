# Bot roles and execution routing

Bot roles (represented internally by WorkerConfig) define personality, instructions, tools, avatars, and dispatch hints. They no longer bind an agent, model, or reasoning effort. Legacy execution fields are ignored on load and removed on save.

Ordinary Bot execution uses explicit chat settings or the gateway Default, whose agent is the first fallback entry. Teams use the same execution settings, including resumed steps. Existing failure fallback remains independent of role definitions. There is no new model-selection call before ordinary requests.

| Owner | Tasks |
| --- | --- |
| Aide | Titles, context summaries, task briefs, turn digests, Bot role drafts, team completion recaps, voice cleanup, quick questions, and existing bounded classifications |
| Advisor | Auto-team and group coordination, roundtables, conditional flow judging, optional stuck-agent guidance, and skill distillation |
| Default | Ordinary conversations, coding, file changes, and Bot task execution |

This change moves role generation and the existing sequential-team shortcut classifier to Aide, and group coordination to Advisor. The classifier makes one attempt with an eight-second limit; failure retains the full workflow. Single-member teams skip classification. Aide and Advisor inherit existing gateway defaults when their own settings are unset.
