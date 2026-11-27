// Durable Object adapter. Bind the existing SQLite-backed namespace; do not create a new namespace.

export const DEFAULT_TRADE_PAGE_SIZE = 100;
export const MAX_TRADE_PAGE_SIZE = 500;
export const MAX_OPEN_POSITION_ROWS = 20;

/**
 * Wrap a Durable Object SQL cursor so usage counters are updated as rows are
 * actually consumed. SqlStorageCursor.rowsRead is incremental, not final at
 * exec() return time.
 */
export function trackSqlCursor(cursor, usageCounters, isRead) {
  let accountedRead = 0;
  let accountedWritten = 0;

  const record = () => {
    const currentRead = Math.max(accountedRead, Number(cursor.rowsRead) || 0);
    const currentWritten = Math.max(accountedWritten, Number(cursor.rowsWritten) || 0);
    const readDelta = currentRead - accountedRead;
    const writtenDelta = currentWritten - accountedWritten;

    if (readDelta > 0) {
      usageCounters.sqlRowsRead = (Number(usageCounters.sqlRowsRead) || 0) + readDelta;
      if (isRead) usageCounters.reads = (Number(usageCounters.reads) || 0) + readDelta;
      accountedRead = currentRead;
    }
    if (writtenDelta > 0) {
      usageCounters.sqlRowsWritten = (Number(usageCounters.sqlRowsWritten) || 0) + writtenDelta;
      if (!isRead) usageCounters.writes = (Number(usageCounters.writes) || 0) + writtenDelta;
      accountedWritten = currentWritten;
    }
  };

  const wrapIterator = (iterator) => ({
    next(...args) {
      const result = iterator.next(...args);
      record();
      return result;
    },
    return(...args) {
      const result = typeof iterator.return === "function"
        ? iterator.return(...args)
        : { done: true, value: args[0] };
      record();
      return result;
    },
    [Symbol.iterator]() {
      return this;
    },
  });

  // Writes can be accounted immediately; reads are accounted incrementally.
  record();

  return new Proxy(cursor, {
    get(target, property) {
      if (property === "rowsRead" || property === "rowsWritten") {
        record();
        return Reflect.get(target, property, target);
      }
      if (property === Symbol.iterator) {
        return () => wrapIterator(target[Symbol.iterator]());
      }
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "raw") {
        return (...args) => wrapIterator(value.apply(target, args));
      }
      if (property === "next" || property === "toArray" || property === "one") {
        return (...args) => {
          const result = value.apply(target, args);
          record();
          return result;
        };
      }
      return value.bind(target);
    },
  });
}

export class DurableStateRepository {
  constructor(state) {
    this.state = state;
    this.sql = state.storage.sql;
  }

  async initialize() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS smc_v2_positions (id TEXT PRIMARY KEY, engine TEXT NOT NULL, symbol TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS smc_v2_trades (id TEXT PRIMARY KEY, engine TEXT NOT NULL, symbol TEXT NOT NULL, payload TEXT NOT NULL, closed_at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS smc_v2_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  }

  async listOpenPositions() {
    return [...this.sql.exec(
      "SELECT payload FROM smc_v2_positions WHERE state = 'OPEN' ORDER BY updated_at DESC LIMIT ?",
      MAX_OPEN_POSITION_ROWS,
    )].map((row) => JSON.parse(row.payload));
  }

  async savePosition(position) {
    this.sql.exec(
      "INSERT INTO smc_v2_positions(id,engine,symbol,payload,state,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,state=excluded.state,updated_at=excluded.updated_at",
      position.id,
      position.engine,
      position.symbol,
      JSON.stringify(position),
      position.state,
      Date.now(),
    );
  }

  async getPosition(id) {
    const row = [...this.sql.exec("SELECT payload FROM smc_v2_positions WHERE id = ? LIMIT 1", id)][0];
    return row ? JSON.parse(row.payload) : null;
  }

  async deletePosition(id) {
    this.sql.exec("DELETE FROM smc_v2_positions WHERE id = ?", id);
  }

  async saveTrade(trade) {
    this.sql.exec(
      "INSERT OR REPLACE INTO smc_v2_trades(id,engine,symbol,payload,closed_at) VALUES(?,?,?,?,?)",
      trade.id,
      trade.engine,
      trade.symbol,
      JSON.stringify(trade),
      trade.closedAt,
    );
  }

  async listTradesPage({ engine = null, limit = DEFAULT_TRADE_PAGE_SIZE, before = null } = {}) {
    const pageSize = Math.max(1, Math.min(MAX_TRADE_PAGE_SIZE, Math.floor(Number(limit) || DEFAULT_TRADE_PAGE_SIZE)));
    const hasCursor = before && Number.isFinite(Number(before.closedAt)) && typeof before.id === "string";
    const clauses = [];
    const bindings = [];

    if (engine) {
      clauses.push("engine = ?");
      bindings.push(engine);
    }
    if (hasCursor) {
      clauses.push("(closed_at < ? OR (closed_at = ? AND id < ?))");
      bindings.push(Number(before.closedAt), Number(before.closedAt), before.id);
    }

    const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    const rows = [...this.sql.exec(
      "SELECT id,payload,closed_at FROM smc_v2_trades" + where +
      " ORDER BY closed_at DESC, id DESC LIMIT ?",
      ...bindings,
      pageSize + 1,
    )];

    const hasMore = rows.length > pageSize;
    const pageRows = rows.slice(0, pageSize);
    const last = pageRows.at(-1);
    return {
      trades: pageRows.map((row) => JSON.parse(row.payload)),
      hasMore,
      nextCursor: hasMore && last
        ? { closedAt: Number(last.closed_at), id: String(last.id) }
        : null,
    };
  }

  async listTrades(engine = null, limit = DEFAULT_TRADE_PAGE_SIZE) {
    return (await this.listTradesPage({ engine, limit })).trades;
  }

  async getMeta(key) {
    const row = [...this.sql.exec("SELECT value FROM smc_v2_meta WHERE key = ? LIMIT 1", key)][0];
    return row ? JSON.parse(row.value) : null;
  }

  async putMeta(key, value) {
    this.sql.exec(
      "INSERT INTO smc_v2_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    );
  }
}
