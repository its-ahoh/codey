# End-to-end tests

Playwright starts the real Codey app (Electron main process and built renderer)
and drives it. Each test gets a fresh copy that runs beside the user's own Codey:

- `HOME` and `CODEY_TEST_HOME` point at a temp folder, so `~/.codey`, agent
  configs, skills and Electron user data are never shared.
- The copy has its own single-instance lock and loads the built renderer.
- No global hotkeys, login item, auto-update, voice helper or permission dialogs.
- `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `PORT` and `CODEY_HOME` are dropped,
  so no chat channel connects.
- The window is shown without taking focus.

```bash
npm run test:e2e -w codey-mac                            # build, then run the tests
npx playwright show-report codey-mac/playwright-report   # failures and traces
```

Add tests to `app.spec.ts`. The `page` fixture is the main window, ready to use.
