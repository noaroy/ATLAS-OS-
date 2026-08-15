import { create } from 'zustand';
import type {
  Alert,
  DashboardStats,
  ServerMessage,
  SystemEvent,
  SystemHealth,
  User,
  VillageSnapshot,
} from '@atlas/contracts';
import { api, auth } from './lib/api.ts';

export type Channel = 'event' | 'village' | 'stats' | 'health';
export type ConnectionState = 'connecting' | 'live' | 'offline';

const MAX_FEED = 250;

interface AtlasState {
  // Session
  user: User | null;
  booting: boolean;

  // Live data
  connection: ConnectionState;
  mode: 'live' | 'simulation';
  version: string;
  village: VillageSnapshot | null;
  stats: DashboardStats | null;
  health: SystemHealth | null;
  alerts: Alert[];
  feed: SystemEvent[];

  // Actions
  boot(): Promise<void>;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  connect(channels: Channel[]): void;
  disconnect(): void;
  refreshAlerts(): Promise<void>;
  refreshHealth(): Promise<void>;
  dismissAlert(id: string): Promise<void>;
}

let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let reconnectDelay = 1000;
let desiredChannels: Channel[] = ['event'];

export const useAtlas = create<AtlasState>((set, get) => ({
  user: null,
  booting: true,
  connection: 'offline',
  mode: 'simulation',
  version: '1.0.0',
  village: null,
  stats: null,
  health: null,
  alerts: [],
  feed: [],

  /**
   * Restores an existing session on page load.
   *
   * The cookie is not readable here, so the only way to know whether a session
   * is live is to ask the server. The local flag just avoids a pointless
   * round-trip for a visitor who has never signed in.
   */
  async boot() {
    if (!auth.signedIn) {
      set({ booting: false, user: null });
      return;
    }
    try {
      const [user, settings] = await Promise.all([api.me(), api.settings()]);
      set({ user, mode: settings.mode, version: settings.version, booting: false });
      void get().refreshAlerts();
      void get().refreshHealth();
    } catch {
      auth.signedIn = false;
      set({ booting: false, user: null });
    }
  },

  async login(email, password) {
    const session = await api.login(email, password);
    // The server has set the httpOnly cookie; this only records that a
    // session should exist.
    auth.signedIn = true;
    const settings = await api.settings();
    set({ user: session.user, mode: settings.mode, version: settings.version });
    void get().refreshAlerts();
    void get().refreshHealth();
  },

  async logout() {
    try {
      await api.logout();
    } finally {
      auth.signedIn = false;
      get().disconnect();
      set({ user: null, village: null, stats: null, feed: [], alerts: [], health: null });
    }
  },

  /**
   * Opens (or re-targets) the realtime socket.
   *
   * A single connection is shared by every view; switching views only changes
   * the subscription, so navigating never drops the event feed.
   */
  connect(channels) {
    desiredChannels = channels;

    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ action: 'subscribe', channels }));
      return;
    }
    if (socket && socket.readyState === WebSocket.CONNECTING) return;

    if (!auth.signedIn) return;

    set({ connection: 'connecting' });

    // No token in the URL: the browser attaches the session cookie to the
    // WebSocket handshake, so the token never appears in a log or a referrer.
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocol}://${location.host}/api/realtime`);

    socket.onopen = () => {
      reconnectDelay = 1000;
      set({ connection: 'live' });
      socket?.send(JSON.stringify({ action: 'subscribe', channels: desiredChannels }));
    };

    socket.onmessage = (raw) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(raw.data as string) as ServerMessage;
      } catch {
        return;
      }

      switch (message.channel) {
        case 'hello':
          set({ mode: message.data.mode, version: message.data.version });
          break;
        case 'village':
          set({ village: message.data });
          break;
        case 'stats':
          set({ stats: message.data });
          break;
        case 'health':
          set({ health: message.data });
          break;
        case 'event': {
          const event = message.data;
          set((state) => ({ feed: [event, ...state.feed].slice(0, MAX_FEED) }));
          // An error-level event usually means a new alert exists; pull it so
          // the badge updates without waiting for the next poll.
          if (event.severity === 'error' || event.severity === 'critical') {
            void get().refreshAlerts();
          }
          break;
        }
      }
    };

    socket.onclose = () => {
      socket = null;
      set({ connection: 'offline' });

      // Exponential backoff, capped — a server restart should reconnect fast,
      // a sustained outage should not hammer the network.
      if (auth.signedIn && reconnectTimer === null) {
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          get().connect(desiredChannels);
        }, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 1.8, 20_000);
      }
    };

    socket.onerror = () => socket?.close();
  },

  disconnect() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    socket?.close();
    socket = null;
    set({ connection: 'offline' });
  },

  async refreshAlerts() {
    try {
      set({ alerts: await api.alerts(false) });
    } catch {
      /* transient — the next refresh will pick it up */
    }
  },

  async refreshHealth() {
    try {
      set({ health: await api.health() });
    } catch {
      /* transient */
    }
  },

  async dismissAlert(id) {
    await api.acknowledgeAlert(id);
    set((state) => ({ alerts: state.alerts.filter((a) => a.id !== id) }));
  },
}));

// A 401 anywhere in the app ends the session everywhere.
window.addEventListener('atlas:unauthorized', () => {
  useAtlas.setState({ user: null });
  useAtlas.getState().disconnect();
});
