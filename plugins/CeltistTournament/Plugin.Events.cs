using Celtist.Tournament.Match;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Memory.DynamicFunctions;
using CounterStrikeSharp.API.Modules.Memory;
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
        RegisterEventHandler<EventPlayerTeam>(OnPlayerTeam);
        RegisterEventHandler<EventItemEquip>(OnItemEquip);
        RegisterEventHandler<EventItemPickup>(OnItemPickup);
        RegisterListener<Listeners.OnEntitySpawned>(OnWeaponSpawned);
        RegisterListener<Listeners.OnMapStart>(_ => { _stamped.Clear(); _glovesApplied.Clear(); });
        RegisterListener<Listeners.OnServerPrecacheResources>(manifest => { foreach (var model in _agentModels) manifest.AddResource(model); });
        VirtualFunctions.GiveNamedItemFunc.Hook(OnGiveNamedItemPost, HookMode.Post);
    }

    // ───────────── join authorisation: only assigned players get in ─────────────

    private HookResult OnPlayerConnectFull(EventPlayerConnectFull e, GameEventInfo info)
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

    private HookResult OnPlayerDisconnect(EventPlayerDisconnect e, GameEventInfo info)
    {
        var player = e.Userid;
        if (player is { IsBot: false, IsValid: true })
        {
            Emit("player.disconnected", new() { ["steamId"] = player.SteamID.ToString() });
            _skinTokens.Remove(player.SteamID);
            _glovesApplied.Remove(player.SteamID);
            _loadouts.Remove(player.SteamID);
        }
        return HookResult.Continue;
    }

    private HookResult OnPlayerSpawn(EventPlayerSpawn e, GameEventInfo info)
    {
        // If a connected player ended up on the wrong side (manual team change), put them back.
        var player = e.Userid;
        if (player is { IsBot: false, IsValid: true } && _plan?.SlotOf(player.SteamID) is { } slot) PlaceOnSide(player, slot);
        if (Config.SkinsEnabled && player is { IsBot: false, IsValid: true })
        {
            var id = player.SteamID;
            if (!_loadouts.ContainsKey(id)) _ = ApplySkinsAsync(id);
            _glovesApplied.Remove(id); // a new life starts with fresh gloves
            ScheduleSkins(id, 0.5f); // weapons and the player model exist a moment after the spawn event
        }
        return HookResult.Continue;
    }

    /// <summary>
    /// Switching sides: the loadout of the new side must apply to what the player already holds. The team number is only
    /// final a moment after the event, so the skins are applied after short delays.
    /// </summary>
    private HookResult OnPlayerTeam(EventPlayerTeam e, GameEventInfo info)
    {
        var player = e.Userid;
        if (Config.SkinsEnabled && player is { IsBot: false, IsValid: true })
        {
            var id = player.SteamID;
            ScheduleSkins(id, 0.8f);
        }
        return HookResult.Continue;
    }

    private HookResult OnItemEquip(EventItemEquip e, GameEventInfo info)
    {
        var player = e.Userid;
        if (Config.SkinsEnabled && player is { IsBot: false, IsValid: true })
        {
            var id = player.SteamID;
            AddTimer(0.05f, () => UpdateViewModelMask(id));
        }
        return HookResult.Continue;
    }

    /// <summary>Picked-up and bought weapons get the loadout skin too.</summary>
    private HookResult OnItemPickup(EventItemPickup e, GameEventInfo info)
    {
        var player = e.Userid;
        if (Config.SkinsEnabled && player is { IsBot: false, IsValid: true })
        {
            var id = player.SteamID;
            AddTimer(0.15f, () => ApplyToHeldWeapons(id));
        }
        return HookResult.Continue;
    }

    /// <summary>
    /// Rounds played according to the game itself. The plugin's own counter starts at 0 after a plugin restart, which used to
    /// put players back on their starting side after the half-time swap.
    /// </summary>
    private int RoundsNow()
    {
        try
        {
            var rules = Utilities.FindAllEntitiesByDesignerName<CCSGameRulesProxy>("cs_gamerules").FirstOrDefault()?.GameRules;
            if (rules is not null) return rules.TotalRoundsPlayed;
        }
        catch (Exception e) { Logger.LogWarning("[Celtist] game rules unavailable: {Message}", e.Message); }
        return _map?.RoundsPlayed ?? 0;
    }

    private void PlaceOnSide(CCSPlayerController player, string slot)
    {
        if (_plan is null || _freeSide.Contains(player.SteamID)) return;
        var start = _map is null ? _plan.Maps.FirstOrDefault()?.TeamAStartSide ?? "CT" : _plan.Maps.FirstOrDefault(m => m.MapNumber == _map.MapNumber)?.TeamAStartSide ?? "CT";
        var maxRounds = _plan.RoundsToWin * 2 - 2;
        var side = Sides.SideOf(slot, start, RoundsNow(), maxRounds);
        var team = side == "CT" ? CsTeam.CounterTerrorist : CsTeam.Terrorist;
        if (player.Team != team) player.ChangeTeam(team);
    }

    // ───────────── scoring and results ─────────────

    private HookResult OnRoundEnd(EventRoundEnd e, GameEventInfo info)
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
        return Sides.SideOf("A", start, RoundsNow(), maxRounds) == side ? "A" : "B";
    }

    private HookResult OnMatchEnd(EventCsWinPanelMatch e, GameEventInfo info)
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
            var c = StatsOf(p.SteamID); // own counters: bots never count
            players.Add(new
            {
                steamId = p.SteamID.ToString(), team = slot, rounds = map.RoundsPlayed,
                kills = c.Kills, deaths = c.Deaths, assists = c.Assists,
                headshots = c.Headshots, damage = c.Damage, mvps = Math.Min(p.MVPs, map.RoundsPlayed),
                flashAssists = 0, utilityDamage = 0, clutches = 0,
                entryKills = 0, entryDeaths = 0,
                killsAwp = c.KillsAwp, killsAk47 = c.KillsAk47, killsPistol = c.KillsPistol,
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
                    if (status == "MATCH_FINISHED") Server.NextFrame(() => { Server.PrintToChatAll(" \x04[Celtist]\x01 Match finished. Thanks for playing!"); AddTimer(15f, ResetMatch); });
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

    private HookResult OnPlayerHurt(EventPlayerHurt e, GameEventInfo info)
    {
        CountDamage(e);
        var attacker = e.Attacker; var victim = e.Userid;
        if (_plan is null || !_penaltiesEnabled || attacker is null || victim is null || attacker.Slot == victim.Slot || attacker.Team != victim.Team || attacker.IsBot) return HookResult.Continue;
        var total = _teamDamage.GetValueOrDefault(attacker.SteamID) + e.DmgHealth;
        _teamDamage[attacker.SteamID] = total;
        if (total >= _plan.TeamDamageLimit) Penalise(attacker, $"team damage {total} >= {_plan.TeamDamageLimit}");
        return HookResult.Continue;
    }

    private HookResult OnPlayerDeath(EventPlayerDeath e, GameEventInfo info)
    {
        CountDeath(e);
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
