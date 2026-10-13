#!/usr/bin/env node
// Disk Sweeper: minesweeper on the profile README, played through GitHub Issues.
//
// Every hidden sector on the board links to "new issue" with a title like `disk|reveal|C4`.
// The profile workflow then runs:
//   node scripts/game.mjs process   apply every open `disk|…` issue to game/state.json
//   node scripts/game.mjs reply     after the README is pushed: comment on and close those issues
//
// Issue titles are user input. They are only ever matched against TITLE below and never reach a
// shell; anything that does not match is answered and closed without touching the game.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_FILE = path.join(ROOT, "game", "state.json");
const REPLIES_FILE = path.join(ROOT, ".replies.json");
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "profile.config.json"), "utf8"));
const { cols: COLS, rows: ROWS, mines: MINES } = config.game;
const LETTERS = "ABCDEFGHIJKLMNOP".slice(0, COLS);
const TITLE = new RegExp(`^disk\\|reveal\\|([${LETTERS}])([1-9][0-9]?)$`, "i");
const MAX_MOVES_PER_RUN = 25;
const RECENT = 6;

export const cellName = (i) => `${LETTERS[i % COLS]}${Math.floor(i / COLS) + 1}`;

/** `disk|reveal|C4` -> cell index, or null when the title is not a valid move. */
export function parseTitle(title) {
  const m = String(title || "").trim().match(TITLE);
  if (!m) return null;
  const col = LETTERS.indexOf(m[1].toUpperCase());
  const row = Number(m[2]) - 1;
  if (col < 0 || row < 0 || row >= ROWS) return null;
  return row * COLS + col;
}

function neighbours(i) {
  const x = i % COLS, y = Math.floor(i / COLS), out = [];
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if ((dx || dy) && nx >= 0 && ny >= 0 && nx < COLS && ny < ROWS) out.push(ny * COLS + nx);
    }
  return out;
}

export function freshBoard() {
  return { status: "new", mines: [], revealed: [], hit: null, moves: 0, players: [], startedAt: null };
}

export function freshState() {
  return { board: freshBoard(), stats: { games: 0, wins: 0, losses: 0, moves: 0, players: {} }, recent: [], last: null };
}

export function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return freshState();
  }
}

export const countAround = (board, i) => neighbours(i).filter((n) => board.mines.includes(n)).length;

/** Plant the bad sectors on the first move, never on or next to the first cell, so it opens an area. */
function plant(board, first, rng) {
  const banned = new Set([first, ...neighbours(first)]);
  const pool = [...Array(COLS * ROWS).keys()].filter((i) => !banned.has(i));
  const mines = [];
  while (mines.length < MINES && pool.length) mines.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  board.mines = mines.sort((a, b) => a - b);
}

/**
 * Apply one move. Returns { result, text } where result is one of
 * "clean" | "won" | "lost" | "already" and text is the reply posted on the issue.
 */
export function applyMove(state, cell, login, rng = Math.random, now = new Date().toISOString()) {
  let board = state.board;
  if (board.status === "won" || board.status === "lost") board = state.board = freshBoard();
  const name = cellName(cell);
  if (board.revealed.includes(cell)) {
    return { result: "already", text: `Sector **${name}** is already open. Pick a hidden one 🟦.` };
  }
  if (board.status === "new") {
    plant(board, cell, rng);
    board.status = "playing";
    board.startedAt = now;
    state.stats.games += 1;
  }
  board.moves += 1;
  if (!board.players.includes(login)) board.players.push(login);
  state.stats.moves += 1;
  state.stats.players[login] = (state.stats.players[login] || 0) + 1;

  let result, text;
  if (board.mines.includes(cell)) {
    board.status = "lost";
    board.hit = cell;
    state.stats.losses += 1;
    result = "lost";
    text = `💥 **${name}** was a bad sector. The disk is gone after ${board.moves} moves. Click any sector to format a new disk.`;
  } else {
    // flood-fill clean sectors with no bad neighbours, like `fsck` walking the free blocks
    const queue = [cell];
    const seen = new Set(board.revealed);
    while (queue.length) {
      const i = queue.shift();
      if (seen.has(i)) continue;
      seen.add(i);
      board.revealed.push(i);
      if (countAround(board, i) === 0) for (const n of neighbours(i)) if (!seen.has(n) && !board.mines.includes(n)) queue.push(n);
    }
    const n = countAround(board, cell);
    if (board.revealed.length === COLS * ROWS - MINES) {
      board.status = "won";
      state.stats.wins += 1;
      result = "won";
      text = `🏆 **${name}** was the last clean sector. The disk is healthy after ${board.moves} moves with ${board.players.length} player(s). Click any sector to start a new disk.`;
    } else {
      result = "clean";
      text = n === 0
        ? `✅ **${name}** is clean and so is everything around it.`
        : `✅ **${name}** is clean. ${n} bad sector${n > 1 ? "s" : ""} nearby.`;
    }
  }
  state.last = { login, cell: name, result, at: now };
  state.recent = [{ login, cell: name, result, at: now }, ...state.recent].slice(0, RECENT);
  return { result, text };
}

const NUM = ["⬛", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣"];

export function moveUrl(repo, i) {
  const title = encodeURIComponent(`disk|reveal|${cellName(i)}`);
  const body = encodeURIComponent(
    `Press **Create** to scan ${cellName(i)}. A bot plays it and closes this issue.`,
  );
  return `https://github.com/${repo}/issues/new?title=${title}&body=${body}`;
}

/** The board as a Markdown table. Hidden sectors are links that open the move as an issue. */
export function renderBoard(state, repo) {
  const b = state.board;
  const over = b.status === "won" || b.status === "lost";
  const head = `| |${[...LETTERS].map((l) => ` ${l} |`).join("")}\n|:-:|${[...LETTERS].map(() => ":-:|").join("")}`;
  const rows = [];
  for (let y = 0; y < ROWS; y++) {
    const cells = [];
    for (let x = 0; x < COLS; x++) {
      const i = y * COLS + x;
      let c;
      if (b.revealed.includes(i)) c = NUM[countAround(b, i)];
      else if (over && i === b.hit) c = "💥";
      else if (over && b.mines.includes(i)) c = b.status === "won" ? "🚩" : "💣";
      else c = `[🟦](${moveUrl(repo, i)})`;
      cells.push(` ${c} |`);
    }
    rows.push(`| **${y + 1}** |${cells.join("")}`);
  }
  return `${head}\n${rows.join("\n")}`;
}

// ---------------------------------------------------------------- GitHub side

async function gh(method, url, body) {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function processIssues() {
  const repo = process.env.GITHUB_REPOSITORY;
  const issues = (await gh("GET", `/repos/${repo}/issues?state=open&sort=created&direction=asc&per_page=100`))
    .filter((i) => !i.pull_request && /^disk\|/i.test(i.title))
    .slice(0, MAX_MOVES_PER_RUN);
  const state = loadState();
  const replies = [];
  for (const issue of issues) {
    const login = String(issue.user?.login || "someone").replace(/[^A-Za-z0-9-[\]]/g, "");
    const cell = parseTitle(issue.title);
    if (cell === null) {
      replies.push({ number: issue.number, text: "That move wasn't understood. Use the 🟦 links on the profile board to pick a sector." });
      continue;
    }
    const { text } = applyMove(state, cell, login);
    replies.push({ number: issue.number, text });
  }
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  fs.writeFileSync(REPLIES_FILE, JSON.stringify(replies));
  console.log(`processed ${replies.length} move(s)`);
}

async function reply() {
  const repo = process.env.GITHUB_REPOSITORY;
  const owner = repo.split("/")[0];
  let replies = [];
  try {
    replies = JSON.parse(fs.readFileSync(REPLIES_FILE, "utf8"));
  } catch {
    return;
  }
  for (const r of replies) {
    await gh("POST", `/repos/${repo}/issues/${r.number}/comments`, {
      body: `${r.text}\n\n[Back to the board ↩](https://github.com/${owner}#-disk-sweeper)`,
    });
    await gh("PATCH", `/repos/${repo}/issues/${r.number}`, { state: "closed", state_reason: "completed" });
  }
  console.log(`replied to ${replies.length} issue(s)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === "process") await processIssues();
  else if (cmd === "reply") await reply();
  else {
    console.error("usage: game.mjs process|reply");
    process.exit(2);
  }
}
