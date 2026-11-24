// Durable Object adapter. Bind the existing SQLite-backed namespace; do not create a new namespace.
export class DurableStateRepository {
 constructor(state){this.state=state;this.sql=state.storage.sql;}
 async initialize(){this.sql.exec(`CREATE TABLE IF NOT EXISTS smc_v2_positions (id TEXT PRIMARY KEY, engine TEXT NOT NULL, symbol TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL)`);this.sql.exec(`CREATE TABLE IF NOT EXISTS smc_v2_trades (id TEXT PRIMARY KEY, engine TEXT NOT NULL, symbol TEXT NOT NULL, payload TEXT NOT NULL, closed_at INTEGER NOT NULL)`);this.sql.exec(`CREATE TABLE IF NOT EXISTS smc_v2_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);}
 async listOpenPositions(){return [...this.sql.exec("SELECT payload FROM smc_v2_positions WHERE state = 'OPEN'")].map(r=>JSON.parse(r.payload));}
 async savePosition(p){this.sql.exec("INSERT INTO smc_v2_positions(id,engine,symbol,payload,state,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,state=excluded.state,updated_at=excluded.updated_at",p.id,p.engine,p.symbol,JSON.stringify(p),p.state,Date.now());}
 async getPosition(id){const r=[...this.sql.exec("SELECT payload FROM smc_v2_positions WHERE id = ?",id)][0];return r?JSON.parse(r.payload):null;}
 async deletePosition(id){this.sql.exec("DELETE FROM smc_v2_positions WHERE id = ?",id);}
 async saveTrade(t){this.sql.exec("INSERT OR REPLACE INTO smc_v2_trades(id,engine,symbol,payload,closed_at) VALUES(?,?,?,?,?)",t.id,t.engine,t.symbol,JSON.stringify(t),t.closedAt);}
 async listTrades(engine=null){const q=engine?"SELECT payload FROM smc_v2_trades WHERE engine = ? ORDER BY closed_at DESC":"SELECT payload FROM smc_v2_trades ORDER BY closed_at DESC";return [...(engine?this.sql.exec(q,engine):this.sql.exec(q))].map(r=>JSON.parse(r.payload));}
 async getMeta(key){const r=[...this.sql.exec("SELECT value FROM smc_v2_meta WHERE key = ?",key)][0];return r?JSON.parse(r.value):null;}
 async putMeta(key,value){this.sql.exec("INSERT INTO smc_v2_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",key,JSON.stringify(value));}
}
