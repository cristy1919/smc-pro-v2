import test from "node:test";
import assert from "node:assert/strict";
import {
  DurableStateRepository,
  MAX_OPEN_POSITION_ROWS,
  MAX_TRADE_PAGE_SIZE,
  trackSqlCursor,
} from "../cloudflare/worker/src/durable-state.js";

function makeCursor(values, rowsWritten = 0) {
  let index = 0;
  const cursor = {
    rowsRead: 0,
    rowsWritten,
    next() {
      if (index >= values.length) return { done: true, value: undefined };
      const value = values[index++];
      this.rowsRead = index;
      return { done: false, value };
    },
    toArray() {
      const output = [];
      let item;
      while (!(item = this.next()).done) output.push(item.value);
      return output;
    },
    one() {
      const output = this.toArray();
      if (output.length !== 1) throw new Error("Expected exactly one row");
      return output[0];
    },
    raw() {
      return this;
    },
    [Symbol.iterator]() {
      return this;
    },
  };
  return cursor;
}

test("SQL read counters update as cursor rows are consumed", () => {
  const usage = { sqlRowsRead: 0, sqlRowsWritten: 0, reads: 0, writes: 0 };
  const cursor = trackSqlCursor(makeCursor(["a", "b", "c"]), usage, true);

  assert.equal(usage.sqlRowsRead, 0);
  assert.deepEqual([...cursor], ["a", "b", "c"]);
  assert.equal(usage.sqlRowsRead, 3);
  assert.equal(usage.reads, 3);
});

test("SQL cursor counters support partial reads followed by toArray without double counting", () => {
  const usage = { sqlRowsRead: 0, sqlRowsWritten: 0, reads: 0, writes: 0 };
  const cursor = trackSqlCursor(makeCursor([1, 2, 3, 4]), usage, true);

  assert.equal(cursor.next().value, 1);
  assert.equal(usage.sqlRowsRead, 1);
  assert.deepEqual(cursor.toArray(), [2, 3, 4]);
  assert.equal(usage.sqlRowsRead, 4);
  assert.equal(usage.reads, 4);
});

test("SQL write counters are recorded immediately and exactly once", () => {
  const usage = { sqlRowsRead: 0, sqlRowsWritten: 0, reads: 0, writes: 0 };
  const cursor = trackSqlCursor(makeCursor([], 2), usage, false);

  assert.equal(usage.sqlRowsWritten, 2);
  assert.equal(usage.writes, 2);
  void cursor.rowsWritten;
  assert.equal(usage.sqlRowsWritten, 2);
});

test("trade history is bounded and supports stable keyset pagination", async () => {
  const calls = [];
  const rows = [
    { id: "t2", payload: JSON.stringify({ id: "t2" }), closed_at: 200 },
    { id: "t1", payload: JSON.stringify({ id: "t1" }), closed_at: 100 },
  ];
  const repository = new DurableStateRepository({
    storage: {
      sql: {
        exec(query, ...bindings) {
          calls.push({ query, bindings });
          return rows;
        },
      },
    },
  });

  const page = await repository.listTradesPage({ engine: "scalp", limit: 1 });
  assert.deepEqual(page.trades, [{ id: "t2" }]);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.nextCursor, { closedAt: 200, id: "t2" });
  assert.match(calls[0].query, /ORDER BY closed_at DESC, id DESC LIMIT \?/);
  assert.deepEqual(calls[0].bindings, ["scalp", 2]);

  await repository.listTradesPage({
    engine: "scalp",
    limit: 1,
    before: page.nextCursor,
  });
  assert.match(calls[1].query, /closed_at < \? OR \(closed_at = \? AND id < \?\)/);
  assert.deepEqual(calls[1].bindings, ["scalp", 200, 200, "t2", 2]);

  const capped = await repository.listTradesPage({ limit: 999999 });
  assert.equal(calls[2].bindings.at(-1), MAX_TRADE_PAGE_SIZE + 1);
  assert.equal(capped.trades.length, 2);
});

test("open-position reads have a fixed upper bound", async () => {
  let call;
  const repository = new DurableStateRepository({
    storage: {
      sql: {
        exec(query, ...bindings) {
          call = { query, bindings };
          return [];
        },
      },
    },
  });

  assert.deepEqual(await repository.listOpenPositions(), []);
  assert.match(call.query, /LIMIT \?/);
  assert.deepEqual(call.bindings, [MAX_OPEN_POSITION_ROWS]);
});
