import WebSocket from "ws";

const SPORTS_WS =
  process.env.POLYMARKET_SPORTS_WS ||
  "wss://sports-api.polymarket.com/ws";

const MAX_EVENTS = Math.max(50, Math.min(5000, Number(process.env.SPORTS_MAX_EVENTS || 500)));

export interface SportsFeedEvent {
  receivedAt: string;
  payload: Record<string, unknown>;
}

const STOPWORDS = new Set([
  "will","the","a","an","be","to","of","in","on","at","by","for","and","or",
  "win","wins","winner","game","match","today","tonight","tomorrow","vs","versus",
  "over","under","above","below","more","less","than","score","points","goals"
]);

function tokens(text: string) {
  return [...new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter(token => token.length >= 3 && !STOPWORDS.has(token))
  )];
}

class SportsTracker {
  private ws: WebSocket | null = null;
  private reconnect: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private events: SportsFeedEvent[] = [];
  private messageCount = 0;
  private sportResultCount = 0;
  private lastConnectedAt: string | null = null;
  private lastMessageAt: string | null = null;
  private lastError: string | null = null;
  private intentionalClose = false;

  start() {
    if (this.ws && (
      this.ws.readyState === WebSocket.OPEN ||
      this.ws.readyState === WebSocket.CONNECTING
    )) return;

    this.intentionalClose = false;
    const ws = new WebSocket(SPORTS_WS);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.lastConnectedAt = new Date().toISOString();
      this.lastError = null;
    });

    ws.on("message", data => {
      const raw = data.toString();
      this.lastMessageAt = new Date().toISOString();
      this.messageCount += 1;

      if (raw.trim().toLowerCase() === "ping") {
        if (ws.readyState === WebSocket.OPEN) ws.send("pong");
        return;
      }

      try {
        const parsed = JSON.parse(raw);
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        for (const message of messages) {
          if (!message || typeof message !== "object") continue;

          const type = String(
            (message as any).type ??
            (message as any).event_type ??
            ""
          );

          if (type === "ping") {
            if (ws.readyState === WebSocket.OPEN) ws.send("pong");
            continue;
          }

          if (type !== "sport_result") continue;

          this.sportResultCount += 1;
          this.events.push({
            receivedAt: new Date().toISOString(),
            payload: message as Record<string, unknown>
          });

          if (this.events.length > MAX_EVENTS) {
            this.events.splice(0, this.events.length - MAX_EVENTS);
          }
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    });

    ws.on("error", error => {
      this.lastError = error.message;
    });

    ws.on("close", () => {
      this.ws = null;
      if (!this.intentionalClose) this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    if (this.reconnect) return;
    const delay = Math.min(
      30_000,
      1000 * Math.pow(2, Math.min(5, this.reconnectAttempts++))
    );

    this.reconnect = setTimeout(() => {
      this.reconnect = null;
      this.start();
    }, delay);
    this.reconnect.unref();
  }

  getHealth() {
    const state =
      this.ws?.readyState === WebSocket.OPEN ? "streaming" :
      this.ws?.readyState === WebSocket.CONNECTING ? "connecting" :
      "disconnected";

    return {
      state,
      endpoint: SPORTS_WS,
      cachedEvents: this.events.length,
      messageCount: this.messageCount,
      sportResultCount: this.sportResultCount,
      lastConnectedAt: this.lastConnectedAt,
      lastMessageAt: this.lastMessageAt,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError
    };
  }

  recent(limit = 50) {
    return this.events.slice(-Math.max(1, Math.min(MAX_EVENTS, limit))).reverse();
  }

  matchQuestion(question: string, limit = 10) {
    const queryTokens = tokens(question);
    if (!queryTokens.length) return [];

    const required = queryTokens.length >= 2 ? 2 : 1;

    return this.events
      .map(event => {
        const haystack = JSON.stringify(event.payload).toLowerCase();
        const matchedTokens = queryTokens.filter(token => haystack.includes(token));
        const overlap = matchedTokens.length;
        return {
          receivedAt: event.receivedAt,
          matchedTokens,
          matchScore: queryTokens.length > 0
            ? Number((overlap / queryTokens.length).toFixed(3))
            : 0,
          payload: event.payload
        };
      })
      .filter(item => item.matchedTokens.length >= required)
      .sort((a, b) =>
        b.matchScore - a.matchScore ||
        Date.parse(b.receivedAt) - Date.parse(a.receivedAt)
      )
      .slice(0, Math.max(1, Math.min(50, limit)));
  }

  close() {
    this.intentionalClose = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = null;
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }
    this.ws = null;
  }
}

export const sportsTracker = new SportsTracker();
