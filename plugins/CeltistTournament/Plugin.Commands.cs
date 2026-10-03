using System.Text.Json;
using Celtist.Tournament.Match;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Cvars;
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
        AddCommand("css_agent", "Toggle your agent (player model) from your loadout", OnAgentCommand);
        AddCommand("css_skch", "Admins: !skch <level 0-3> <player|all> [minutes]", OnSkch);
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
