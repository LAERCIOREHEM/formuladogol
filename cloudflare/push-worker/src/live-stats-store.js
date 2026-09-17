function text(value) { return String(value == null ? '' : value).trim(); }
function finiteInt(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

export function createLiveStatsStore(db) {
  if (!db || typeof db.prepare !== 'function') return null;

  return {
    async get(key, now = Date.now()) {
      const row = await db.prepare(
        'SELECT payload_json, updated_at, expires_at FROM live_stats_cache WHERE cache_key=? AND expires_at>?'
      ).bind(text(key), Number(now)).first();
      if (!row?.payload_json) return null;
      try {
        return { ...JSON.parse(row.payload_json), _storeUpdatedAt: Number(row.updated_at || 0), _storeExpiresAt: Number(row.expires_at || 0) };
      } catch (_) {
        return null;
      }
    },

    async put(key, payload, ttlSeconds, now = Date.now()) {
      const updatedAt = Number(now);
      const expiresAt = updatedAt + Math.max(1, Number(ttlSeconds) || 1) * 1000;
      await db.prepare(`
        INSERT INTO live_stats_cache (cache_key, payload_json, updated_at, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          payload_json=excluded.payload_json,
          updated_at=excluded.updated_at,
          expires_at=excluded.expires_at
      `).bind(text(key), JSON.stringify(payload ?? null), updatedAt, expiresAt).run();
      return { updatedAt, expiresAt };
    },

    async acquireLease(key, ttlSeconds = 25, now = Date.now()) {
      const leaseKey = text(key);
      const acquiredAt = Number(now);
      const expiresAt = acquiredAt + Math.max(5, Number(ttlSeconds) || 25) * 1000;
      await db.prepare('DELETE FROM live_stats_leases WHERE lease_key=? AND expires_at<=?')
        .bind(leaseKey, acquiredAt).run();
      const result = await db.prepare(
        'INSERT OR IGNORE INTO live_stats_leases (lease_key, acquired_at, expires_at) VALUES (?, ?, ?)'
      ).bind(leaseKey, acquiredAt, expiresAt).run();
      return Number(result?.meta?.changes || 0) > 0;
    },

    async getApiBudget(dayUtc) {
      const row = await db.prepare(
        'SELECT reserved_calls, known_remaining, known_limit, updated_at FROM api_football_budget WHERE day_utc=?'
      ).bind(text(dayUtc)).first();
      if (!row) return null;
      return {
        reservedCalls: Number(row.reserved_calls || 0),
        remaining: finiteInt(row.known_remaining),
        limit: finiteInt(row.known_limit),
        updatedAt: Number(row.updated_at || 0)
      };
    },

    async reserveApiCalls(dayUtc, calls, maxReservedCalls, now = Date.now()) {
      const day = text(dayUtc);
      const amount = Math.max(1, finiteInt(calls) || 1);
      const ceiling = Math.max(1, finiteInt(maxReservedCalls) || 1);
      const updatedAt = Number(now);
      await db.prepare(`
        INSERT OR IGNORE INTO api_football_budget
          (day_utc, reserved_calls, known_remaining, known_limit, updated_at)
        VALUES (?, 0, NULL, NULL, ?)
      `).bind(day, updatedAt).run();
      const result = await db.prepare(`
        UPDATE api_football_budget
        SET reserved_calls=reserved_calls+?, updated_at=?
        WHERE day_utc=? AND reserved_calls+?<=?
      `).bind(amount, updatedAt, day, amount, ceiling).run();
      const allowed = Number(result?.meta?.changes || 0) > 0;
      return { allowed, ...(await this.getApiBudget(day) || { reservedCalls: 0, remaining: null, limit: null }) };
    },

    async updateApiBudget(dayUtc, rateLimit, now = Date.now()) {
      const day = text(dayUtc);
      const remaining = finiteInt(rateLimit?.dailyRemaining);
      const limit = finiteInt(rateLimit?.dailyLimit);
      const updatedAt = Number(now);
      await db.prepare(`
        INSERT INTO api_football_budget
          (day_utc, reserved_calls, known_remaining, known_limit, updated_at)
        VALUES (?, 0, ?, ?, ?)
        ON CONFLICT(day_utc) DO UPDATE SET
          known_remaining=COALESCE(excluded.known_remaining, api_football_budget.known_remaining),
          known_limit=COALESCE(excluded.known_limit, api_football_budget.known_limit),
          updated_at=excluded.updated_at
      `).bind(day, remaining, limit, updatedAt).run();
      return await this.getApiBudget(day);
    }
  };
}
