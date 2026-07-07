// fetch.mjs — finds GitHub repos CREATED in the last ~24h (repository search,
// filtered by creation date), verifies each was built with Claude Code or
// OpenAI Codex by scanning its recent commit messages for their fingerprints,
// summarizes + categorizes each via a free OpenRouter model, and accumulates
// them forever into public/feed.json for the static frontend.
//
// Why creation-date search (not commit search): commit search ranks by recent
// commit, so brand-new repos drown under established projects that use these
// tools daily. Searching by `created:` excludes old repos by definition.
//
// Environment variables (all optional, but recommended):
//   GITHUB_TOKEN        – lifts GitHub rate limits (search + commit lookups)
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
const CACHE = ".cache/summaries.json"; // repo -> { summary, category }
const CHECKED = ".cache/checked.json"; // repo -> { pushedAt, ai } — avoid re-checking
const PER_PAGE = 100;      // GitHub search max page size
const DISCOVERY_HOURS = Number(process.env.DISCOVERY_HOURS || 24); // "new" window
const SEARCH_PAGES = Number(process.env.SEARCH_PAGES || 10);       // up to 1000 results
const COMMITS_PER_REPO = 15;  // recent commits to scan for a fingerprint
const MAX_CHECKS = Number(process.env.MAX_CHECKS || 500); // commit-verify calls/run (rate-limit budget)
const MAX_SUMMARIES = Number(process.env.MAX_SUMMARIES || 30); // OpenRouter calls/run
const HEAL_PER_RUN = Number(process.env.HEAL_PER_RUN || 40); // fix old blank/"Other" entries/run
const REFRESH_BATCHES = Number(process.env.REFRESH_BATCHES || 12); // GraphQL calls/run × 100 repos each
const TIME_BUDGET_MS = Number(process.env.TIME_BUDGET_MS || 360_000); // hard stop → always deploy
const START = Date.now();
const overBudget = () => Date.now() - START > TIME_BUDGET_MS;

// Source list for the frontend (the actual detection is the regexes below).
const SOURCES = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "OpenAI Codex" },
];

// Commit-message fingerprints. "Co-Authored-By: Claude" is the stable marker
// every Claude Code variant shares (incl. "Claude Opus 4.8 (1M context)").
const CLAUDE_FP = /Co-Authored-By:\s*Claude/i;
const CODEX_FP = /Co-authored-by:\s*openai-codex/i;

// Fixed taxonomy so categories stay consistent and filterable. The extra
// buckets (Security, Finance, Hardware, Education, Science, Productivity) exist
// to drain the "Other" pile — most niche projects fit one of these.
const CATEGORIES = [
  "AI / Agents", "Web App", "CLI / Tooling", "API / Backend", "Game",
  "Data / ML", "Mobile", "Library / SDK", "DevOps / Infra", "Automation / Bot",
  "Security", "Finance / Crypto", "Hardware / IoT", "Education",
  "Science / Health", "Productivity", "Docs / Content", "Other",
];

// Keyword heuristic — fallback when the LLM is unavailable, and to backfill
// older cached entries. Order matters: first match wins, so specific buckets
// come before generic ones.
const RULES = [
  ["Game", /\b(game|arcade|puzzle|platformer|roguelike|rpg|tetris|gameplay|unity|godot|phaser|2d game|3d game)\b/],
  ["AI / Agents", /\b(agent|llm|chatbot|chat bot|\brag\b|prompt|gpt|openai|anthropic|claude|diffusion|embedding|neural net|ai[- ]?(powered|assistant|app|tool)|vision model|fine[- ]tun)\b/],
  ["Finance / Crypto", /\b(crypto(currency)?|bitcoin|ethereum|blockchain|trading|defi|wallet|finance|invoic|invest|stock|etf|portfolio|payment|banking|budget|accounting|tax)\b/],
  ["Security", /\b(security|vulnerab|exploit|pentest|encryption|password|authentication|jailbreak|malware|firewall|\bcve\b|owasp|phishing|forensic)\b/],
  ["Hardware / IoT", /\b(arduino|raspberry pi|esp32|esp8266|microcontroller|\biot\b|sensor|firmware|embedded device|robot|drone|3d print|m5stack|wi-?fi controller)\b/],
  ["Science / Health", /\b(health|medical|biolog|chemistry|physics|clinical|genom|protein|astronom|scientific|\bemg\b|diagnos|patient|neuroscience|molecul)\b/],
  ["Education", /\b(learn|course|tutorial|education|student|quiz|flashcard|study|school|teaching|lesson|exam|curriculum)\b/],
  ["Mobile", /\b(ios|android|react native|flutter|swiftui|mobile app)\b/],
  ["DevOps / Infra", /\b(docker|kubernetes|k8s|terraform|ci\/cd|helm|deployment|package manager|homebrew|infra(structure)?|self[- ]host|monitoring|observability)\b/],
  ["Automation / Bot", /\b(bot|automation|scraper|scraping|webhook|\bcron\b|crawler|workflow automation|discord bot|telegram)\b/],
  ["Data / ML", /\b(dataset|machine learning|training|analytics|pandas|\betl\b|data pipeline|visualization|notebook|data science)\b/],
  ["CLI / Tooling", /\b(cli|command[- ]line|terminal|\btui\b|devtool|developer tool|generator|converter|formatter)\b/],
  ["API / Backend", /\b(api|rest|graphql|backend|microservice|endpoint|webserver|server)\b/],
  ["Web App", /\b(web app|website|dashboard|frontend|react|vue|svelte|next\.?js|browser|landing page|portfolio|\bpwa\b)\b/],
  ["Productivity", /\b(productivity|todo|task manager|note[- ]taking|calendar|organizer|tracker|planner)\b/],
  ["Library / SDK", /\b(library|sdk|framework|toolkit|wrapper|plugin|npm package|module|boilerplate|starter|template)\b/],
  ["Docs / Content", /\b(documentation|docs|blog|paper|thesis|latex|markdown|notes|book|writing)\b/],
];
const LANG_HINT = { Swift: "Mobile", Kotlin: "Mobile", Dart: "Mobile", TeX: "Docs / Content", "Jupyter Notebook": "Data / ML", Solidity: "Finance / Crypto" };

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

// Repos created within the discovery window, most-recently-updated first
// (active = more likely to be a real, in-progress project). The search result
// already carries the metadata we need, so no per-repo lookup is required.
async function searchNewRepos() {
  const since = new Date(Date.now() - DISCOVERY_HOURS * 3600_000).toISOString().slice(0, 19) + "Z";
  const q = `created:>=${since} fork:false`;
  const out = [];
  for (let page = 1; page <= SEARCH_PAGES; page++) {
    if (overBudget()) break;
    const url =
      `https://api.github.com/search/repositories` +
      `?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${PER_PAGE}&page=${page}`;
    const res = await fetchRetry(url, { headers: ghHeaders() }, { label: "reposearch" });
    if (!res.ok) { console.error(`  reposearch ${res.status}`); break; }
    const items = (await res.json()).items || [];
    out.push(...items);
    if (items.length < PER_PAGE) break;
    await sleep(2500);
  }
  return out;
}

// Scan a repo's recent commits for an AI fingerprint. Returns "claude" | "codex" | null.
async function verifyAI(fullName) {
  const res = await fetchRetry(
    `https://api.github.com/repos/${fullName}/commits?per_page=${COMMITS_PER_REPO}`,
    { headers: ghHeaders() }, { label: "commits", tries: 2, base: 4000 }
  );
  if (!res.ok) return null;
  let commits; try { commits = await res.json(); } catch { return null; }
  if (!Array.isArray(commits)) return null;
  for (const c of commits) {
    const msg = c.commit?.message || "";
    if (CLAUDE_FP.test(msg)) return "claude";
    if (CODEX_FP.test(msg)) return "codex";
  }
  return null;
}

// ---------- stats refresh (stars / forks / owner followers) ----------
// Discovery captures a repo at birth (usually 0 stars) and would otherwise
// never look again — so star counts go stale and gems stay invisible. This
// re-checks tracked repos via the GraphQL API, 100 per request (dirt cheap:
// ~12 requests refresh 1200 repos). Young and starred repos refresh most
// often; the rest rotate least-recently-refreshed first.
async function refreshStats(merged) {
  if (!TOKEN) return 0;
  const now = Date.now();
  const all = [...merged.values()].filter((e) => !e.gone && e.repo?.includes("/"));
  const isHot = (e) =>
    now - new Date(e.createdAt).getTime() < 14 * 86400_000 || (e.stars || 0) > 0;
  const lastRef = (e) => (e.refreshedAt ? new Date(e.refreshedAt).getTime() : 0);
  const due = [
    // hot repos not refreshed in the last 3h, then everything else LRU
    ...all.filter((e) => isHot(e) && now - lastRef(e) > 3 * 3600_000),
    ...all.filter((e) => !isHot(e)).sort((a, b) => lastRef(a) - lastRef(b)),
  ];
  const pick = [...new Set(due)].slice(0, REFRESH_BATCHES * 100);

  let refreshed = 0;
  for (let i = 0; i < pick.length; i += 100) {
    if (overBudget()) break;
    const batch = pick.slice(i, i + 100);
    const q = batch
      .map((e, j) => {
        const [o, n] = e.repo.split("/");
        return `r${j}: repository(owner:${JSON.stringify(o)}, name:${JSON.stringify(n)})` +
          `{ stargazerCount forkCount owner { login ... on User { followers { totalCount } } } }`;
      })
      .join("\n");
    const res = await fetchRetry("https://api.github.com/graphql", {
      method: "POST",
      headers: ghHeaders(),
      body: JSON.stringify({ query: `query{${q}}` }),
    }, { label: "graphql", tries: 3, base: 10000 });
    if (!res || !res.ok) { console.error(`  graphql ${res?.status}`); break; }
    let data;
    try { data = (await res.json()).data || {}; } catch { break; }
    batch.forEach((e, j) => {
      const r = data[`r${j}`];
      if (!r) {
        // Deleted, made private, or renamed. Two strikes before hiding, so a
        // transient API hiccup can't disappear a repo.
        e.goneCount = (e.goneCount || 0) + 1;
        if (e.goneCount >= 2) e.gone = true;
        return;
      }
      e.goneCount = 0;
      e.stars = r.stargazerCount ?? e.stars ?? 0;
      e.forks = r.forkCount ?? 0;
      e.followers = r.owner?.followers?.totalCount ?? e.followers ?? 0;
      e.refreshedAt = new Date().toISOString();
      refreshed++;
    });
    await sleep(1500);
  }
  return refreshed;
}

// Gem score — simple and explainable: stars carry the weight, forks count
// double (someone building on it is a strong signal), a recency boost doubles
// young starred repos so risers surface, and famous owners add a little.
function gemScore(e) {
  const ageDays = Math.max((Date.now() - new Date(e.createdAt).getTime()) / 86400_000, 1);
  const s = e.stars || 0;
  const score =
    s +
    2 * (e.forks || 0) +
    s * (14 / Math.max(ageDays, 14)) +          // recency boost (≤ +100%)
    Math.min(e.followers || 0, 1000) / 100;     // known-dev bonus (≤ +10)
  return Math.round(score * 10) / 10;
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

async function loadJSON(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return {}; }
}
const loadCache = () => loadJSON(CACHE);

// Offline: re-apply categories to the existing feed without hitting any API.
// Useful for quick local iteration on the category rules. Run: node fetch.mjs --recat
async function recategorize() {
  const feed = JSON.parse(await readFile(OUT, "utf8"));
  for (const e of feed.entries) e.category = categorize(e.summary || "", e.language);
  feed.categories = CATEGORIES;
  await writeFile(OUT, JSON.stringify(feed, null, 2));
  console.log(`Recategorized ${feed.entries.length} entries.`);
}

// Ask the LLM to classify a repo into one category. Cheap + fast. Uses the
// repo name + language as extra signal so even terse summaries place well.
async function classify(name, summary, language) {
  if (!OR_KEY) return null;
  try {
    const res = await fetchRetry("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OR_MODEL, max_tokens: 12, temperature: 0,
        messages: [{ role: "user", content:
          `Classify this project into ONE category. Reply with only the category name. ` +
          `Avoid "Other" unless nothing else fits.\n` +
          `Categories: ${CATEGORIES.join(", ")}\n` +
          `Repo: ${name}${language ? ` (${language})` : ""}\nWhat it does: ${summary}` }],
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
    const cat = await classify(e.repo, e.summary, e.language);
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

  const cache = await loadCache();
  const checked = await loadJSON(CHECKED);

  // Accumulate forever: start from everything we've ever found, drop nothing.
  const merged = new Map(); // full_name -> entry
  try {
    const prev = JSON.parse(await readFile(OUT, "utf8"));
    for (const e of prev.entries || []) merged.set(e.repo, e);
    console.log(`Carried over ${merged.size} repos from the previous feed.`);
  } catch { /* first run — no prior feed */ }

  // 1. Discover repos created in the last DISCOVERY_HOURS.
  const repos = await searchNewRepos();
  console.log(`${repos.length} repos created in the last ${DISCOVERY_HOURS}h. Verifying authorship…`);

  // 2. Verify each unseen/updated repo via its commits; keep AI-built ones.
  let checks = 0, aiFound = 0, summaries = 0;
  for (const r of repos) {
    if (overBudget()) { console.log("  ⏱ time budget reached — proceeding to write"); break; }
    const name = r.full_name;
    if (merged.has(name)) continue;                 // already in the feed — keep it
    const prev = checked[name];
    if (prev && !prev.ai && prev.pushedAt >= r.pushed_at) continue; // unchanged non-AI — skip
    if (checks >= MAX_CHECKS) continue;             // stay within the rate-limit budget

    const source = await verifyAI(name);
    checked[name] = { pushedAt: r.pushed_at, ai: !!source };
    checks++;
    await sleep(90);
    if (!source) continue;
    aiFound++;

    const language = r.language || "";
    const fallback = r.description || "";
    let summary = fallback, category = categorize(fallback, language);
    const cached = cache[name];
    if (cached) {
      summary = cached.summary;
      category = cached.category || categorize(summary, language);
    } else if (summaries < MAX_SUMMARIES) {
      const readme = await ghReadme(name);
      ({ summary, category } = await summarize(name, readme, fallback, language));
      cache[name] = { summary, category };
      summaries++;
      await sleep(1200);
    }

    merged.set(name, {
      source,
      repo: name,
      url: r.html_url,
      owner: r.owner?.login || "",
      avatar: r.owner?.avatar_url || "",
      summary,
      category,
      language,
      stars: r.stargazers_count || 0,
      createdAt: r.created_at,
      date: r.pushed_at,
    });
    console.log(`  + [${source}] ${name}`);
  }

  // Self-heal the backlog: re-apply the (improved) heuristic for free, then
  // spend a small LLM budget re-summarizing blanks and re-classifying "Other".
  for (const e of merged.values()) {
    if (!e.category || e.category === "Other") e.category = categorize(e.summary || "", e.language);
  }
  let healed = 0;
  for (const e of merged.values()) {
    if (overBudget() || healed >= HEAL_PER_RUN) break;
    const blank = !e.summary || e.summary.length < 8;
    if (!blank && e.category !== "Other") continue;
    if (blank) {
      const readme = await ghReadme(e.repo);
      if (!readme) continue;
      ({ summary: e.summary, category: e.category } = await summarize(e.repo, readme, e.summary || "", e.language));
    } else {
      const cat = await classify(e.repo, e.summary, e.language);
      if (!cat || cat === "Other") continue;
      e.category = cat;
    }
    cache[e.repo] = { summary: e.summary, category: e.category };
    healed++;
    await sleep(1100);
  }
  if (healed) console.log(`Healed ${healed} backlog entries (summaries/categories).`);

  // Refresh stars/forks/followers on a rotating slice, then score everything.
  const refreshed = await refreshStats(merged);
  if (refreshed) console.log(`Refreshed stats for ${refreshed} repos.`);
  for (const e of merged.values()) e.gemScore = gemScore(e);

  const entries = [...merged.values()].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  const feed = {
    generatedAt: new Date().toISOString(),
    discoveryHours: DISCOVERY_HOURS,
    count: entries.length,
    sources: SOURCES,
    categories: CATEGORIES,
    entries,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(feed, null, 2));
  await mkdir(dirname(CACHE), { recursive: true });
  await writeFile(CACHE, JSON.stringify(cache, null, 2));
  await writeFile(CHECKED, JSON.stringify(checked, null, 2));
  console.log(`\nChecked ${checks} repos, found ${aiFound} new AI-built (${summaries} summarized).`);
  console.log(`Feed now holds ${entries.length} repos → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
