// fetch.mjs — polls GitHub's commit-search API for AI-tool fingerprints,
// keeps only newly-created repos, summarizes each via a free OpenRouter model,
// and writes public/feed.json for the static frontend.
//
// Environment variables (all optional, but recommended):
//   GITHUB_TOKEN        – lifts GitHub rate limits (search + repo lookups)
//   OPENROUTER_API_KEY  – enables AI summaries (falls back to description if unset)
//   OPENROUTER_MODEL    – override the free model (default below)

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

// Load a local .env (KEY=value per line) if present, so secrets never need to
// be pasted into a shell or committed. This file is git-ignored.
try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* no .env — fine */ }

const TOKEN = process.env.GITHUB_TOKEN || "";
const OR_KEY = process.env.OPENROUTER_API_KEY || "";
const OR_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-oss-20b:free";

const OUT = "public/feed.json";
const CACHE = ".cache/summaries.json"; // repo -> { sha, summary }
const PER_PAGE = 100;      // GitHub search max page size
const PAGES = TOKEN ? Number(process.env.PAGES || 6) : 1; // paginate when authed
const MAX_AGE_DAYS = 14;   // only show repos created within this many days
const MAX_SUMMARIES = 80;  // cap OpenRouter calls per run (free-tier friendly)

// Detection fingerprints — the whole strategy lives here. Tune freely.
const SOURCES = [
  {
    id: "claude",
    label: "Claude Code",
    // "Co-Authored-By: Claude" is the stable marker every Claude Code variant
    // shares (including "Claude Opus 4.8 (1M context)"). "Generated with Claude
    // Code" is rarer, so its recent results reach further back and surface
    // smaller/newer repos the broad firehose query buries. The union of both
    // windows catches more genuinely-new repos.
    queries: [
      `"Co-Authored-By: Claude"`,
      `"Generated with Claude Code"`,
    ],
  },
  {
    id: "codex",
    label: "OpenAI Codex",
    // Verified marker left by Codex's cloud agent (~14k commits indexed).
    queries: [
      `"Co-authored-by: openai-codex"`,
    ],
  },
];

// Fixed taxonomy so categories stay consistent and filterable.
const CATEGORIES = [
  "AI / Agents", "Web App", "CLI / Tooling", "API / Backend", "Game",
  "Data / ML", "Mobile", "Library / SDK", "DevOps / Infra",
  "Automation / Bot", "Docs / Content", "Other",
];

// Keyword heuristic — fallback when the LLM is unavailable, and to backfill
// older cached entries. Order matters: first match wins.
const RULES = [
  ["Game", /\b(game|arcade|puzzle|platformer|roguelike|rpg|tetris|gameplay|2d|3d game)\b/],
  ["AI / Agents", /\b(agent|llm|chatbot|chat bot|rag|prompt|gpt|openai|anthropic|claude|diffusion|embedding|neural|ai[- ]?(powered|assistant|app)|vision model)\b/],
  ["Mobile", /\b(ios|android|react native|flutter|swiftui|mobile app)\b/],
  ["Game", /\bunity|godot|phaser\b/],
  ["DevOps / Infra", /\b(docker|kubernetes|k8s|terraform|ci\/cd|helm|deployment|package manager|homebrew|infra(structure)?|self[- ]host)\b/],
  ["Automation / Bot", /\b(bot|automation|scraper|scraping|webhook|cron|crawler|workflow automation)\b/],
  ["Data / ML", /\b(dataset|machine learning|training|analytics|pandas|etl|data pipeline|visualization|notebook)\b/],
  ["CLI / Tooling", /\b(cli|command[- ]line|terminal|tui|devtool|developer tool)\b/],
  ["API / Backend", /\b(api|rest|graphql|backend|microservice|endpoint|webserver|server)\b/],
  ["Web App", /\b(web app|website|dashboard|frontend|react|vue|svelte|next\.?js|browser|landing page|portfolio)\b/],
  ["Library / SDK", /\b(library|sdk|framework|toolkit|wrapper|plugin|npm package|module)\b/],
  ["Docs / Content", /\b(documentation|docs|blog|paper|thesis|latex|markdown|notes|book)\b/],
];
const LANG_HINT = { Swift: "Mobile", Kotlin: "Mobile", Dart: "Mobile", TeX: "Docs / Content", "Jupyter Notebook": "Data / ML" };

function categorize(text, language) {
  const t = (text || "").toLowerCase();
  for (const [cat, re] of RULES) if (re.test(t)) return cat;
  if (LANG_HINT[language]) return LANG_HINT[language];
  return "Other";
}

// Lenient match of free-text (e.g. an LLM's reply) to a canonical category.
// Ignores spacing/punctuation/markdown so "AI/Agents", "AI Agents",
// "**AI / Agents**" all resolve. Returns null if nothing fits.
function matchCategory(s) {
  const norm = (x) => (x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const t = norm(s);
  if (!t) return null;
  for (const c of CATEGORIES) if (t === norm(c)) return c;          // exact
  for (const c of CATEGORIES) {                                     // contained
    const nc = norm(c);
    if (c !== "Other" && (t.includes(nc) || nc.includes(t))) return c;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ghHeaders(accept = "application/vnd.github+json") {
  const h = { Accept: accept, "User-Agent": "ai-repo-radar" };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

// fetch that retries on rate-limit (403/429), honoring Retry-After when given.
async function fetchRetry(url, opts = {}, { tries = 5, base = 15000, label = "" } = {}) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, opts);
    if ((res.status === 403 || res.status === 429) && i < tries - 1) {
      const ra = Number(res.headers.get("retry-after"));
      const wait = ra ? ra * 1000 + 1000 : base * 2 ** i;
      console.error(`    ${label} ${res.status} rate-limited — waiting ${Math.round(wait / 1000)}s…`);
      await sleep(wait);
      continue;
    }
    return res;
  }
}

async function ghSearchCommits(q, page) {
  const url =
    `https://api.github.com/search/commits` +
    `?q=${encodeURIComponent(q)}&sort=committer-date&order=desc` +
    `&per_page=${PER_PAGE}&page=${page}`;
  const res = await fetchRetry(url, { headers: ghHeaders() }, { label: "search" });
  if (!res.ok) throw new Error(`search ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()).items || [];
}

async function ghRepo(fullName) {
  const res = await fetch(`https://api.github.com/repos/${fullName}`, { headers: ghHeaders() });
  if (!res.ok) return null;
  return res.json();
}

async function ghReadme(fullName) {
  const res = await fetch(`https://api.github.com/repos/${fullName}/readme`, {
    headers: ghHeaders("application/vnd.github.raw"),
  });
  if (!res.ok) return "";
  return (await res.text()).slice(0, 3000);
}

// Returns { summary, category }. Falls back to the description + heuristic
// category whenever the LLM is unavailable or rate-limited.
async function summarize(fullName, readme, fallback, language) {
  const fb = { summary: fallback, category: categorize(fallback, language) };
  if (!OR_KEY || !readme.trim()) return fb;
  try {
    const res = await fetchRetry("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OR_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/ai-repo-radar",
        "X-Title": "AI Repo Radar",
      },
      body: JSON.stringify({
        model: OR_MODEL,
        max_tokens: 80,
        temperature: 0.2,
        messages: [
          {
            role: "user",
            content:
              `Describe this GitHub project. Reply in EXACTLY two lines:\n` +
              `Line 1: one plain sentence, max 18 words, no marketing, no quotes.\n` +
              `Line 2: Category: <pick ONE: ${CATEGORIES.join(", ")}>\n\n` +
              `Repo: ${fullName}\nREADME:\n${readme}`,
          },
        ],
      }),
    }, { label: "openrouter", tries: 2, base: 8000 });
    if (!res.ok) {
      console.error(`    OpenRouter ${res.status} — using fallback`);
      return fb;
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) return fb;
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const summary = (lines[0] || fallback).replace(/^["']|["']$/g, "");
    const catLine = (lines.find((l) => /category/i.test(l)) || lines[1] || "").replace(/.*category:?\s*/i, "");
    const category = matchCategory(catLine) || categorize(summary, language);
    return { summary, category };
  } catch (err) {
    console.error(`    OpenRouter error: ${err.message}`);
    return fb;
  }
}

async function loadCache() {
  try { return JSON.parse(await readFile(CACHE, "utf8")); } catch { return {}; }
}

// Offline: re-apply categories to the existing feed without hitting any API.
// Useful for quick local iteration on the category rules. Run: node fetch.mjs --recat
async function recategorize() {
  const feed = JSON.parse(await readFile(OUT, "utf8"));
  for (const e of feed.entries) e.category = categorize(e.summary || "", e.language);
  feed.categories = CATEGORIES;
  await writeFile(OUT, JSON.stringify(feed, null, 2));
  console.log(`Recategorized ${feed.entries.length} entries.`);
}

// Ask the LLM to classify a single summary into one category. Cheap + fast.
async function classify(summary) {
  if (!OR_KEY) return null;
  try {
    const res = await fetchRetry("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OR_MODEL, max_tokens: 12, temperature: 0,
        messages: [{ role: "user", content:
          `Classify this project into ONE category. Reply with only the category name.\n` +
          `Categories: ${CATEGORIES.join(", ")}\nProject: ${summary}` }],
      }),
    }, { label: "classify", tries: 2, base: 8000 });
    if (!res.ok) return null;
    const txt = (await res.json()).choices?.[0]?.message?.content || "";
    return matchCategory(txt);
  } catch { return null; }
}

// Offline: re-classify existing "Other" entries (that have a summary) via the
// LLM. No GitHub search — fast. Run: node fetch.mjs --recat-llm
async function recategorizeLLM() {
  const feed = JSON.parse(await readFile(OUT, "utf8"));
  const cache = await loadCache();
  let fixed = 0;
  for (const e of feed.entries) {
    if (!e.summary || e.summary.length < 8 || (e.category && e.category !== "Other")) continue;
    const cat = await classify(e.summary);
    if (cat && cat !== "Other") {
      e.category = cat;
      if (cache[e.repo]) cache[e.repo].category = cat;
      fixed++;
      process.stdout.write(`  ${e.repo} → ${cat}\n`);
    }
    await sleep(1200);
  }
  feed.categories = CATEGORIES;
  await writeFile(OUT, JSON.stringify(feed, null, 2));
  await writeFile(CACHE, JSON.stringify(cache, null, 2));
  console.log(`\nReclassified ${fixed} previously-"Other" entries.`);
}

async function main() {
  if (process.argv.includes("--recat")) return recategorize();
  if (process.argv.includes("--recat-llm")) return recategorizeLLM();
  // 1. Collect candidate repos from commit search.
  const candidates = new Map(); // full_name -> { source, sha, date }
  for (const source of SOURCES) {
    for (const q of source.queries) {
      let total = 0;
      for (let page = 1; page <= PAGES; page++) {
        try {
          const items = await ghSearchCommits(q, page);
          for (const item of items) {
            const repo = item.repository?.full_name;
            if (!repo || item.repository?.fork) continue;
            const date = item.commit?.committer?.date || item.commit?.author?.date;
            const prev = candidates.get(repo);
            if (!prev || new Date(date) > new Date(prev.date)) {
              candidates.set(repo, { source: source.id, sha: item.sha, date });
            }
          }
          total += items.length;
          if (items.length < PER_PAGE) break; // no more pages
        } catch (err) {
          console.error(`  ✗ ${source.id} "${q}" p${page}: ${err.message}`);
          break;
        }
        await sleep(8000); // steady pacing avoids tripping the secondary limit
      }
      console.log(`  ✓ ${source.id}: "${q}" → ${total} hits`);
    }
  }
  console.log(`\n${candidates.size} unique candidate repos. Enriching…`);

  // 2. Enrich with creation date, filter to newly-created repos, summarize.
  const cache = await loadCache();
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400_000;
  let summaries = 0;

  // Seed from the previous feed so the list accumulates over many runs.
  // Keep prior entries that are still within the "new" window.
  const merged = new Map(); // full_name -> entry
  try {
    const prev = JSON.parse(await readFile(OUT, "utf8"));
    for (const e of prev.entries || []) {
      if (e.createdAt && new Date(e.createdAt).getTime() >= cutoff) {
        merged.set(e.repo, e);
      }
    }
    console.log(`Carried over ${merged.size} repos from the previous feed.`);
  } catch { /* first run — no prior feed */ }

  for (const [fullName, c] of candidates) {
    const repo = await ghRepo(fullName);
    await sleep(150);
    if (!repo || !repo.created_at) continue;
    if (new Date(repo.created_at).getTime() < cutoff) continue; // not "new"

    const fallback = repo.description || "";
    const language = repo.language || "";
    let summary = fallback;
    let category = categorize(fallback, language);
    const cached = cache[fullName];
    if (cached && cached.sha === c.sha) {
      summary = cached.summary;
      category = cached.category || categorize(summary, language); // backfill old cache
    } else if (summaries < MAX_SUMMARIES) {
      const readme = await ghReadme(fullName);
      ({ summary, category } = await summarize(fullName, readme, fallback, language));
      cache[fullName] = { sha: c.sha, summary, category };
      summaries++;
      await sleep(1500); // stay under OpenRouter free per-minute limits
    }

    merged.set(fullName, {
      source: c.source,
      repo: fullName,
      url: repo.html_url,
      owner: repo.owner?.login || "",
      avatar: repo.owner?.avatar_url || "",
      summary,
      category,
      language,
      stars: repo.stargazers_count || 0,
      createdAt: repo.created_at,
      date: c.date,
    });
  }

  // Backfill a category on any carried-over entry that predates this feature.
  for (const e of merged.values()) {
    if (!e.category) e.category = categorize(e.summary || "", e.language);
  }

  const entries = [...merged.values()].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  const feed = {
    generatedAt: new Date().toISOString(),
    maxAgeDays: MAX_AGE_DAYS,
    count: entries.length,
    sources: SOURCES.map(({ id, label }) => ({ id, label })),
    categories: CATEGORIES,
    entries,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(feed, null, 2));
  await mkdir(dirname(CACHE), { recursive: true });
  await writeFile(CACHE, JSON.stringify(cache, null, 2));
  console.log(`\nWrote ${entries.length} new repos (${summaries} summarized) → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
