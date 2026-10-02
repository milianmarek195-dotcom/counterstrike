using Celtist.Tournament.Match;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Utils;

namespace Celtist.Tournament;

public sealed partial class CeltistTournamentPlugin
{
    private readonly Dictionary<ulong, int> _teamDamage = new();
    private readonly Dictionary<ulong, int> _teamKills = new();
    private readonly HashSet<ulong> _penalised = new();

    private void RegisterGameEvents()
    {
        RegisterEventHandler<EventPlayerConnectFull>(OnPlayerConnectFull);
        RegisterEventHandler<EventPlayerDisconnect>(OnPlayerDisconnect);
        RegisterEventHandler<EventRoundEnd>(OnRoundEnd);
        RegisterEventHandler<EventCsWinPanelMatch>(OnMatchEnd);
        RegisterEventHandler<EventPlayerHurt>(OnPlayerHurt);
        RegisterEventHandler<EventPlayerDeath>(OnPlayerDeath);
        RegisterEventHandler<EventPlayerSpawn>(OnPlayerSpawn);
    }

    // ───────────── join authorisation: only assigned players get in ─────────────

    private HookResult OnPlayerConnectFull(EventPlayerConnectFull e, GameEventInfo _)
    {
        var player = e.Userid;
        if (player is null || !player.IsValid || player.IsBot || _api is null) return HookResult.Continue;
        var steamId = player.SteamID;
        var userId = player.UserId;
        _ = Task.Run(async () =>
        {
            string? denied = null;
            string? slot = null;
            try
            {
                var response = await _api.PostAsync("/server/v1/players/authorize", new { steamId = steamId.ToString() }).ConfigureAwait(false);
                if (!response.Ok) denied = $"backend answered {response.Status}";
                else
                {
                    var json = response.Json();
                    if (json.GetProperty("allowed").GetBoolean()) slot = json.GetProperty("team").GetString();
                    else denied = json.TryGetProperty("reason", out var r) ? r.GetString() : "DENIED";
                }
            }
            catch (Exception ex) { denied = $"backend unreachable ({ex.Message})"; } // fail closed
            Server.NextFrame(() =>
            {
                if (denied is not null)
                {
                    Logger.LogInformation("[Celtist] rejected {Steam}: {Reason}", steamId, denied);
                    Emit("player.rejected", new() { ["steamId"] = steamId.ToString(), ["reason"] = Trim(denied, 120) });
                    Server.PrintToChatAll($" \x07[Celtist]\x01 {Config.DenyMessage}");
                    Server.ExecuteCommand($"kickid {userId} \"{Config.DenyMessage}\"");
                    return;
                }
                Emit("player.connected", new() { ["steamId"] = steamId.ToString() });
                var live = Utilities.GetPlayerFromSteamId(steamId);
                if (live is { IsValid: true } && slot is not null) PlaceOnSide(live, slot);
                _ = ApplySkinsAsync(steamId);
            });
        });
        return HookResult.Continue;
    }

    private HookResult OnPlayerDisconnect(EventPlayerDisconnect e, GameEventInfo _)
    {
        var player = e.Userid;
        if (player is { IsBot: false, IsValid: true }) Emit("player.disconnected", new() { ["steamId"] = player.SteamID.ToString() });
        return HookResult.Continue;
    }

    private HookResult OnPlayerSpawn(EventPlayerSpawn e, GameEventInfo _)
    {
        // If a connected player ended up on the wrong side (manual team change), put them back.
        var player = e.Userid;
        if (player is { IsBot: false, IsValid: true } && _plan?.SlotOf(player.SteamID) is { } slot) PlaceOnSide(player, slot);
        return HookResult.Continue;
    }

    private void PlaceOnSide(CCSPlayerController player, string slot)
    {
        if (_plan is null) return;
        var start = _map is null ? _plan.Maps.FirstOrDefault()?.TeamAStartSide ?? "CT" : _plan.Maps.FirstOrDefault(m => m.MapNumber == _map.MapNumber)?.TeamAStartSide ?? "CT";
        var maxRounds = _plan.RoundsToWin * 2 - 2;
        var side = Sides.SideOf(slot, start, _map?.RoundsPlayed ?? 0, maxRounds);
        var team = side == "CT" ? CsTeam.CounterTerrorist : CsTeam.Terrorist;
        if (player.Team != team) player.ChangeTeam(team);
    }

    // ───────────── scoring and results ─────────────

    private HookResult OnRoundEnd(EventRoundEnd e, GameEventInfo _)
    {
        if (_plan is null || _map is null) return HookResult.Continue;
        var winnerTeam = (CsTeam)e.Winner;
        if (winnerTeam is not (CsTeam.CounterTerrorist or CsTeam.Terrorist)) return HookResult.Continue;
        var slot = SlotPlayingSide(winnerTeam);
        if (slot is null) return HookResult.Continue;
        if (slot == "A") _map.ScoreA++; else _map.ScoreB++;
        Emit("round.ended", new() { ["mapNumber"] = _map.MapNumber, ["scoreA"] = _map.ScoreA, ["scoreB"] = _map.ScoreB });
        return HookResult.Continue;
    }

    /// <summary>Which slot currently plays <paramref name="team"/>: read from a connected player, falling back to the side plan.</summary>
    private string? SlotPlayingSide(CsTeam team)
    {
        if (_plan is null) return null;
        foreach (var p in Utilities.GetPlayers().Where(p => p is { IsBot: false, IsValid: true } && p.Team == team))
            if (_plan.SlotOf(p.SteamID) is { } s) return s;
        var start = _plan.Maps.FirstOrDefault(m => m.MapNumber == _map?.MapNumber)?.TeamAStartSide ?? "CT";
        var side = team == CsTeam.CounterTerrorist ? "CT" : "T";
        var maxRounds = _plan.RoundsToWin * 2 - 2;
        return Sides.SideOf("A", start, _map?.RoundsPlayed ?? 0, maxRounds) == side ? "A" : "B";
    }

    private HookResult OnMatchEnd(EventCsWinPanelMatch e, GameEventInfo _)
    {
        if (_plan is null || _map is null || _map.ResultSent || _api is null) return HookResult.Continue;
        _map.ResultSent = true;
        var plan = _plan;
        var map = _map;
        var players = new List<object>();
        foreach (var p in Utilities.GetPlayers().Where(p => p is { IsBot: false, IsValid: true }))
        {
            var slot = plan.SlotOf(p.SteamID);
            if (slot is null) continue;
            var s = p.ActionTrackingServices?.MatchStats;
            players.Add(new
            {
                steamId = p.SteamID.ToString(), team = slot, rounds = map.RoundsPlayed,
                kills = s?.Kills ?? 0, deaths = s?.Deaths ?? 0, assists = s?.Assists ?? 0,
                headshots = s?.HeadShotKills ?? 0, damage = s?.Damage ?? 0, mvps = p.MVPs,
                flashAssists = 0, utilityDamage = s?.UtilityDamage ?? 0, clutches = 0,
                entryKills = s?.EntryCount ?? 0, entryDeaths = 0,
            });
        }
        if (players.Count == 0) { Logger.LogError("[Celtist] map ended but no match players are connected - result not sent"); map.ResultSent = false; return HookResult.Continue; }
        var payload = new
        {
            matchId = plan.MatchId, mapNumber = map.MapNumber,
            idempotencyKey = $"{plan.MatchId}-map{map.MapNumber}", // stable: every retry carries the same key
            scoreA = map.ScoreA, scoreB = map.ScoreB, rounds = map.RoundsPlayed,
            startedAt = map.StartedAt.ToString("O"), endedAt = DateTimeOffset.UtcNow.ToString("O"),
            endReason = "NORMAL", players,
        };
        if (map.ScoreA > map.ScoreB) _seriesWinsA++; else _seriesWinsB++;
        _ = Task.Run(() => SendResultWithRetryAsync(plan, map, payload));
        return HookResult.Continue;
    }

    private async Task SendResultWithRetryAsync(MatchPlan plan, MapProgress map, object payload)
    {
        // The result is the one thing that must not get lost: retry with backoff until the backend answers definitively.
        for (var attempt = 1; attempt <= 12; attempt++)
        {
            try
            {
                var response = await _api!.PostAsync($"/server/v1/matches/{plan.MatchId}/result", payload).ConfigureAwait(false);
                if (response.Ok)
                {
                    var status = response.Json().GetProperty("status").GetString();
                    Logger.LogInformation("[Celtist] map {Map} result accepted ({Status})", map.MapNumber, status);
                    if (status == "MATCH_FINISHED") Server.NextFrame(() => { Server.PrintToChatAll(" \x04[Celtist]\x01 Match finished. Thanks for playing!"); AddTimer(30f, ResetMatch); });
                    return;
                }
                if (response.Status is >= 400 and < 500 and not 429)
                {
                    Logger.LogError("[Celtist] result rejected by the backend: HTTP {Status} {Body}", response.Status, response.Body);
                    Server.NextFrame(() => { _status = "ERROR"; Emit("server.error", new() { ["message"] = Trim($"result rejected: {response.Body}", 300) }); });
                    return;
                }
            }
            catch (Exception ex) { Logger.LogWarning("[Celtist] result delivery attempt {Attempt} failed: {Message}", attempt, ex.Message); }
            await Task.Delay(TimeSpan.FromSeconds(Math.Min(60, 2 << attempt))).ConfigureAwait(false);
        }
        Server.NextFrame(() => { _status = "ERROR"; Emit("server.error", new() { ["message"] = "could not deliver the map result" }); });
    }

    // ───────────── team-damage penalties ─────────────

    private HookResult OnPlayerHurt(EventPlayerHurt e, GameEventInfo _)
    {
        var attacker = e.Attacker; var victim = e.Userid;
        if (_plan is null || !_penaltiesEnabled || attacker is null || victim is null || attacker.Slot == victim.Slot || attacker.Team != victim.Team || attacker.IsBot) return HookResult.Continue;
        var total = _teamDamage.GetValueOrDefault(attacker.SteamID) + e.DmgHealth;
        _teamDamage[attacker.SteamID] = total;
        if (total >= _plan.TeamDamageLimit) Penalise(attacker, $"team damage {total} >= {_plan.TeamDamageLimit}");
        return HookResult.Continue;
    }

    private HookResult OnPlayerDeath(EventPlayerDeath e, GameEventInfo _)
    {
        var attacker = e.Attacker; var victim = e.Userid;
        if (_plan is null || !_penaltiesEnabled || attacker is null || victim is null || attacker.Slot == victim.Slot || attacker.Team != victim.Team || attacker.IsBot) return HookResult.Continue;
        var kills = _teamKills.GetValueOrDefault(attacker.SteamID) + 1;
        _teamKills[attacker.SteamID] = kills;
        if (kills >= _plan.TeamKillLimit) Penalise(attacker, $"team kills {kills} >= {_plan.TeamKillLimit}");
        return HookResult.Continue;
    }

    /// <summary>The plugin reports; the backend applies the match ban. The player is removed from the server right away.</summary>
    private void Penalise(CCSPlayerController player, string reason)
    {
        if (!_penalised.Add(player.SteamID)) return;
        Emit("penalty.team_damage", new() { ["steamId"] = player.SteamID.ToString(), ["reason"] = Trim(reason, 200) });
        Server.PrintToChatAll($" \x07[Celtist]\x01 {player.PlayerName} was removed: {reason}. An admin can use !pardon.");
        Server.ExecuteCommand($"kickid {player.UserId} team_damage");
    }
}
