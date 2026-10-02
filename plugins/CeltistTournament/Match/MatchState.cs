using System.Text.Json;

namespace Celtist.Tournament.Match;

public sealed record PlayerSlot(ulong SteamId, string Name, bool IsSubstitute);
public sealed record MapPlan(int MapNumber, string Key, string? WorkshopId, string? TeamAStartSide);

/// <summary>The match as the backend describes it (GET /server/v1/matches/:id/config, also embedded in MATCH_PREPARE).</summary>
public sealed class MatchPlan
{
    public required Guid MatchId { get; init; }
    public int BestOf { get; init; } = 1;
    public string KindName { get; init; } = "";
    public Dictionary<string, List<PlayerSlot>> Players { get; } = new() { ["A"] = new(), ["B"] = new() };
    public Dictionary<string, int> MaxPlayers { get; } = new() { ["A"] = 5, ["B"] = 5 };
    public Dictionary<string, string> TeamNames { get; } = new() { ["A"] = "Team A", ["B"] = "Team B" };
    public List<MapPlan> Maps { get; } = new();
    public int RoundsToWin { get; init; } = 13;
    public int PausesPerTeam { get; init; } = 2;
    public int PauseMaxSeconds { get; init; } = 120;
    public int TeamKillLimit { get; init; } = 3;
    public int TeamDamageLimit { get; init; } = 300;
    public HashSet<ulong> Admins { get; } = new();
    public bool SkinsEnabled { get; init; }

    public static MatchPlan FromJson(JsonElement c)
    {
        var rules = c.GetProperty("rules");
        var plan = new MatchPlan
        {
            MatchId = Guid.Parse(c.GetProperty("matchId").GetString()!),
            BestOf = c.GetProperty("bestOf").GetInt32(),
            KindName = c.TryGetProperty("kind", out var k) ? k.GetString() ?? "" : "",
            RoundsToWin = rules.GetProperty("roundsToWin").GetInt32(),
            PausesPerTeam = rules.GetProperty("pausesPerTeam").GetInt32(),
            PauseMaxSeconds = rules.GetProperty("pauseMaxSeconds").GetInt32(),
            TeamKillLimit = rules.GetProperty("teamKillLimit").GetInt32(),
            TeamDamageLimit = rules.GetProperty("teamDamageLimit").GetInt32(),
            SkinsEnabled = c.TryGetProperty("skinsEnabled", out var s) && s.GetBoolean(),
        };
        foreach (var slot in new[] { "A", "B" })
        {
            var team = c.GetProperty("teams").GetProperty(slot);
            if (team.ValueKind == JsonValueKind.Null) continue;
            plan.TeamNames[slot] = team.GetProperty("name").GetString() ?? slot;
            plan.MaxPlayers[slot] = team.GetProperty("maxPlayers").GetInt32();
            foreach (var p in team.GetProperty("players").EnumerateArray())
                plan.Players[slot].Add(new PlayerSlot(ulong.Parse(p.GetProperty("steamId").GetString()!), p.GetProperty("name").GetString() ?? "", p.GetProperty("isSubstitute").GetBoolean()));
        }
        foreach (var m in c.GetProperty("maps").EnumerateArray())
            plan.Maps.Add(new MapPlan(m.GetProperty("mapNumber").GetInt32(), m.GetProperty("key").GetString()!,
                m.TryGetProperty("workshopId", out var w) && w.ValueKind == JsonValueKind.String ? w.GetString() : null,
                m.TryGetProperty("teamAStartSide", out var side) && side.ValueKind == JsonValueKind.String ? side.GetString() : null));
        foreach (var a in c.GetProperty("adminSteamIds").EnumerateArray()) plan.Admins.Add(ulong.Parse(a.GetString()!));
        return plan;
    }

    /// <summary>Which team slot (A/B) a SteamID belongs to, or null if the player is not in the match.</summary>
    public string? SlotOf(ulong steamId)
    {
        foreach (var (slot, list) in Players)
            if (list.Any(p => p.SteamId == steamId)) return slot;
        return null;
    }
}

/// <summary>Running totals of the current map. Scores are tracked per slot so side swaps never confuse them.</summary>
public sealed class MapProgress
{
    public int MapNumber { get; init; }
    public DateTimeOffset StartedAt { get; init; } = DateTimeOffset.UtcNow;
    public int ScoreA { get; set; }
    public int ScoreB { get; set; }
    public int RoundsPlayed => ScoreA + ScoreB;
    public bool ResultSent { get; set; }
}

public static class Sides
{
    /// <summary>
    /// The side ("CT" or "T") a slot plays on after <paramref name="roundsPlayed"/> rounds. Regulation swaps after
    /// <paramref name="maxRounds"/>/2 rounds; each overtime period is 6 rounds with a swap after 3.
    /// </summary>
    public static string SideOf(string slot, string teamAStartSide, int roundsPlayed, int maxRounds)
    {
        var aSide = teamAStartSide;
        bool swapped;
        if (roundsPlayed < maxRounds) swapped = roundsPlayed >= maxRounds / 2;
        else
        {
            var inOt = (roundsPlayed - maxRounds) % 6;
            var otIndex = (roundsPlayed - maxRounds) / 6;
            // Regulation ends swapped; each overtime starts from the side the previous one finished on, then swaps at 3.
            var swappedAtStartOfOt = (1 + otIndex) % 2 == 1;
            swapped = swappedAtStartOfOt ^ (inOt >= 3);
        }
        if (swapped) aSide = aSide == "CT" ? "T" : "CT";
        return slot == "A" ? aSide : aSide == "CT" ? "T" : "CT";
    }
}
