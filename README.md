# Built by Bots

A live feed of brand-new public GitHub repositories built with **Claude Code** and **OpenAI Codex** — shown with a link, an AI-written summary, and a category, as they're created.

How it works (the order matters):

1. **Discover by creation date** — query GitHub's *repository* search for repos
   `created:` in the last 24h, most-recently-updated first. Filtering on creation
   date means established repos are excluded by definition (commit search, by
   contrast, ranks by recent commit and buries new repos under big active projects).
2. **Verify authorship** — scan each repo's recent commit messages for the
   tool fingerprints:
   - **Claude Code** → `Co-Authored-By: Claude` (any variant)
   - **OpenAI Codex** → `Co-authored-by: openai-codex`
3. **Accumulate forever** — found repos are kept permanently, so the feed grows.

No database and no backend server: a scheduled job writes a `feed.json`, and a static page renders it. That means it can be hosted **free** on GitHub Pages.

## Run locally

```bash
# 1. fetch the latest repos (writes public/feed.json)
node fetch.mjs

# 2. serve the page
node serve.mjs   # → http://localhost:5173
```

### Environment variables

| Variable | Purpose | Without it |
|---|---|---|
| `GITHUB_TOKEN` | repo search + commit verification at full rate | Heavy throttling; very low volume |
| `OPENROUTER_API_KEY` | AI one-line summaries + categories from each README | Falls back to the repo's own description |
| `OPENROUTER_MODEL` | Override the free model | Defaults to `openai/gpt-oss-20b:free` |

Other knobs (env vars): `DISCOVERY_HOURS` (default 24), `SEARCH_PAGES` (default 10,
up to 1000 repos), `MAX_CHECKS` (commit-verify calls per run), `MAX_SUMMARIES`,
`TIME_BUDGET_MS` (hard stop so the job always deploys).

```powershell
# Windows PowerShell
$env:GITHUB_TOKEN = "ghp_xxx"
$env:OPENROUTER_API_KEY = "sk-or-xxx"
node fetch.mjs
```

- **GitHub token:** a [fine-grained PAT](https://github.com/settings/tokens?type=beta)
  with public read access — no special scopes needed for search.
- **OpenRouter key:** free from [openrouter.ai/keys](https://openrouter.ai/keys).
  Summaries use a `:free` model, so there's no cost. If your chosen model is
  unavailable, the code silently falls back to the repo description.

## How the feed stays fresh

- Discovery only adds repos **created in the last `DISCOVERY_HOURS`** (default 24).
- Found repos are **kept forever** — each run merges new finds into `feed.json`
  and never drops anything, so the site builds up over time.
- Summaries are **cached** (`.cache/summaries.json`); a **checked-cache**
  (`.cache/checked.json`) records which repos were already verified so they
  aren't re-scanned every run (re-checked only if they receive new pushes).

## Deploy free on GitHub Pages

1. Push this folder to a new GitHub repo.
2. In the repo: **Settings → Pages → Source: GitHub Actions**.
3. (Optional, for AI summaries) **Settings → Secrets and variables → Actions →
   New repository secret:** add `OPENROUTER_API_KEY`. Optionally add a repo
   *variable* `OPENROUTER_MODEL` to change the model.
4. The included workflow (`.github/workflows/update-feed.yml`) polls every
   ~10 minutes and publishes automatically. `GITHUB_TOKEN` is provided to it
   for free, so Codex detection and rate limits are not an issue there.

## Tuning detection

The fingerprint regexes (`CLAUDE_FP`, `CODEX_FP`) in [`fetch.mjs`](fetch.mjs)
are the whole detection rule — edit them to broaden or tighten what counts.

## Known limitations

- **Tool-specific:** this only catches repos whose commits carry the Claude Code
  or Codex fingerprint. Repos built with other AI tools (Cursor, Copilot, Aider…),
  or where the author stripped the trailer, won't match. In practice ~2% of newly
  created repos carry these fingerprints — so expect dozens per day, not hundreds.
- **Search cap:** repository search returns at most 1000 results per run, so each
  run sees the 1000 most-recently-updated new repos. Running often + accumulating
  covers the rest over time.
- **No commit messages in the firehose:** GitHub's public event stream (GH Archive)
  no longer includes commit messages, which is why per-repo commit verification is
  required rather than scanning the firehose directly.
