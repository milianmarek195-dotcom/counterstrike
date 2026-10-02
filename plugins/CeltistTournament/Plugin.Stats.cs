using CounterStrikeSharp.API.Core;

namespace Celtist.Tournament;

/// <summary>
/// Own match statistics. The game's built-in totals also count bots, so the plugin counts from the events instead:
/// only kills, deaths, assists, damage and headshots between two human players of the match are recorded.
/// A kill is split by weapon class (AWP, AK-47, pistol, other) for the backend.
/// </summary>
public sealed partial class CeltistTournamentPlugin
{
    private sealed class Counters
    {
        public int Kills, Deaths, Assists, Headshots, Damage, KillsAwp, KillsAk47, KillsPistol;
    }

    private readonly Dictionary<ulong, Counters> _stats = new();

    private Counters StatsOf(ulong steamId)
    {
        if (!_stats.TryGetValue(steamId, out var c)) _stats[steamId] = c = new Counters();
        return c;
    }

    private static readonly HashSet<string> Pistols = new(StringComparer.OrdinalIgnoreCase)
    {
        "glock", "hkp2000", "usp_silencer", "usp_silencer_off", "p250", "fiveseven", "tec9", "cz75a", "deagle", "elite", "revolver",
    };

    /// <summary>Weapon class of a death/hurt event weapon name (e.g. "weapon_ak47" or "ak47").</summary>
    public static string WeaponClass(string? weapon)
    {
        var w = (weapon ?? string.Empty).Replace("weapon_", string.Empty, StringComparison.OrdinalIgnoreCase).Trim();
        if (w.Equals("awp", StringComparison.OrdinalIgnoreCase)) return "AWP";
        if (w.Equals("ak47", StringComparison.OrdinalIgnoreCase)) return "AK47";
        return Pistols.Contains(w) ? "PISTOL" : "OTHER";
    }

    private static bool IsHuman(CCSPlayerController? p) => p is { IsValid: true, IsBot: false };

    private bool InMatch(CCSPlayerController p) => _plan?.SlotOf(p.SteamID) is not null;

    private void CountDamage(EventPlayerHurt e)
    {
        if (_plan is null || _map is null) return;
        var attacker = e.Attacker; var victim = e.Userid;
        if (!IsHuman(attacker) || !IsHuman(victim) || attacker!.Slot == victim!.Slot || attacker.Team == victim.Team) return;
        if (!InMatch(attacker) || !InMatch(victim)) return;
        StatsOf(attacker.SteamID).Damage += Math.Max(0, e.DmgHealth);
    }

    private void CountDeath(EventPlayerDeath e)
    {
        if (_plan is null || _map is null) return;
        var attacker = e.Attacker; var victim = e.Userid; var assister = e.Assister;
        if (!IsHuman(victim) || !InMatch(victim!)) return;

        // A death caused by a bot is not a match death. World damage and suicides still count as deaths.
        var killedByBot = attacker is { IsValid: true, IsBot: true };
        if (!killedByBot) StatsOf(victim!.SteamID).Deaths++;

        if (!IsHuman(attacker) || attacker!.Slot == victim!.Slot || attacker.Team == victim.Team || !InMatch(attacker)) return;
        var c = StatsOf(attacker.SteamID);
        c.Kills++;
        if (e.Headshot) c.Headshots++;
        switch (WeaponClass(e.Weapon))
        {
            case "AWP": c.KillsAwp++; break;
            case "AK47": c.KillsAk47++; break;
            case "PISTOL": c.KillsPistol++; break;
        }
        if (IsHuman(assister) && assister!.Slot != attacker.Slot && InMatch(assister) && assister.Team == attacker.Team) StatsOf(assister.SteamID).Assists++;
    }
}
