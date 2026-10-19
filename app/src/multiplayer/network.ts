/**
 * start.ng multiplayer networking layer.
 *
 * Uses the connect page ticket → WebSocket flow documented at
 * https://start.ng/docs.md#multiplayer-rooms
 */

const START_NG = "https://start.ng";

export interface MultiplayerPlayer {
  id: number;
  name: string;
  style: any;
  seat: number;
  ready: boolean;
}

export interface LobbyState {
  code: string;
  hostId: number;
  players: MultiplayerPlayer[];
  maxPlayers: number;
  gameStarted: boolean;
  seed?: number;
  clockMs?: number;
}

export interface RoundStartData {
  seed: number;
  rack: string[];
  clockMs: number;
  round: number;
  turnOwner: number;
}

export interface WordSubmission {
  playerId: number;
  word: string;
  placements: number[];
}

export interface RoundResultData {
  words: Map<number, { word: string; score: number; bingo: boolean }>;
  winner: number;
  damage: Map<number, number>;
  bestWord: { word: string; score: number } | null;
}

export type MessageType =
  | "lobby_create"
  | "lobby_join"
  | "lobby_state"
  | "player_join"
  | "player_leave"
  | "player_ready"
  | "game_start"
  | "round_start"
  | "word_submit"
  | "round_result"
  | "game_over"
  | "error"
  | "chat";

export interface NetworkMessage {
  type: MessageType;
  payload: any;
  playerId?: number;
  timestamp: number;
}

type MessageHandler = (msg: NetworkMessage) => void;

export class MultiplayerNetwork {
  private ws: WebSocket | null = null;
  private ticket: string | null = null;
  private handlers: Map<string, MessageHandler[]> = new Map();
  private playerId: number | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private lobbyState: LobbyState | null = null;

  async getTicket(): Promise<string | null> {
    try {
      const response = await fetch(`${START_NG}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "startng:ticket" }),
      });
      const data = await response.json();
      if (data.ok && data.ticket) {
        this.ticket = data.ticket;
        return data.ticket;
      }
    } catch (e) {
      console.error("Failed to get multiplayer ticket:", e);
    }
    return null;
  }

  async connect(ticket: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${START_NG}/multiplayer?ticket=${encodeURIComponent(ticket)}`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        console.log("[Multiplayer] WebSocket connected");
        this.reconnectAttempts = 0;
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg: NetworkMessage = JSON.parse(event.data);
          this.handleMessage(msg);
        } catch (e) {
          console.error("[Multiplayer] Failed to parse message:", e);
        }
      };

      this.ws.onclose = (event) => {
        console.log("[Multiplayer] WebSocket closed:", event.code, event.reason);
        this.handleDisconnect(event.code);
      };

      this.ws.onerror = (err) => {
        console.error("[Multiplayer] WebSocket error:", err);
        reject(err);
      };
    });
  }

  private handleMessage(msg: NetworkMessage): void {
    const handlers = this.handlers.get(msg.type) || [];
    for (const h of handlers) h(msg);

    // Also call wildcard handlers
    const wild = this.handlers.get("*") || [];
    for (const h of wild) h(msg);
  }

  private handleDisconnect(code: number): void {
    if (code === 4401) {
      console.log("[Multiplayer] Need to sign in");
      this.emit("error", { code: "NEED_SIGNIN", message: "Please sign in to play multiplayer" });
    } else if (code === 4403) {
      console.log("[Multiplayer] Room full");
      this.emit("error", { code: "ROOM_FULL", message: "This game is full" });
    } else if (code === 4409) {
      console.log("[Multiplayer] Joined from another tab");
    }

    // Attempt reconnect for non-auth errors
    if (code !== 4401 && code !== 4403 && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      setTimeout(() => this.reconnect(), 1000 * this.reconnectAttempts);
    }
  }

  private async reconnect(): Promise<void> {
    if (this.ticket) {
      try {
        await this.connect(this.ticket);
        // Re-send lobby state request
        this.send({ type: "lobby_state", payload: { code: this.lobbyState?.code } });
      } catch (e) {
        console.error("[Multiplayer] Reconnect failed:", e);
      }
    }
  }

  on(type: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type)!.push(handler);
    return () => {
      const arr = this.handlers.get(type);
      if (arr) arr.splice(arr.indexOf(handler), 1);
    };
  }

  onAny(handler: MessageHandler): () => void {
    if (!this.handlers.has("*")) this.handlers.set("*", []);
    this.handlers.get("*")!.push(handler);
    return () => {
      const arr = this.handlers.get("*");
      if (arr) arr.splice(arr.indexOf(handler), 1);
    };
  }

  private emit(type: MessageType, payload: any): void {
    const msg: NetworkMessage = { type, payload, timestamp: Date.now() };
    this.handleMessage(msg);
  }

  send(msg: Omit<NetworkMessage, "timestamp" | "playerId">): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ ...msg, timestamp: Date.now() }));
    } else {
      console.warn("[Multiplayer] Cannot send, WebSocket not open:", msg.type);
    }
  }

  // Lobby actions
  createLobby(maxPlayers = 4, clockMs = 20000): void {
    this.send({ type: "lobby_create", payload: { maxPlayers, clockMs } });
  }

  joinLobby(code: string): void {
    this.send({ type: "lobby_join", payload: { code: code.toUpperCase() } });
  }

  setReady(ready: boolean): void {
    this.send({ type: "player_ready", payload: { ready } });
  }

  startGame(): void {
    this.send({ type: "game_start", payload: {} });
  }

  // Game actions
  submitWord(word: string, placements: number[]): void {
    this.send({ type: "word_submit", payload: { word, placements } });
  }

  // Getters
  getPlayerId(): number | null { return this.playerId; }
  getLobbyState(): LobbyState | null { return this.lobbyState; }
  isConnected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  disconnect(): void {
    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }
  }
}

// Singleton instance
export const network = new MultiplayerNetwork();