const allowedPositionStates = new Set(["OPEN", "CLOSED"]);

export class DurableObjectLiveStore {
  constructor({ stub, now = () => Date.now() } = {}) {
    if (!stub || typeof stub.fetch !== "function") throw new Error("LIVE_DURABLE_OBJECT_STUB_REQUIRED");
    this.stub = stub;
    this.now = now;
  }

  async request(path, body) {
    const response = await this.stub.fetch(new Request("https://engine.internal" + path, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined
    }));
    const payload = await response.json();
    if (!response.ok || payload.ok !== true) throw new Error(payload.error ?? "LIVE_STATE_STORAGE_FAILED");
    return payload;
  }

  async claimIdempotencyKey(key, { ttlMs = 86400000 } = {}) {
    if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{12,40}$/.test(key)) return false;
    const result = await this.request("/live/idempotency/claim", {
      key, ttlMs: Math.min(86400000, Math.max(60000, Number(ttlMs) || 86400000)), now: this.now()
    });
    return result.claimed === true;
  }

  async releaseIdempotencyKey(key) {
    await this.request("/live/idempotency/release", { key });
  }

  async saveLivePosition(position) {
    if (!position || position.mode !== "BINGX_LIVE" || !allowedPositionStates.has(position.state))
      throw new Error("LIVE_POSITION_RECORD_INVALID");
    await this.request("/live/positions", { operation: "upsert", position });
  }

  async markLivePositionClosed(id, metadata = {}) {
    if (typeof id !== "string" || !id) throw new Error("LIVE_POSITION_ID_REQUIRED");
    await this.request("/live/positions", { operation: "close", id, metadata });
  }

  async getActivation() {
    const result = await this.request("/live/activation");
    return result.activation ?? { active: false, id: null };
  }

  async setActivation(activation) {
    await this.request("/live/activation", activation);
  }

  async invalidateActivation() {
    await this.request("/live/activation", {
      active: false, id: "invalidated-" + this.now(), systemInvalidation: true,
      confirmedByUser: false, confirmedAt: this.now()
    });
  }

  async listLivePositions() {
    const result = await this.request("/live/positions");
    return Array.isArray(result.positions) ? result.positions : [];
  }
}
