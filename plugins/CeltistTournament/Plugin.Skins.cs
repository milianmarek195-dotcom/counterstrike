using System.Text.Json;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Memory;

namespace Celtist.Tournament;

public sealed partial class CeltistTournamentPlugin
{
    private sealed record SkinItem(int WeaponDefIndex, int PaintIndex, int Pattern, float Float, bool StatTrak, int StatTrakCount, string? NameTag);

    /// <summary>
    /// Fetches the player's loadout (already filtered by the backend to what the player may use right now) and applies
    /// it to the weapons they hold. Disabled unless SkinsEnabled is true in the plugin config AND the server has skins
    /// enabled in the admin panel. Any failure leaves the default skins untouched: skins must never break a match.
    /// </summary>
    private async Task ApplySkinsAsync(ulong steamId)
    {
        if (!Config.SkinsEnabled || _api is null) return;
        try
        {
            var response = await _api.GetAsync($"/server/v1/loadouts/{steamId}").ConfigureAwait(false);
            if (!response.Ok) return;
            var json = response.Json();
            if (!json.GetProperty("enabled").GetBoolean()) return;
            var items = new List<SkinItem>();
            foreach (var i in json.GetProperty("items").EnumerateArray())
                items.Add(new SkinItem(i.GetProperty("weaponDefIndex").GetInt32(), i.GetProperty("paintIndex").GetInt32(), i.GetProperty("pattern").GetInt32(),
                    (float)i.GetProperty("float").GetDouble(), i.GetProperty("statTrak").GetBoolean(), i.GetProperty("statTrakCount").GetInt32(),
                    i.TryGetProperty("nameTag", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null));
            if (items.Count == 0) return;
            Server.NextFrame(() => { _loadouts[steamId] = items; ApplyToHeldWeapons(steamId); });
        }
        catch (Exception e) { Logger.LogWarning("[Celtist] skin load failed for {Steam}: {Message}", steamId, e.Message); }
    }

    private readonly Dictionary<ulong, List<SkinItem>> _loadouts = new();

    private void ApplyToHeldWeapons(ulong steamId)
    {
        if (!_loadouts.TryGetValue(steamId, out var items)) return;
        var player = Utilities.GetPlayerFromSteamId(steamId);
        var weapons = player?.PlayerPawn.Value?.WeaponServices?.MyWeapons;
        if (weapons is null) return;
        foreach (var handle in weapons)
        {
            var weapon = handle.Value;
            if (weapon is null || !weapon.IsValid) continue;
            ApplyToWeapon(weapon, steamId, items);
        }
    }

    /// <summary>
    /// Bought and picked-up weapons are new entities: the client only takes the skin if it is set when the weapon is
    /// created, so this runs for every weapon entity and applies the owner's loadout one frame later (when the owner is set).
    /// </summary>
    private void OnWeaponCreated(CEntityInstance entity)
    {
        if (!Config.SkinsEnabled || !entity.DesignerName.StartsWith("weapon_", StringComparison.Ordinal)) return;
        var weapon = new CBasePlayerWeapon(entity.Handle);
        Server.NextFrame(() =>
        {
            try
            {
                if (!weapon.IsValid) return;
                var owner = weapon.OwnerEntity.Value;
                if (owner is null) return;
                var pawn = new CCSPlayerPawn(owner.Handle);
                var controllerEntity = pawn.Controller.Value;
                if (controllerEntity is null) return;
                var player = new CCSPlayerController(controllerEntity.Handle);
                if (!IsHuman(player)) return;
                if (_loadouts.TryGetValue(player.SteamID, out var items)) ApplyToWeapon(weapon, player.SteamID, items);
            }
            catch (Exception e) { Logger.LogWarning("[Celtist] skin on new weapon failed: {Message}", e.Message); }
        });
    }

    private void ApplyToWeapon(CBasePlayerWeapon weapon, ulong steamId, List<SkinItem> items)
    {
        var def = weapon.AttributeManager.Item.ItemDefinitionIndex;
        var item = items.FirstOrDefault(i => i.WeaponDefIndex == def);
        if (item is null) return;
        try
        {
            weapon.AttributeManager.Item.ItemID = 16384; // marks the econ item as custom so the fallback values below are used
            weapon.AttributeManager.Item.ItemIDLow = 16384 & 0xFFFFFFFF;
            weapon.AttributeManager.Item.ItemIDHigh = 0;
            weapon.AttributeManager.Item.AccountID = (uint)steamId; // the item belongs to the player, otherwise the client ignores the fallback paint
            weapon.FallbackPaintKit = item.PaintIndex;
            weapon.FallbackSeed = item.Pattern;
            weapon.FallbackWear = item.Float;
            weapon.FallbackStatTrak = item.StatTrak ? item.StatTrakCount : -1;
            Utilities.SetStateChanged(weapon, "CEconEntity", "m_AttributeManager");
        }
        catch (Exception e) { Logger.LogWarning("[Celtist] could not apply skin to weapon {Def}: {Message}", def, e.Message); }
    }
}
