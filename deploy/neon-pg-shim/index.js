'use strict';
// @neondatabase/serverless compatibility layer over node-postgres (see package.json). Implements what drizzle-orm's neon-http and neon-serverless
// adapters, @auth/drizzle-adapter and plain `neon(url)` callers use: tagged-template and (text, params, opts) calls, lazy query objects for
// sql.transaction([...]), fullResults / arrayMode, Pool, Client, neonConfig, types.
const pg = require('pg');

const pools = new Map();
function poolFor(conn) {
  const key = String(conn);
  if (!pools.has(key)) {
    const p = new pg.Pool({ connectionString: key, max: Number(process.env.PG_POOL_MAX || 10), idleTimeoutMillis: 30000 });
    p.on('error', () => {});
    pools.set(key, p);
  }
  return pools.get(key);
}

class QueryPromise {
  constructor(run, queryData) { this._run = run; this.queryData = queryData; }
  then(a, b) { return this._run().then(a, b); }
  catch(b) { return this._run().catch(b); }
  finally(f) { return this._run().finally(f); }
}

async function exec(client, data) {
  const arrayMode = !!data.opts.arrayMode;
  const res = await client.query({ text: data.text, values: data.values && data.values.length ? data.values : undefined, rowMode: arrayMode ? 'array' : undefined });
  if (data.opts.fullResults) {
    return { fields: (res.fields || []).map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })), rows: res.rows, rowCount: res.rowCount, rowAsArray: arrayMode, command: res.command };
  }
  return res.rows;
}

function neon(connectionString, baseOpts = {}) {
  const pool = poolFor(connectionString);
  function sql(strings, ...params) {
    let text, values, o;
    if (Array.isArray(strings) && strings.raw) {
      text = strings.reduce((acc, s, i) => acc + s + (i < params.length ? '$' + (i + 1) : ''), '');
      values = params; o = {};
    } else {
      text = strings; values = params[0] || []; o = params[1] || {};
    }
    const data = { text, values, opts: { ...baseOpts, ...o } };
    return new QueryPromise(() => exec(pool, data), data);
  }
  sql.query = (text, values, o) => sql(text, values, o);
  sql.transaction = async (queries, o = {}) => {
    const list = typeof queries === 'function' ? queries(sql) : queries;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const out = [];
      for (const q of list) out.push(await exec(c, { ...q.queryData, opts: { ...q.queryData.opts, ...o } }));
      await c.query('COMMIT');
      return out;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally { c.release(); }
  };
  return sql;
}

class Pool extends pg.Pool {}
class Client extends pg.Client {}
const neonConfig = { webSocketConstructor: undefined, wsProxy: undefined, useSecureWebSocket: true, pipelineConnect: false, fetchConnectionCache: true, poolQueryViaFetch: false };
class NeonDbError extends Error {}

module.exports = { neon, Pool, Client, neonConfig, types: pg.types, defaults: pg.defaults, NeonDbError, DatabaseError: pg.DatabaseError, escapeIdentifier: pg.escapeIdentifier, escapeLiteral: pg.escapeLiteral };
