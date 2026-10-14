# pi-auto-compact

Automatic compaction for [Pi](https://pi.dev): summarize the session before the context window
fills up, at a threshold you choose, and a different threshold per model if you want.

A fork of [`@henryqw/pi-auto-compact`](https://www.npmjs.com/package/@henryqw/pi-auto-compact)
4.0.0 (MIT) with lifecycle repairs, one retry for truncated summaries, plain notices for
cancelled or failed compactions, and per-model thresholds.

## Install

```
pi install npm:@carlitose86/pi-auto-compact
```

It refuses to start while Pi's built-in compaction is on, so the two never compete. Turn that
off in Pi's `settings.json`:

```json
{ "compaction": { "enabled": false } }
```

Load only one auto-compact package: remove `npm:@henryqw/pi-auto-compact` if you had it.

## Usage

| Command | Effect |
|---|---|
| `/auto-compact` | Set the general threshold, in percent of the context window (25 to 99, default 70) |
| `/auto-compact model` | Set the threshold for the current model only; answer `default` to remove it |

The threshold is checked before each turn, after each tool turn and at the end of a run, against
the model the session is using at that moment. Switching model applies its threshold at the next
check.

## Configuration

The commands write `<agent-dir>/config/pi-auto-compact/config.json` (usually
`~/.pi/agent/config/pi-auto-compact/config.json`). You can also edit it by hand:

```json
{
  "autoCompactThreshold": 70,
  "modelThresholds": {
    "anthropic/claude-opus-5-5": 30,
    "gpt-6-luna": 90
  }
}
```

A key is `provider/id` or just the model `id`. For each check the most specific match wins:
`provider/id`, then `id`, then `autoCompactThreshold`. A value out of range or an empty key makes
the whole file invalid: the extension says so and uses 70% until you fix it.

## Summary model

With [`@henryqw/pi-task-models`](https://www.npmjs.com/package/@henryqw/pi-task-models) you can
route the summary to a cheaper model (task `pi-auto-compact/autoCompact`). Without a route, Pi
summarizes with the session model.

## Log

Cancelled and failed compactions are also appended to `<agent-dir>/pi-auto-compact.log`, rotated
once past 512 KiB. The log holds no session content, summaries or credentials.

## Development

```
npm test
npm run smoke -- <path to the installed Pi SDK dist/index.js>
npm run smoke:recovery -- <path to the installed Pi SDK dist/index.js>
```

## License

MIT. See [LICENSE](LICENSE); the original notice is kept.
