import WebSocket from "ws";

const MARKET_WS = process.env.POLYMARKET_MARKET_WS || "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export interface RealtimeQuote {
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  lastTradePrice: number | null;
  lastTradeSide: string | null;
  updatedAt: string;
  eventType: string;
}

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

class MarketRealtimeTracker {
  private ws: WebSocket | null = null;
  private tokens = new Set<string>();
  private quotes = new Map<string, RealtimeQuote>();
  private heartbeat: NodeJS.Timeout | null = null;
  private reconnect: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private messageCount = 0;
  private lastMessageAt: string | null = null;
  private lastConnectedAt: string | null = null;
  private lastError: string | null = null;
  private intentionalClose = false;

  updateTokens(nextTokens: string[]) {
    const next = new Set(nextTokens.filter(Boolean));
    const added = [...next].filter(token => !this.tokens.has(token));
    const removed = [...this.tokens].filter(token => !next.has(token));
    this.tokens = next;

    for (const token of removed) this.quotes.delete(token);

    if (this.tokens.size === 0) {
      this.intentionalClose = true;
      this.cleanupSocket();
      return;
    }

    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.connect();
      return;
    }

    if (this.ws.readyState === WebSocket.OPEN) {
      if (added.length) this.sendSubscription(added, "subscribe");
      if (removed.length) this.sendSubscription(removed, "unsubscribe");
    }
  }

  private sendSubscription(tokens: string[], operation?: "subscribe" | "unsubscribe") {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || tokens.length === 0) return;
    const message: Record<string, unknown> = {
      assets_ids: tokens,
      custom_feature_enabled: true
    };
    if (operation) message.operation = operation;
    else message.type = "market";
    this.ws.send(JSON.stringify(message));
  }

  private connect() {
    if (this.tokens.size === 0) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    this.intentionalClose = false;
    const ws = new WebSocket(MARKET_WS);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.lastConnectedAt = new Date().toISOString();
      this.lastError = null;
      this.sendSubscription([...this.tokens]);

      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send("PING");
      }, 10_000);
      this.heartbeat.unref();
    });

    ws.on("message", data => {
      const raw = data.toString();
      if (raw === "PONG") return;
      this.lastMessageAt = new Date().toISOString();
      this.messageCount += 1;

      try {
        const parsed = JSON.parse(raw);
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        for (const message of messages) this.handleMessage(message);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    });

    ws.on("error", error => {
      this.lastError = error.message;
    });

    ws.on("close", () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      this.ws = null;
      if (!this.intentionalClose && this.tokens.size > 0) this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    if (this.reconnect) return;
    const delay = Math.min(30_000, 1000 * Math.pow(2, Math.min(5, this.reconnectAttempts++)));
    this.reconnect = setTimeout(() => {
      this.reconnect = null;
      this.connect();
    }, delay);
    this.reconnect.unref();
  }

  private handleMessage(message: any) {
    const type = String(message?.event_type || message?.type || "unknown");

    if (type === "book" && message.asset_id) {
      const bids = Array.isArray(message.bids)
        ? message.bids.map((x: any) => num(x?.price)).filter((x: number | null): x is number => x !== null)
        : [];
      const asks = Array.isArray(message.asks)
        ? message.asks.map((x: any) => num(x?.price)).filter((x: number | null): x is number => x !== null)
        : [];
      const bestBid = bids.length ? Math.max(...bids) : null;
      const bestAsk = asks.length ? Math.min(...asks) : null;
      this.mergeQuote(String(message.asset_id), {
        bestBid,
        bestAsk,
        eventType: type
      });
      return;
    }

    if (type === "best_bid_ask" && message.asset_id) {
      this.mergeQuote(String(message.asset_id), {
        bestBid: num(message.best_bid),
        bestAsk: num(message.best_ask),
        eventType: type
      });
      return;
    }

    if (type === "price_change" && Array.isArray(message.price_changes)) {
      for (const change of message.price_changes) {
        if (!change?.asset_id) continue;
        this.mergeQuote(String(change.asset_id), {
          bestBid: num(change.best_bid),
          bestAsk: num(change.best_ask),
          eventType: type
        });
      }
      return;
    }

    if (type === "last_trade_price" && message.asset_id) {
      this.mergeQuote(String(message.asset_id), {
        lastTradePrice: num(message.price),
        lastTradeSide: message.side ? String(message.side) : null,
        eventType: type
      });
    }
  }

  private mergeQuote(
    tokenId: string,
    patch: Partial<Omit<RealtimeQuote, "tokenId" | "updatedAt">> & { eventType: string }
  ) {
    const old = this.quotes.get(tokenId);
    const bestBid = patch.bestBid !== undefined ? patch.bestBid : old?.bestBid ?? null;
    const bestAsk = patch.bestAsk !== undefined ? patch.bestAsk : old?.bestAsk ?? null;
    this.quotes.set(tokenId, {
      tokenId,
      bestBid,
      bestAsk,
      spread: bestBid !== null && bestAsk !== null ? Math.max(0, bestAsk - bestBid) : null,
      lastTradePrice: patch.lastTradePrice !== undefined ? patch.lastTradePrice : old?.lastTradePrice ?? null,
      lastTradeSide: patch.lastTradeSide !== undefined ? patch.lastTradeSide : old?.lastTradeSide ?? null,
      updatedAt: new Date().toISOString(),
      eventType: patch.eventType
    });
  }

  getQuote(tokenId: string) {
    return this.quotes.get(tokenId) ?? null;
  }

  getHealth() {
    const state =
      this.tokens.size === 0 ? "idle" :
      this.ws?.readyState === WebSocket.OPEN ? "streaming" :
      this.ws?.readyState === WebSocket.CONNECTING ? "connecting" :
      "disconnected";

    return {
      state,
      endpoint: MARKET_WS,
      subscribedTokens: this.tokens.size,
      cachedQuotes: this.quotes.size,
      messageCount: this.messageCount,
      lastMessageAt: this.lastMessageAt,
      lastConnectedAt: this.lastConnectedAt,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError
    };
  }

  private cleanupSocket() {
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }
    this.ws = null;
  }

  close() {
    this.intentionalClose = true;
    this.tokens.clear();
    this.cleanupSocket();
  }
}

export const realtimeTracker = new MarketRealtimeTracker();
