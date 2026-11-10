---
name: terminal
description: Run commands in the Terminal panel the user can see in Codey. Use for anything the user should watch or take over - dev servers, watchers, log tails, REPLs, interactive prompts (y/n, passwords the user types, menus), or when the user says "run it in the terminal" or "in my Terminal". Quick one-off commands whose output only you need still belong in your own shell tool.
---

# Codey Terminal

The Terminal panel sits under (or beside) this chat. It is a real login shell
in the chat's working directory, and the user sees everything you type and
every byte of output. Every command is one shell call:

```
ELECTRON_RUN_AS_NODE=1 "$CODEY_TERMINAL_RUNTIME" "$CODEY_TERMINAL_CLI" <command> [args]
```

Output is JSON on stdout. If `$CODEY_TERMINAL_CLI` is unset, or a command
reports the bridge is unavailable, the Terminal is not available this turn
(it only exists in Codey desktop chats) - say so and use your own shell tool
instead.

## When to use it

- **Use the Terminal** for long-running or interactive things: `npm run dev`,
  `tail -f`, test watchers, `docker compose up`, a REPL, an installer that asks
  questions, anything the user may want to watch, stop, or type into.
- **Use your own shell tool** for quick commands whose output only you need
  (`ls`, `git status`, `grep`). Do not move ordinary work into the Terminal.

## Start here

- Run a command and get its output: `run -- npm test`
- Start a server and wait until it is ready:
  `run --wait-for "ready|listening on" --timeout 90 -- npm run dev`
- Read what is on screen now: `read` (add `--lines 400` for more)
- Answer a prompt: `send "y" --keys enter`
- Stop the running program: `send --keys ctrl-c`
- Wait for more output: `wait --for "compiled" --timeout 60`

Everything after `--` is the command, typed exactly as given and followed by
Enter. Quote it the way you would in a shell script.

## Sessions

The first `run` opens a Terminal tab for you (the panel pops open) and later
commands reuse it. That tab stays yours for the whole chat, so a server you
start keeps running between turns.

- `sessions` lists this chat's terminals: `id`, `title` (the program in the
  foreground), `alive`, and `agent` (true for tabs you opened).
- `open` starts another tab, e.g. one for the server and one for commands.
- Add `--session <id>` to any command to target a specific tab, including one
  the user opened themselves.
- `close [--session <id>]` ends a tab and whatever runs in it.

## Reading results

`run`, `send` and `wait` return the new output since the command was sent,
with colors and cursor codes removed, plus:

- `state: "done"` - the shell is back at its prompt; the command finished.
- `state: "running"` - a program still holds the terminal and has been quiet
  for a few seconds (a server, a watcher, a prompt waiting for input). It keeps
  running; read it later or `send` to it.
- `state: "matched"` - your `--wait-for` / `--for` pattern appeared.
- `state: "timeout"` - nothing settled within `--timeout` seconds (default 30,
  max 240). The program keeps running.
- `state: "exited"` - the shell itself ended; `open` a new tab.

A shell builtin that waits for input (zsh/bash `read`) looks like `done`
because the shell itself is in front - check whether the output ends in a
question before assuming the command finished.

Patterns are case-insensitive regular expressions, and `^`/`$` match at line
starts/ends. They are only checked against output after the command line the
shell echoes, so the command text itself never matches.

`truncated: true` means only the last part was returned - use `read --lines N`
if you need more. Long-running output keeps arriving after you return; use
`read` or `wait` to catch up instead of re-running the command.

## Keys

`send` types text as-is (no Enter unless you add `--keys enter`). `--keys`
takes a comma-separated list: `enter`, `tab`, `esc`, `space`, `backspace`,
`up`, `down`, `left`, `right`, `ctrl-c`, `ctrl-d`, `ctrl-z`, `ctrl-l`.

## Rules

- Reading (`sessions`, `read`, `wait`) and `open` are free. Anything that types
  into a terminal - `run`, `send`, `close` - needs the user's approval in the
  Terminal panel the first time, unless they chose "Always allow". If they
  deny it, stop; do not route around the decision with your own shell tool.
- Never type passwords, tokens or other secrets into the Terminal. When a
  program asks for one, tell the user to type it in the panel, then `wait`.
- Never claim a command succeeded unless its output shows it.
- Do not leave stray servers behind: when the task is done and the user did
  not ask to keep it running, stop it with `send --keys ctrl-c`.
