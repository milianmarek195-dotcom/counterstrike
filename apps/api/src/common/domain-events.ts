/**
 * Domain events decouple the modules: services announce what happened (after their transaction committed),
 * and realtime, notifications, Discord webhooks and caches react. This avoids module cycles
 * (matches ↔ tournaments ↔ realtime) without forwardRef.
 */
export const DomainEvent = {
  MatchUpdated: 'match.updated',
  MatchVeto: 'match.veto',
  MatchReady: 'match.ready',
  MatchScore: 'match.score',
  MatchFinished: 'match.finished',
  MatchCancelled: 'match.cancelled',
  MatchStarted: 'match.started',
  MatchServerError: 'match.server_error',
  /** Both teams are known: the lifecycle should start looking for a server. */
  MatchReadyToSchedule: 'match.ready_to_schedule',
  /** The lifecycle decided one team forfeits (no-show); the finalizer records the result. */
  MatchForfeitRequested: 'match.forfeit_requested',
  TournamentUpdated: 'tournament.updated',
  TournamentBracket: 'tournament.bracket',
  TournamentCreated: 'tournament.created',
  TournamentFinished: 'tournament.finished',
  ServerStatus: 'server.status',
  ServerOffline: 'server.offline',
  /** A server that should host a running match reports it no longer knows it (crash/restart). */
  ServerMatchLost: 'server.match_lost',
  PartyUpdated: 'party.updated',
  Notification: 'notification.created',
  RankingChanged: 'ranking.changed',
} as const;

export type DomainEventName = (typeof DomainEvent)[keyof typeof DomainEvent];

export interface MatchEventPayload {
  matchId: string;
  tournamentId?: string | null;
}

export interface TournamentEventPayload {
  tournamentId: string;
}

export interface ServerStatusPayload {
  serverId: string;
  status: string;
  previousStatus?: string;
}

export interface PartyEventPayload {
  partyId: string;
  userIds: string[];
}

export interface NotificationEventPayload {
  userId: string;
  notificationId: string;
}
