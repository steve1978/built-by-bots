# AI Repo Radar

A live feed of brand-new public GitHub repositories built with **Claude Code** and **OpenAI Codex** — shown with a link and a short summary as they ship.

It works by searching GitHub's commit data for the fingerprints these tools leave behind:

- **Claude Code** → the `Generated with Claude Code` / `Co-Authored-By: Claude` commit trailer
- **OpenAI Codex** → Codex co-author signatures

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
| `GITHUB_TOKEN` | GitHub search + repo lookups at full rate | Codex queries get throttled (403); low volume |
| `OPENROUTER_API_KEY` | AI one-line summaries from each README | Falls back to the repo's own description |
| `OPENROUTER_MODEL` | Override the free model | Defaults to `meta-llama/llama-3.3-70b-instruct:free` |

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

- Only repos **created in the last 14 days** appear (`MAX_AGE_DAYS` in `fetch.mjs`).
- Each run **accumulates** — it merges new finds with the previous `feed.json`
  and drops anything older than the window, so the feed grows instead of resetting.
- Summaries are **cached** (`.cache/summaries.json`) keyed by commit SHA, so the
  same repo isn't re-summarized every run.

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

All detection logic is the `SOURCES` array in [`fetch.mjs`](fetch.mjs).
Add or refine the fingerprint queries there.

## Known limitations / next steps

- **Coverage:** commit search only indexes default branches and is sampled, so
  this catches most — not every — repo. Add more fingerprint queries or paginate
  deeper in `SOURCES` / `fetch.mjs` to widen the net (needs a token).
- **Volume:** without a `GITHUB_TOKEN`, only one Claude query page comes through
  before the secondary rate limit trips. With a token (always present in CI),
  Codex detection works and you can pull more pages for a fuller feed.
- **Tuning:** `MAX_AGE_DAYS` controls how "new" a repo must be to appear.
