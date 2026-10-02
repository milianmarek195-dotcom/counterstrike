using System.Text.Json;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Memory;
using CounterStrikeSharp.API.Modules.Memory.DynamicFunctions;
using CounterStrikeSharp.API.Modules.Timers;

namespace Celtist.Tournament;

public sealed partial class CeltistTournamentPlugin
{
    private sealed record SkinItem(string Slot, int WeaponDefIndex, int PaintIndex, int Pattern, float Float, bool StatTrak, int StatTrakCount, string? NameTag);

    private readonly Dictionary<ulong, List<SkinItem>> _loadouts = new();

    // Econ attributes are set through the game's own function (located by signature, see gamedata/celtist.json).
    // The signature has to be re-checked after big CS2 updates; if it cannot be resolved, knives and gloves stay default.
    private MemoryFunctionVoid<nint, string, float>? _setAttribute;
    private bool _attributeSetterTried;
    private long _nextItemId = 65_578; // synthetic item ids for knives and gloves, unique per server run

    /// <summary>
    /// Fetches the player's loadout (already filtered by the backend to what the player may use right now) and applies
    /// it. Disabled unless SkinsEnabled is true in the plugin config AND the server has skins enabled in the admin
    /// panel. Any failure leaves the default skins untouched: skins must never break a match.
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
                items.Add(new SkinItem(
                    i.GetProperty("slot").GetString() ?? "", i.GetProperty("weaponDefIndex").GetInt32(), i.GetProperty("paintIndex").GetInt32(), i.GetProperty("pattern").GetInt32(),
                    (float)i.GetProperty("float").GetDouble(), i.GetProperty("statTrak").GetBoolean(), i.GetProperty("statTrakCount").GetInt32(),
                    i.TryGetProperty("nameTag", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null));
            if (items.Count == 0) return;
            Server.NextFrame(() => { _loadouts[steamId] = items; ApplyToHeldWeapons(steamId); ApplyGloves(steamId); });
        }
        catch (Exception e) { Logger.LogWarning("[Celtist] skin load failed for {Steam}: {Message}", steamId, e.Message); }
    }

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

    private static bool IsKnife(string? designerName) => designerName is not null && (designerName.Contains("knife", StringComparison.Ordinal) || designerName.Contains("bayonet", StringComparison.Ordinal));

    private void ApplyToWeapon(CBasePlayerWeapon weapon, ulong steamId, List<SkinItem> items)
    {
        try
        {
            var econ = weapon.AttributeManager.Item;
            if (IsKnife(weapon.DesignerName))
            {
                ApplyKnife(weapon, steamId, items);
                return;
            }

            var def = econ.ItemDefinitionIndex;
            var item = items.FirstOrDefault(i => i.WeaponDefIndex == def && i.Slot is not ("KNIFE" or "GLOVES"));
            if (item is null) return;

            econ.ItemID = 16384; // marks the econ item as custom so the fallback values below are used
            econ.ItemIDLow = 16384 & 0xFFFFFFFF;
            econ.ItemIDHigh = 0;
            econ.AccountID = (uint)steamId; // the item belongs to the player, otherwise the client ignores the fallback paint
            weapon.FallbackPaintKit = item.PaintIndex;
            weapon.FallbackSeed = item.Pattern;
            weapon.FallbackWear = item.Float;
            weapon.FallbackStatTrak = item.StatTrak ? item.StatTrakCount : -1;
            Utilities.SetStateChanged(weapon, "CEconEntity", "m_AttributeManager");
        }
        catch (Exception e) { Logger.LogWarning("[Celtist] could not apply skin to weapon: {Message}", e.Message); }
    }

    // ───────────── knife ─────────────

    /// <summary>
    /// A knife is not a paint kit on a fixed weapon: the entity has to become another knife type (subclass + definition
    /// index) and then gets the paint attributes of the chosen finish.
    /// </summary>
    private void ApplyKnife(CBasePlayerWeapon weapon, ulong steamId, List<SkinItem> items)
    {
        var item = items.FirstOrDefault(i => i.Slot == "KNIFE");
        if (item is null) return;
        var econ = weapon.AttributeManager.Item;

        if (econ.ItemDefinitionIndex != item.WeaponDefIndex)
            weapon.AcceptInput("ChangeSubclass", value: item.WeaponDefIndex.ToString());
        econ.ItemDefinitionIndex = (ushort)item.WeaponDefIndex;
        econ.EntityQuality = item.StatTrak ? 9 : 3; // 3 = the star (unusual) quality every real knife has
        econ.AttributeList.Attributes.RemoveAll();
        econ.NetworkedDynamicAttributes.Attributes.RemoveAll();
        StampItemId(econ);
        econ.AccountID = (uint)steamId;
        SetPaintAttributes(econ, item);
        Utilities.SetStateChanged(weapon, "CEconEntity", "m_AttributeManager");
    }

    // ───────────── gloves ─────────────

    private void ApplyGloves(ulong steamId)
    {
        if (!_loadouts.TryGetValue(steamId, out var items)) return;
        var item = items.FirstOrDefault(i => i.Slot == "GLOVES");
        var player = Utilities.GetPlayerFromSteamId(steamId);
        if (item is null || !IsHuman(player) || !player!.PawnIsAlive) return;
        var pawn = player.PlayerPawn.Value;
        if (pawn is null || !pawn.IsValid) return;

        var gloves = pawn.EconGloves;
        gloves.NetworkedDynamicAttributes.Attributes.RemoveAll();
        gloves.AttributeList.Attributes.RemoveAll();
        player.ExecuteClientCommand("lastinv"); // briefly switch weapons so the old glove model does not overlap

        AddTimer(0.08f, () =>
        {
            try
            {
                if (!IsHuman(player) || !player.PawnIsAlive || !pawn.IsValid) return;
                gloves.ItemDefinitionIndex = (ushort)item.WeaponDefIndex;
                StampItemId(gloves);
                gloves.AccountID = (uint)steamId;
                SetPaintAttributes(gloves, item);
                gloves.Initialized = true;

                // the glove model is part of the player model: toggling the body group makes the client rebuild it
                pawn.AcceptInput("SetBodygroup", value: "first_or_third_person,0");
                AddTimer(0.2f, () => { if (pawn.IsValid) pawn.AcceptInput("SetBodygroup", value: "first_or_third_person,1"); }, TimerFlags.STOP_ON_MAPCHANGE);
                player.ExecuteClientCommand("lastinv");
            }
            catch (Exception e) { Logger.LogWarning("[Celtist] could not apply gloves: {Message}", e.Message); }
        }, TimerFlags.STOP_ON_MAPCHANGE);
    }

    // ───────────── helpers ─────────────

    private void StampItemId(CEconItemView item)
    {
        var id = (ulong)Interlocked.Increment(ref _nextItemId);
        item.ItemID = id;
        item.ItemIDLow = (uint)(id & 0xFFFFFFFF);
        item.ItemIDHigh = (uint)(id >> 32);
    }

    /// <summary>Paint kit, pattern and wear (and the StatTrak counter) as econ attributes, on both attribute lists the client reads.</summary>
    private void SetPaintAttributes(CEconItemView item, SkinItem skin)
    {
        if (!EnsureAttributeSetter()) return;
        foreach (var handle in new[] { item.NetworkedDynamicAttributes.Handle, item.AttributeList.Handle })
        {
            _setAttribute!.Invoke(handle, "set item texture prefab", skin.PaintIndex);
            _setAttribute.Invoke(handle, "set item texture seed", skin.Pattern);
            _setAttribute.Invoke(handle, "set item texture wear", skin.Float);
            if (skin.StatTrak)
            {
                _setAttribute.Invoke(handle, "kill eater", BitConverter.UInt32BitsToSingle((uint)skin.StatTrakCount)); // the counter is stored as raw bits
                _setAttribute.Invoke(handle, "kill eater score type", 0);
            }
        }
    }

    private bool EnsureAttributeSetter()
    {
        if (_setAttribute is not null) return true;
        if (_attributeSetterTried) return false;
        _attributeSetterTried = true;
        try
        {
            _setAttribute = new MemoryFunctionVoid<nint, string, float>(GameData.GetSignature("CAttributeList_SetOrAddAttributeValueByName"));
            return true;
        }
        catch (Exception e)
        {
            Logger.LogError("[Celtist] knife/glove skins disabled: signature CAttributeList_SetOrAddAttributeValueByName not usable ({Message}). Check gamedata/celtist.json after a CS2 update.", e.Message);
            return false;
        }
    }
}
