#!/usr/bin/env node
// Builds README.md and assets/languages.svg from live GitHub data.
//
//   GITHUB_TOKEN=… node scripts/build-readme.mjs
//
// Everything that changes on its own (repos, languages, streak, activity, the game board) is read
// from the API on each run, so a new repo or a push shows up without editing this file. Dates are
// absolute, never "3h ago", so the README only changes (and only gets committed) when the data does.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadState, renderBoard } from "./game.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "profile.config.json"), "utf8"));
const LOGIN = config.login;
const REPO = process.env.GITHUB_REPOSITORY || `${LOGIN}/${LOGIN}`;
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!TOKEN) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

async function api(url, init = {}) {
  const res = await fetch(url.startsWith("http") ? url : `https://api.github.com${url}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`);
  return res.json();
}

const gql = async (query, variables) => {
  const out = await api("/graphql", { method: "POST", body: JSON.stringify({ query, variables }) });
  if (out.errors) throw new Error(JSON.stringify(out.errors));
  return out.data;
};

const data = await gql(
  `query($login: String!) {
    user(login: $login) {
      name createdAt
      followers { totalCount }
      repositories(first: 100, ownerAffiliations: OWNER, privacy: PUBLIC, orderBy: { field: PUSHED_AT, direction: DESC }) {
        totalCount
        nodes {
          name description url isFork isArchived stargazerCount forkCount pushedAt createdAt
          primaryLanguage { name color }
          languages(first: 12, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name color } } }
        }
      }
      contributionsCollection {
        totalCommitContributions totalPullRequestContributions totalIssueContributions restrictedContributionsCount
        contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
      }
    }
  }`,
  { login: LOGIN },
);
const user = data.user;
const events = await api(`/users/${LOGIN}/events/public?per_page=60`).catch(() => []);

// ------------------------------------------------------------------ helpers
const TZ = config.timezone || "UTC";
const day = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const stamp = (iso) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};
const nb = (d) => d.replace(/-/g, "\u2011"); // keep table dates on one line
const daysSince = (iso) => Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
const fmt = (n) => n.toLocaleString("en-US");
const pad = (s, n) => String(s).padEnd(n);
const esc = (s) => String(s ?? "").replace(/[|<>]/g, (c) => ({ "|": "\\|", "<": "&lt;", ">": "&gt;" })[c]);
const xml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const repos = user.repositories.nodes.filter((r) => !r.isFork && !(config.hideRepos || []).includes(r.name));
const stars = repos.reduce((s, r) => s + r.stargazerCount, 0);

// languages by code size across own public repos
const langs = new Map();
for (const r of repos)
  for (const e of r.languages.edges) {
    if ((config.excludeLanguages || []).includes(e.node.name)) continue;
    const cur = langs.get(e.node.name) || { name: e.node.name, color: e.node.color || "#8b949e", size: 0 };
    cur.size += e.size;
    langs.set(e.node.name, cur);
  }
const langTotal = [...langs.values()].reduce((s, l) => s + l.size, 0) || 1;
const langList = [...langs.values()].sort((a, b) => b.size - a.size).map((l) => ({ ...l, pct: (l.size / langTotal) * 100 }));
const topLangs = langList.slice(0, 7);
const otherPct = langList.slice(7).reduce((s, l) => s + l.pct, 0);
if (otherPct > 0.05) topLangs.push({ name: "Other", color: "#6e7681", pct: otherPct });

// contribution streaks from the last year's calendar
const cal = user.contributionsCollection.contributionCalendar;
const daysCal = cal.weeks.flatMap((w) => w.contributionDays);
const today = day(new Date().toISOString());
let best = 0, run = 0;
for (const d of daysCal) {
  run = d.contributionCount > 0 ? run + 1 : 0;
  best = Math.max(best, run);
}
let streak = 0;
for (let i = daysCal.length - 1; i >= 0; i--) {
  const d = daysCal[i];
  if (d.date > today) continue;
  if (d.contributionCount > 0) streak++;
  else if (d.date === today) continue; // today isn't over yet
  else break;
}
const busiest = daysCal.reduce((a, d) => (d.contributionCount > a.contributionCount ? d : a), { contributionCount: 0, date: "" });
const weekday = (() => {
  const totals = Array(7).fill(0);
  for (const d of daysCal) totals[new Date(d.date + "T00:00:00Z").getUTCDay()] += d.contributionCount;
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][totals.indexOf(Math.max(...totals))];
})();

// ------------------------------------------------------------------ neofetch
const age = (() => {
  const d = new Date(user.createdAt), n = new Date();
  let months = (n.getFullYear() - d.getFullYear()) * 12 + n.getMonth() - d.getMonth();
  if (n.getDate() < d.getDate()) months--;
  return `${Math.floor(months / 12)}y ${months % 12}m`;
})();
const lastPush = repos[0];
const newest = [...repos].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
const ART = [
  "    ___    _   ______  ____",
  "   /   |  / | / / __ \\/  _/",
  "  / /| | /  |/ / / / // /",
  " / ___ |/ /|  / /_/ // /",
  "/_/  |_/_/ |_/_____/___/",
  "",
  " +-------------------------+",
  " | :::::::::::  [##]   o o |",
  " +-------------------------+",
  " | :::::::::::  [##]   o o |",
  " +-------------------------+",
];
const info = [
  [`${LOGIN.slice(0, 4)}@${config.host}`, ""],
  ["-".repeat(`${LOGIN.slice(0, 4)}@${config.host}`.length), ""],
  ["Role", config.role],
  ["Study", config.study],
  ["Location", config.location],
  ["Uptime", `${age} on GitHub`],
  ["Repos", `${repos.length} public, ${fmt(stars)} star${stars === 1 ? "" : "s"}, ${fmt(user.followers.totalCount)} follower${user.followers.totalCount === 1 ? "" : "s"}`],
  ["Languages", topLangs.filter((l) => l.name !== "Other").slice(0, 3).map((l) => `${l.name} ${l.pct.toFixed(0)}%`).join(", ")],
  ["Commits", `${fmt(user.contributionsCollection.totalCommitContributions)} in the last 12 months, ${fmt(cal.totalContributions)} contributions`],
  ["Streak", `${streak} day${streak === 1 ? "" : "s"} now, best ${best}`],
  ["Last push", lastPush ? `${lastPush.name} on ${day(lastPush.pushedAt)}` : "-"],
  ["Newest", newest ? `${newest.name} (${day(newest.createdAt)})` : "-"],
];
const neofetch = info
  .map(([k, v], i) => {
    const art = pad(ART[i] ?? "", 31);
    const text = i < 2 ? k : `${pad(k, 10)}${v}`;
    return (art + text).trimEnd();
  })
  .join("\n");

// ------------------------------------------------------------------ projects
const byName = new Map(repos.map((r) => [r.name.toLowerCase(), r]));
const health = (iso) => {
  const d = daysSince(iso);
  return d <= 7 ? "🟢 active" : d <= 60 ? "🟡 maintained" : "⚪ idle";
};
const featuredRows = config.featured.map((f) => {
  const r = f.repo ? byName.get(f.repo.toLowerCase()) : null;
  const url = r?.url || f.url;
  const lang = r?.primaryLanguage?.name || f.language || "-";
  const status = f.status === "live" ? "🟢 live" : r ? health(r.pushedAt) : "-";
  const meta = r ? `★ ${r.stargazerCount} · ${nb(day(r.pushedAt))}` : new URL(url).host;
  return `| **[${esc(f.title)}](${url})** | ${esc(f.blurb)} | \`${esc(lang)}\` | ${status}<br><sub>${meta}</sub> |`;
});
const featuredNames = new Set(config.featured.filter((f) => f.repo).map((f) => f.repo.toLowerCase()));
const recentRows = repos
  .filter((r) => !featuredNames.has(r.name.toLowerCase()) && !r.isArchived)
  .slice(0, 6)
  .map((r) => `| **[${esc(r.name)}](${r.url})** | ${esc(r.description || "—")} | ${r.primaryLanguage ? `\`${esc(r.primaryLanguage.name)}\`` : "—"} | ${nb(day(r.pushedAt))} |`);

// ------------------------------------------------------------------ activity log
const short = (full) => full.split("/")[1] || full;
const lines = [];
for (const e of [...events].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
  const repo = short(e.repo?.name || "");
  const p = e.payload || {};
  let kind = null, what = "";
  if (e.type === "PushEvent") {
    const n = p.size ?? p.commits?.length ?? p.distinct_size ?? 1;
    kind = "push";
    what = `${n} commit${n === 1 ? "" : "s"} to ${(p.ref || "").replace("refs/heads/", "") || "main"}`;
  } else if (e.type === "CreateEvent" && p.ref_type === "repository") {
    kind = "create"; what = "new repository";
  } else if (e.type === "CreateEvent" && p.ref_type === "tag") {
    kind = "tag"; what = p.ref;
  } else if (e.type === "ReleaseEvent" && p.action === "published") {
    kind = "release"; what = p.release?.tag_name || p.release?.name || "";
  } else if (e.type === "PullRequestEvent" && ["opened", "closed"].includes(p.action)) {
    kind = p.pull_request?.merged ? "merge" : p.action === "opened" ? "pr" : null;
    what = `#${p.number} ${p.pull_request?.title || ""}`;
  } else if (e.type === "PublicEvent") {
    kind = "public"; what = "made public";
  } else if (e.type === "WatchEvent" && !e.repo?.name?.startsWith(`${LOGIN}/`)) {
    kind = "star"; what = "starred";
  } else if (e.type === "ForkEvent" && !e.repo?.name?.startsWith(`${LOGIN}/`)) {
    kind = "fork"; what = "forked";
  }
  if (!kind) continue;
  const prev = lines[lines.length - 1];
  // fold a burst of pushes to one repo into a single line
  if (kind === "push" && prev && prev.kind === "push" && prev.repo === repo && prev.date === day(e.created_at)) {
    const n = Number(prev.what.split(" ")[0]) + Number(what.split(" ")[0]);
    prev.what = `${n} commits to ${prev.what.split(" to ")[1]}`;
    continue;
  }
  lines.push({ at: stamp(e.created_at), date: day(e.created_at), kind, repo, what });
  if (lines.length >= 8) break;
}
const activity = lines.length
  ? lines.map((l) => `${l.at}  ${pad(l.kind, 8)} ${pad(l.repo.slice(0, 22), 23)} ${l.what}`.slice(0, 96)).join("\n")
  : "-- no public activity in the last 90 days --";

// ------------------------------------------------------------------ languages.svg
function languagesSvg() {
  const W = 840, barY = 50, barH = 14, colW = W / 2;
  let x = 0;
  const segs = topLangs
    .map((l) => {
      const w = Math.max((l.pct / 100) * W, 2);
      const s = `<rect x="${x.toFixed(2)}" y="${barY}" width="${w.toFixed(2)}" height="${barH}" fill="${l.color}"/>`;
      x += w;
      return s;
    })
    .join("");
  const legend = topLangs
    .map((l, i) => {
      const lx = (i % 2) * colW, ly = barY + barH + 34 + Math.floor(i / 2) * 28;
      return `<g transform="translate(${lx},${ly})"><circle cx="6" cy="-5" r="6" fill="${l.color}"/><text x="20" y="0" class="n">${xml(l.name)}</text><text x="${colW - 40}" y="0" class="p" text-anchor="end">${l.pct.toFixed(1)}%</text></g>`;
    })
    .join("");
  const H = barY + barH + 34 + Math.ceil(topLangs.length / 2) * 28;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Languages by code size">
<style>
  text { font: 500 15px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; fill: #8b949e; }
  .t { font-size: 14px; } .n { fill: #8b949e; } .p { fill: #8b949e; opacity: .8; }
</style>
<text x="0" y="22" class="t"># ${repos.length} public repos, ${(langTotal / 1e6).toFixed(1)} MB of code, by bytes</text>
<clipPath id="r"><rect x="0" y="${barY}" width="${W}" height="${barH}" rx="7"/></clipPath>
<g clip-path="url(#r)">${segs}</g>
${legend}
</svg>
`;
}

// ------------------------------------------------------------------ game
const game = loadState();
const g = game.board;
const gameStatus = {
  new: "A fresh disk. Your first click is always safe.",
  playing: `Scan in progress: ${g.revealed.length} of ${config.game.cols * config.game.rows - config.game.mines} clean sectors found, ${g.moves} move${g.moves === 1 ? "" : "s"} by ${g.players.length} player${g.players.length === 1 ? "" : "s"}.`,
  won: `🏆 Disk recovered in ${g.moves} moves. Click any sector to format a new one.`,
  lost: `💥 Bad sector hit after ${g.moves} moves. Click any sector to format a new disk.`,
}[g.status];
const top = Object.entries(game.stats.players).sort((a, b) => b[1] - a[1]).slice(0, 5);
const recent = game.recent.length
  ? game.recent.map((m) => `\`${m.cell}\` ${{ clean: "✅", won: "🏆", lost: "💥" }[m.result] || "·"} [@${m.login}](https://github.com/${m.login})`).join(" &nbsp; ")
  : "_No moves yet. Be the first._";

// ------------------------------------------------------------------ README
const badge = ([label, color, logo, logoColor]) =>
  `<img src="https://img.shields.io/badge/${encodeURIComponent(label).replace(/-/g, "--")}-${color}?style=flat-square&logo=${logo}&logoColor=${logoColor}" alt="${label}">`;
const link = ([label, url, color, logo]) =>
  `<a href="${url}"><img src="https://img.shields.io/badge/${encodeURIComponent(label)}-${color}?style=for-the-badge&logo=${logo}&logoColor=white" alt="${label}"></a>`;
const snake = `https://raw.githubusercontent.com/${REPO}/output`;

const body = `<!-- Generated by scripts/build-readme.mjs. Edit profile.config.json or the script, not this file. -->

\`\`\`text
${LOGIN.slice(0, 4)}@${config.host}:~$ neofetch
${neofetch}
\`\`\`

${config.about.join(" ")}

## \`$ systemctl status --featured\`

| Project | What it does | Stack | Status |
|:--|:--|:-:|:--|
${featuredRows.join("\n")}

## \`$ ls -t ~/repos | head\`

<sub>Picked up automatically from my latest pushes. A new repository shows up here on the next refresh.</sub>

| Repository | Description | Language | Last push |
|:--|:--|:-:|:-:|
${recentRows.join("\n")}

## \`$ du -sh --by-language\`

<img src="assets/languages.svg" alt="Languages by code size: ${topLangs.map((l) => `${l.name} ${l.pct.toFixed(0)}%`).join(", ")}" width="100%">

## \`$ git log --since=1.year\`

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="${snake}/github-snake-dark.svg">
  <img alt="Contribution graph being eaten by a snake" src="${snake}/github-snake.svg" width="100%">
</picture>

| Contributions | Commits | Pull requests | Current streak | Longest streak | Busiest day | Favourite weekday |
|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **${fmt(cal.totalContributions)}** | ${fmt(user.contributionsCollection.totalCommitContributions)} | ${fmt(user.contributionsCollection.totalPullRequestContributions)} | ${streak} day${streak === 1 ? "" : "s"} | ${best} days | ${busiest.date ? `${busiest.date} (${busiest.contributionCount})` : "-"} | ${weekday} |

## \`$ tail -f activity.log\`

\`\`\`text
${activity}
\`\`\`

## 💾 Disk Sweeper

Somewhere on this disk are **${config.game.mines} bad sectors**. Click a 🟦 sector to scan it: it opens an issue, press **Create**, and a GitHub Action plays your move and updates this page in about a minute. Numbers tell you how many bad sectors touch that one. Clear every clean sector to recover the disk.

<div align="center">

${renderBoard(game, REPO)}

${gameStatus}

</div>

**Recent moves** &nbsp; ${recent}

<sub>Games ${fmt(game.stats.games)} · recovered ${fmt(game.stats.wins)} · lost ${fmt(game.stats.losses)} · moves ${fmt(game.stats.moves)}${top.length ? ` · most moves: ${top.map(([l, n]) => `@${l} (${n})`).join(", ")}` : ""}</sub>

## \`$ cat stack.txt\`

${config.stack.map(badge).join(" ")}

## \`$ ping andi\`

${config.links.map(link).join(" ")}

---

<sub>${esc(config.tagline)} &nbsp;·&nbsp; This README rebuilds itself every hour from the GitHub API (<a href="scripts/build-readme.mjs">scripts/build-readme.mjs</a>).</sub>
`;

const readmePath = path.join(ROOT, "README.md");
const footer = (when) => `\n<sub>Last changed ${when} WIB.</sub>\n`;
const old = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, "utf8") : "";
const oldBody = old.replace(/\n<sub>Last changed [^<]*<\/sub>\n$/, "");
fs.mkdirSync(path.join(ROOT, "assets"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "assets", "languages.svg"), languagesSvg());
if (oldBody !== body) {
  fs.writeFileSync(readmePath, body + footer(stamp(new Date().toISOString())));
  console.log("README.md updated");
} else {
  console.log("README.md unchanged");
}
