import type { FastifyInstance } from 'fastify';
import type { ClientMessage, ServerMessage } from '@atlas/contracts';
import { ATLAS_VERSION } from '@atlas/contracts';
import { nowIso, describeError } from '@atlas/core';
import { buildDashboardStats } from '@atlas/runtime';
import type { AtlasSystem } from '../bootstrap.ts';

type Channel = 'event' | 'village' | 'stats' | 'health';

const VILLAGE_INTERVAL_MS = 1000;
const STATS_INTERVAL_MS = 5000;

/**
 * The realtime channel that makes the village live (SRS §3.7).
 *
 * Events are pushed the instant they happen; village and dashboard snapshots
 * are polled on a short interval because they are derived aggregates — pushing
 * a full snapshot per event would flood the socket during a busy mission.
 *
 * A connection only pays for what it subscribes to, so the Command Center does
 * not receive village frames it will never draw.
 */
export function registerRealtime(app: FastifyInstance, system: AtlasSystem): void {
  app.get('/api/realtime', { websocket: true }, (socket, request) => {
    const log = system.logger.child({ scope: 'realtime' });
    const subscriptions = new Set<Channel>(['event']);
    let alive = true;

    const send = (message: ServerMessage): void => {
      if (!alive || socket.readyState !== socket.OPEN) return;
      try {
        socket.send(JSON.stringify(message));
      } catch (err) {
        log.warn('could not write to socket', { error: describeError(err) });
      }
    };

    send({
      channel: 'hello',
      data: { version: ATLAS_VERSION, mode: system.config.llm.mode, serverTime: nowIso() },
    });

    // Live events — the only genuinely push-driven channel.
    const unsubscribe = system.events.on('*', (event) => {
      if (!subscriptions.has('event')) return;
      // Debug events stay out of the console; they exist for tracing, not display.
      if (event.severity === 'debug' && !DISPLAYED_DEBUG_EVENTS.has(event.type)) return;
      send({ channel: 'event', data: event });
    });

    const villageTimer = setInterval(() => {
      if (!subscriptions.has('village')) return;
      try {
        send({ channel: 'village', data: system.village.snapshot() });
      } catch (err) {
        log.error('village snapshot failed', { error: describeError(err) });
      }
    }, VILLAGE_INTERVAL_MS);

    const statsTimer = setInterval(() => {
      if (subscriptions.has('stats')) {
        try {
          send({ channel: 'stats', data: buildDashboardStats(system.repos) });
        } catch (err) {
          log.error('stats snapshot failed', { error: describeError(err) });
        }
      }
    }, STATS_INTERVAL_MS);

    socket.on('message', (raw: Buffer) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }

      if (message.action === 'subscribe') {
        subscriptions.clear();
        for (const channel of message.channels) subscriptions.add(channel);
        // Answer immediately so the client renders without waiting a full tick.
        if (subscriptions.has('village')) send({ channel: 'village', data: system.village.snapshot() });
        if (subscriptions.has('stats')) send({ channel: 'stats', data: buildDashboardStats(system.repos) });
      }
    });

    const cleanup = (): void => {
      alive = false;
      unsubscribe();
      clearInterval(villageTimer);
      clearInterval(statsTimer);
    };

    socket.on('close', cleanup);
    socket.on('error', (err: Error) => {
      log.debug('socket error', { error: err.message, ip: request.ip });
      cleanup();
    });
  });
}

/**
 * Debug-severity events that are still worth showing, because they represent
 * visible activity in the village rather than internal tracing.
 */
const DISPLAYED_DEBUG_EVENTS = new Set<string>(['agent.journey', 'agent.state', 'mission.progress']);
