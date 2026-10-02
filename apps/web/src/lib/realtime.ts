'use client';
import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_URL } from './api';

let socket: Socket | null = null;
const listeners = new Set<(e: Record<string, unknown>) => void>();

function connection(): Socket {
  if (!socket) {
    socket = io(API_URL, { path: '/realtime', withCredentials: true, transports: ['websocket', 'polling'] });
    socket.on('event', (e: Record<string, unknown>) => listeners.forEach((l) => l(e)));
  }
  return socket;
}

/**
 * Subscribes to a room and calls `onChange` whenever something in it changed. The server only sends "something
 * changed" notices; the caller re-fetches over REST, so visibility rules stay on the server.
 */
export function useRealtime(room: 'match' | 'tournament' | 'live' | 'servers', id: string | undefined, onChange: () => void) {
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if ((room === 'match' || room === 'tournament') && !id) return;
    const s = connection();
    const sub = () => s.emit('subscribe', { room, ...(id ? { id } : {}) });
    sub();
    s.on('connect', sub); // re-join after reconnects
    const l = (e: Record<string, unknown>) => {
      if (!id || e.matchId === id || e.tournamentId === id) cb.current();
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
      s.off('connect', sub);
      s.emit('unsubscribe', { room, ...(id ? { id } : {}) });
    };
  }, [room, id]);
}
