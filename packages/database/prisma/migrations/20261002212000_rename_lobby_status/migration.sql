-- READY_CHECK becomes LOBBY: there is no ready check any more, the server is reserved and the match controller steers.
ALTER TYPE "MatchStatus" RENAME VALUE 'READY_CHECK' TO 'LOBBY';
