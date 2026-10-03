using System.Text.Json;
using Celtist.Tournament.Match;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Cvars;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;

namespace Celtist.Tournament;

public sealed partial class CeltistTournamentPlugin
{
    private readonly Dictionary<string, int> _pausesUsed = new() { ["A"] = 0, ["B"] = 0 };
    private bool _paused;
    private int _pauseToken;
    private bool _penaltiesEnabled = false; // no removals for team damage unless an admin toggles it with !nobans

    // ───────────── commands from the backend (executed on the game thread) ─────────────

    private (bool ok, string? reason) ExecuteCommand(string type, string? matchId, JsonElement payload)
    {
        switch (type)
        {
            case "MATCH_PREPARE":
            {
                if (!payload.TryGetProperty("config", out var cfg)) return (false, "config missing");
                var plan = MatchPlan.FromJson(cfg);
                if (matchId is not null && Guid.Parse(matchId) != plan.MatchId) return (false, "match id mismatch");
                _plan = plan;
                _map = null;
                _seriesWinsA = _seriesWinsB = 0;
                _pausesUsed["A"] = _pausesUsed["B"] = 0;
                _status = "IN_USE";
                // after a plugin restart the match is already running: keep its map and warmup/round state untouched
                ConfigureServer(plan, startWarmup: !_recoveringMatch);
                if (plan.Maps.Count > 0 && !(_recoveringMatch && Server.MapName == plan.Maps[0].Key)) ChangeMap(plan.Maps[0]);
                if (_recoveringMatch) ResumeRunningMap(plan);
                Emit("match.configured");
                return (true, null);
            }
            case "MATCH_START":
            case "MATCH_RESUME":
            {
                if (_plan is null) return (false, "no match prepared");
                if (payload.TryGetProperty("config", out var cfg)) _plan = MatchPlan.FromJson(cfg);
                var next = _plan.Maps.FirstOrDefault(m => m.MapNumber == (_map?.MapNumber ?? 0) + 1) ?? _plan.Maps.FirstOrDefault();
                if (next is null) return (false, "no map chosen yet");
                if (Server.MapName != next.Key) ChangeMap(next);
                _map = new MapProgress { MapNumber = next.MapNumber };
                _stats.Clear(); // every map starts with fresh counters
                Server.ExecuteCommand("mp_warmup_end");
                Server.ExecuteCommand("mp_restartgame 3");
                Emit("map.started", new() { ["mapNumber"] = next.MapNumber });
                return (true, null);
            }
            case "MATCH_RESTART":
                Server.ExecuteCommand("mp_restartgame 3");
                if (_map is not null) { _map.ScoreA = 0; _map.ScoreB = 0; }
                return (true, null);
            case "MATCH_PAUSE": SetPaused(true, null, "admin"); return (true, null);
            case "MATCH_UNPAUSE": SetPaused(false, null, null); return (true, null);
            case "MATCH_CANCEL":
                ResetMatch();
                return (true, null);
            case "MATCH_CHANGE_MAP":
            {
                var key = payload.TryGetProperty("mapKey", out var k) ? k.GetString() : null;
                if (key is null) return (false, "mapKey missing");
                var workshop = payload.TryGetProperty("workshopId", out var w) && w.ValueKind == JsonValueKind.String ? w.GetString() : null;
                var number = payload.TryGetProperty("mapNumber", out var n) ? n.GetInt32() : 1;
                ChangeMap(new MapPlan(number, key, workshop, null));
                return (true, null);
            }
            case "MATCH_FORCE_TEAM":
            {
                var steam = ulong.Parse(payload.GetProperty("steamId").GetString()!);
                var slot = payload.GetProperty("team").GetString()!;
                _plan?.Players.Values.ToList().ForEach(l => l.RemoveAll(p => p.SteamId == steam));
                var player = Utilities.GetPlayers().FirstOrDefault(p => p.SteamID == steam);
                _plan?.Players[slot].Add(new PlayerSlot(steam, player?.PlayerName ?? "", false));
                if (player is { IsValid: true }) PlaceOnSide(player, slot);
                return (true, null);
            }
            case "MATCH_REMOVE_PLAYER":
            {
                var steam = ulong.Parse(payload.GetProperty("steamId").GetString()!);
                _plan?.Players.Values.ToList().ForEach(l => l.RemoveAll(p => p.SteamId == steam));
                var player = Utilities.GetPlayers().FirstOrDefault(p => p.SteamID == steam);
                if (player is { IsValid: true }) Server.ExecuteCommand($"kickid {player.UserId} removed_from_match");
                return (true, null);
            }
            case "MATCH_PARDON_PLAYER":
            {
                var steam = ulong.Parse(payload.GetProperty("steamId").GetString()!);
                _teamDamage.Remove(steam);
                _teamKills.Remove(steam);
                return (true, null);
            }
            case "MATCH_SET_SCORE": // informational: the backend stores the corrected score, the game keeps playing
                return (true, null);
            case "PLAYER_REFRESH_SKINS":
                if (payload.TryGetProperty("steamId", out var sid) && ulong.TryParse(sid.GetString(), out var steamId)) _ = ApplySkinsAsync(steamId);
                else foreach (var p in Utilities.GetPlayers().Where(p => !p.IsBot)) _ = ApplySkinsAsync(p.SteamID);
                return (true, null);
            case "SERVER_RELOAD_CONFIG":
                return (true, null);
            default:
                return (false, $"unsupported command {type}");
        }
    }

    private bool _recoveringMatch;

    /// <summary>
    /// After a plugin restart in the middle of a map the counting has to continue: the map progress is rebuilt from the
    /// game's own team scores (kills of the minutes before the restart are lost, everything from now on counts again).
    /// </summary>
    private void ResumeRunningMap(MatchPlan plan)
    {
        try
        {
            var rules = Utilities.FindAllEntitiesByDesignerName<CCSGameRulesProxy>("cs_gamerules").FirstOrDefault()?.GameRules;
            if (rules is null || rules.WarmupPeriod) return;
            var mapPlan = plan.Maps.FirstOrDefault(m => m.Key == Server.MapName) ?? plan.Maps.FirstOrDefault();
            _map = new MapProgress { MapNumber = mapPlan?.MapNumber ?? 1 };
            foreach (var team in Utilities.FindAllEntitiesByDesignerName<CCSTeam>("cs_team_manager"))
            {
                var t = (CsTeam)team.TeamNum;
                if (t is not (CsTeam.CounterTerrorist or CsTeam.Terrorist)) continue;
                var slot = SlotPlayingSide(t);
                if (slot == "A") _map.ScoreA = team.Score; else if (slot == "B") _map.ScoreB = team.Score;
            }
            Logger.LogInformation("[Celtist] resumed map {Map}: {A}:{B}", _map.MapNumber, _map.ScoreA, _map.ScoreB);
        }
        catch (Exception e) { Logger.LogWarning("[Celtist] could not resume the running map: {Message}", e.Message); }
    }

    private void ConfigureServer(MatchPlan plan, bool startWarmup = true)
    {
        var maxRounds = plan.RoundsToWin * 2 - 2;
        Server.ExecuteCommand($"mp_maxrounds {maxRounds}");
        Server.ExecuteCommand("mp_overtime_enable 1");
        Server.ExecuteCommand("mp_match_can_clinch 1");
        Server.ExecuteCommand("sv_pausable 1");
        Server.ExecuteCommand("mp_autokick 0");
        // a vote kick removes the player but does not lock them out: they can reconnect at once (the backend still decides who may join)
        Server.ExecuteCommand("sv_vote_kick_ban_duration 0");
        Server.ExecuteCommand("removeallids");
        // the warmup is a fixed countdown (players may still connect and buy), not an endless wait; "Match starten" ends it early
        Server.ExecuteCommand("mp_warmup_pausetimer 0");
        Server.ExecuteCommand($"mp_warmuptime {Math.Clamp(Config.WarmupSeconds, 10, 600)}");
        if (startWarmup) Server.ExecuteCommand("mp_warmup_start");
        Server.ExecuteCommand($"mp_limitteams 0");
        Server.ExecuteCommand("mp_autoteambalance 0");
    }

    private void ChangeMap(MapPlan map)
    {
        // workshop maps need ds_workshop_changelevel; stock maps use changelevel
        if (!string.IsNullOrEmpty(map.WorkshopId)) Server.ExecuteCommand($"ds_workshop_changelevel {map.Key}");
        else Server.ExecuteCommand($"changelevel {map.Key}");
    }

    private void ResetMatch()
    {
        foreach (var p in Utilities.GetPlayers().Where(p => p is { IsBot: false, IsValid: true }))
            Server.ExecuteCommand($"kickid {p.UserId} match_cancelled");
        _plan = null; _map = null; _paused = false;
        _teamDamage.Clear(); _teamKills.Clear(); _stats.Clear();
        Server.ExecuteCommand("mp_unpause_match");
        _status = "READY";
    }

    // ───────────── chat commands ─────────────

    private void RegisterChatCommands()
    {
        AddCommand("css_pause", "Pause the match", (p, _) => OnPauseCommand(p, true));
        AddCommand("css_unpause", "Unpause the match", (p, _) => OnPauseCommand(p, false));
        AddCommand("css_nobans", "Admins: toggle automatic team-damage penalties for this match", OnNoBans);
        AddCommand("css_pardon", "Admins: !pardon <player> clears a player's team-damage counters", OnPardon);
        AddCommand("css_unban", "Remove all server-side bans (vote kicks) or one SteamID64: !unban [steamid64]", OnUnbanCommand);
        AddCommand("css_ct", "Switch yourself to the CT side (listed players, outside of a running match)", (p, i) => OnSwitchSide(p, CsTeam.CounterTerrorist));
        AddCommand("css_t", "Switch yourself to the T side (listed players, outside of a running match)", (p, i) => OnSwitchSide(p, CsTeam.Terrorist));
        AddCommand("css_test", "Test mode for listed players: endless warmup, endless money, buy anywhere", OnTestCommand);
        AddCommand("css_noclip", "Fly through walls (listed players, outside of a running match)", OnNoclipCommand);
        AddCommand("css_agent", "Toggle your agent (player model) from your loadout", OnAgentCommand);
        AddCommand("css_skch", "Admins: !skch <level 0-3> <player|all> [minutes]", OnSkch);
    }

    /// <summary>Helps to find out why a skin does not show: flips the mesh group of the held weapon and prints what is set on it.</summary>
    /// <summary>Players who chose their side themselves: the match plan does not move them back at spawn.</summary>
    private readonly HashSet<ulong> _freeSide = new();

    private void OnSwitchSide(CCSPlayerController? player, CsTeam team)
    {
        if (player is null || !player.IsValid || !Config.NoclipSteamIds.Contains(player.SteamID.ToString())) return;
        if (_map is not null) { player.PrintToChat(" No side change while a match map is running."); return; }
        _freeSide.Add(player.SteamID);
        player.ChangeTeam(team);
        player.PrintToChat($" [Celtist] You are now {(team == CsTeam.CounterTerrorist ? "CT" : "T")}.");
    }

    /// <summary>Who may come back is decided by the platform (match assignment), not by the game's own ban list.</summary>
    private void ClearGameBans(ulong? steamId = null)
    {
        if (steamId is { } id)
        {
            var account = id - SteamId64Base;
            Server.ExecuteCommand($"removeid [U:1:{account}]");
            Server.ExecuteCommand($"removeid STEAM_1:{account % 2}:{account / 2}");
        }
        Server.ExecuteCommand("removeallids");
        Server.ExecuteCommand("writeid");
    }

    private void OnUnbanCommand(CCSPlayerController? player, CommandInfo info)
    {
        if (player is null || !player.IsValid || !Config.NoclipSteamIds.Contains(player.SteamID.ToString())) return;
        ulong? target = ulong.TryParse(info.ArgString.Trim(), out var parsed) ? parsed : null;
        ClearGameBans(target);
        player.PrintToChat($" [Celtist] Server bans cleared{(target is null ? string.Empty : " for " + target)}.");
    }

    private bool _testMode;
    private bool _testTimerStarted;

    /// <summary>
    /// !test: endless warmup, money topped up every second and buying anywhere. Only for listed players and only while no
    /// match map is running; a second !test switches everything back to the normal match settings.
    /// </summary>
    private void OnTestCommand(CCSPlayerController? player, CommandInfo info)
    {
        if (player is null || !player.IsValid || !Config.NoclipSteamIds.Contains(player.SteamID.ToString())) return;
        if (_map is not null) { player.PrintToChat(" No test mode while a match map is running."); return; }
        _testMode = !_testMode;
        if (_testMode)
        {
            Server.ExecuteCommand("mp_warmup_pausetimer 1");
            Server.ExecuteCommand("mp_warmup_start");
            Server.ExecuteCommand("mp_buy_anywhere 1");
            Server.ExecuteCommand("mp_buytime 9999");
            Server.ExecuteCommand("mp_maxmoney 65535");
            Server.ExecuteCommand("mp_startmoney 65535");
            if (!_testTimerStarted)
            {
                _testTimerStarted = true;
                AddTimer(1f, TopUpMoney, TimerFlags.REPEAT);
            }
            TopUpMoney();
        }
        else
        {
            Server.ExecuteCommand("mp_warmup_pausetimer 0");
            Server.ExecuteCommand("mp_buy_anywhere 0");
            Server.ExecuteCommand("mp_buytime 20");
            Server.ExecuteCommand("mp_maxmoney 16000");
            Server.ExecuteCommand("mp_startmoney 800");
        }
        Server.PrintToChatAll($" [Celtist] Test mode {(_testMode ? "on: endless warmup, endless money" : "off")}.");
    }

    private void TopUpMoney()
    {
        if (!_testMode) return;
        foreach (var p in Utilities.GetPlayers().Where(p => p is { IsValid: true, IsBot: false } && Config.NoclipSteamIds.Contains(p.SteamID.ToString())))
        {
            var money = p.InGameMoneyServices;
            if (money is null || money.Account >= 60000) continue;
            money.Account = 65535;
            Utilities.SetStateChanged(p, "CCSPlayerController", "m_pInGameMoneyServices");
        }
    }

    private void OnNoclipCommand(CCSPlayerController? player, CommandInfo info)
    {
        if (player is null || !player.IsValid || !player.PawnIsAlive) return;
        if (!Config.NoclipSteamIds.Contains(player.SteamID.ToString())) { player.PrintToChat(" You are not allowed to use noclip."); return; }
        // friendly (CUSTOM) matches and the time before a match start allow it; ranked and tournament maps never do
        if (_map is not null && !string.Equals(_plan?.KindName, "CUSTOM", StringComparison.OrdinalIgnoreCase)) { player.PrintToChat(" No noclip in a tournament or ranked match."); return; }
        var pawn = player.PlayerPawn.Value;
        if (pawn is null || !pawn.IsValid) return;
        var on = pawn.MoveType != MoveType_t.MOVETYPE_NOCLIP;
        var type = on ? MoveType_t.MOVETYPE_NOCLIP : MoveType_t.MOVETYPE_WALK;
        pawn.MoveType = type;
        pawn.ActualMoveType = type;
        Utilities.SetStateChanged(pawn, "CBaseEntity", "m_MoveType");
        player.PrintToChat($" [Celtist] Noclip {(on ? "on" : "off")}.");
    }

    private bool IsAdmin(CCSPlayerController? p) => p is null || (_plan?.Admins.Contains(p.SteamID) ?? false);

    private void OnPauseCommand(CCSPlayerController? player, bool pause)
    {
        if (_plan is null || player is null) return;
        var slot = _plan.SlotOf(player.SteamID);
        var admin = IsAdmin(player);
        if (slot is null && !admin) { player.PrintToChat(" \x07Only players of this match can pause."); return; }
        if (pause)
        {
            if (_paused) return;
            if (!admin && slot is not null)
            {
                if (_pausesUsed[slot] >= _plan.PausesPerTeam) { player.PrintToChat(" \x07Your team has no pauses left."); return; }
                _pausesUsed[slot]++;
            }
            SetPaused(true, slot, $"{player.PlayerName}");
        }
        else
        {
            if (!_paused) return;
            if (!admin) { player.PrintToChat(" \x07Only admins can end a pause early."); return; }
            SetPaused(false, slot, null);
        }
    }

    private void SetPaused(bool pause, string? team, string? reason)
    {
        _paused = pause;
        var token = ++_pauseToken;
        Server.ExecuteCommand(pause ? "mp_pause_match" : "mp_unpause_match");
        Server.PrintToChatAll(pause ? $" \x04[Celtist]\x01 Match paused ({reason})." : " \x04[Celtist]\x01 Match continues.");
        Emit(pause ? "match.paused" : "match.unpaused", pause ? new() { ["team"] = team, ["reason"] = Trim(reason, 120) } : null);
        if (pause && _plan is not null)
            AddTimer(_plan.PauseMaxSeconds, () => { if (_paused && token == _pauseToken) SetPaused(false, null, null); });
    }

    private void OnNoBans(CCSPlayerController? player, CommandInfo info)
    {
        if (!IsAdmin(player)) { player?.PrintToChat(" \x07Admins only."); return; }
        _penaltiesEnabled = !_penaltiesEnabled;
        Server.PrintToChatAll($" \x04[Celtist]\x01 Team-damage penalties {(_penaltiesEnabled ? "enabled" : "disabled")}.");
    }

    private void OnPardon(CCSPlayerController? player, CommandInfo info)
    {
        if (!IsAdmin(player)) { player?.PrintToChat(" \x07Admins only."); return; }
        var name = info.ArgString.Trim();
        var target = Utilities.GetPlayers().FirstOrDefault(p => p.IsValid && (p.SteamID.ToString() == name || p.PlayerName.Contains(name, StringComparison.OrdinalIgnoreCase)));
        if (target is null) { player?.PrintToChat(" \x07Player not found."); return; }
        _teamDamage.Remove(target.SteamID);
        _teamKills.Remove(target.SteamID);
        Server.PrintToChatAll($" \x04[Celtist]\x01 {target.PlayerName} was pardoned.");
    }

    /// <summary>!skch only forwards: the backend checks the actor's skin.assign + skin.level.N rights.</summary>
    private void OnSkch(CCSPlayerController? player, CommandInfo info)
    {
        if (player is null || _api is null) return;
        if (info.ArgCount < 3 || !int.TryParse(info.GetArg(1), out var level) || level is < 0 or > 3) { player.PrintToChat(" \x07Usage: !skch <level 0-3> <player|all> [minutes]"); return; }
        var targetArg = info.GetArg(2);
        string target;
        if (targetArg.Equals("all", StringComparison.OrdinalIgnoreCase)) target = "all";
        else
        {
            var found = Utilities.GetPlayers().FirstOrDefault(p => p.IsValid && !p.IsBot && p.PlayerName.Contains(targetArg, StringComparison.OrdinalIgnoreCase));
            if (found is null) { player.PrintToChat(" \x07Player not found."); return; }
            target = found.SteamID.ToString();
        }
        int? minutes = info.ArgCount > 3 && int.TryParse(info.GetArg(3), out var m) ? m : null;
        var actor = player.SteamID.ToString();
        var actorIndex = player.Index;
        _ = Task.Run(async () =>
        {
            var response = await _api.PostAsync("/server/v1/skin-permissions", new { actorSteamId = actor, target, level, durationMinutes = minutes }).ConfigureAwait(false);
            var ok = response.Ok && response.Json().TryGetProperty("ok", out var o) && o.GetBoolean();
            var text = ok ? $" \x04[Celtist]\x01 Skin level {level} granted." : $" \x07[Celtist]\x01 Not allowed ({(response.Ok && response.Json().TryGetProperty("error", out var err) ? err.GetString() : response.Status.ToString())}).";
            Server.NextFrame(() => Utilities.GetPlayerFromIndex((int)actorIndex)?.PrintToChat(text));
        });
    }
}
