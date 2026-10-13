import assert from "node:assert/strict";
import test from "node:test";
import { parseTitle, applyMove, freshState, renderBoard, cellName, countAround } from "../scripts/game.mjs";

const seeded = (seed) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

test("parses only well-formed moves", () => {
  assert.equal(parseTitle("disk|reveal|A1"), 0);
  assert.equal(parseTitle("disk|reveal|h8"), 63);
  assert.equal(parseTitle(" disk|reveal|C4 "), 3 * 8 + 2);
  for (const bad of ["disk|reveal|I1", "disk|reveal|A9", "disk|reveal|A0", "disk|reveal|A1; rm -rf /", "disk|reveal|", "hello", "disk|reveal|AA1"])
    assert.equal(parseTitle(bad), null, bad);
});

test("first move is safe and opens an area; mines are planted once", () => {
  const s = freshState();
  const r = applyMove(s, parseTitle("disk|reveal|D4"), "alice", seeded(7));
  assert.equal(r.result, "clean");
  assert.equal(s.board.mines.length, 10);
  assert.ok(!s.board.mines.includes(parseTitle("disk|reveal|D4")));
  assert.equal(countAround(s.board, parseTitle("disk|reveal|D4")), 0);
  assert.ok(s.board.revealed.length > 1);
  const mines = [...s.board.mines];
  applyMove(s, s.board.revealed[0], "bob", seeded(9));
  assert.deepEqual(s.board.mines, mines);
});

test("re-revealing an open cell is not a move", () => {
  const s = freshState();
  applyMove(s, 0, "a", seeded(3));
  const moves = s.stats.moves;
  assert.equal(applyMove(s, 0, "a", seeded(3)).result, "already");
  assert.equal(s.stats.moves, moves);
});

test("hitting a mine loses; next move starts a new disk", () => {
  const s = freshState();
  applyMove(s, 0, "a", seeded(5));
  const r = applyMove(s, s.board.mines[0], "b");
  assert.equal(r.result, "lost");
  assert.equal(s.stats.losses, 1);
  assert.match(renderBoard(s, "o/o"), /💥/);
  applyMove(s, 63, "c", seeded(11));
  assert.equal(s.board.status, "playing");
  assert.equal(s.stats.games, 2);
});

test("revealing every clean cell wins", () => {
  const s = freshState();
  applyMove(s, 0, "a", seeded(13));
  let last;
  for (let i = 0; i < 64; i++) if (!s.board.mines.includes(i) && !s.board.revealed.includes(i)) last = applyMove(s, i, "w");
  assert.equal(last.result, "won");
  assert.equal(s.stats.wins, 1);
  assert.match(renderBoard(s, "o/o"), /🚩/);
});

test("board links encode the move as an issue title", () => {
  const md = renderBoard(freshState(), "owner/owner");
  assert.match(md, /issues\/new\?title=disk%7Creveal%7CA1&/);
  assert.equal((md.match(/🟦/g) || []).length, 64);
  assert.equal(cellName(63), "H8");
});
