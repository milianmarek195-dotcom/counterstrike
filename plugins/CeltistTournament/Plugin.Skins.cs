using System.Text.Json;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Memory;
using CounterStrikeSharp.API.Modules.Memory.DynamicFunctions;
using CounterStrikeSharp.API.Modules.Timers;

namespace Celtist.Tournament;

/// <summary>
/// Skin changer. The way weapons are written follows the established CS2 skin plugins (WeaponPaints): a unique item id per
/// weapon, the fallback paint fields plus the "set item texture prefab" attribute, stickers and charms as attributes of the
/// networked list, and the old/new weapon model selected with the "body" body group. A weapon that already exists when the
/// loadout arrives is removed and given again (RefreshWeapons), because the first-person model is only built once.
/// </summary>
public sealed partial class CeltistTournamentPlugin
{
    private sealed record StickerPart(int Slot, int Def, float Wear, float OffsetX, float OffsetY, float Rotation, float Scale);

    private sealed record SkinItem(
        string Team, string Slot, int WeaponDefIndex, int PaintIndex, int Pattern, float Float, bool StatTrak, int StatTrakCount, string? NameTag,
        string? ModelPath, bool Legacy, List<StickerPart> Stickers, int KeychainDef, int KeychainSeed, float KeychainX, float KeychainY, float KeychainZ);

    private readonly Dictionary<ulong, List<SkinItem>> _loadouts = new();
    private readonly Dictionary<ulong, int> _skinTokens = new();
    private readonly Dictionary<ulong, string> _glovesApplied = new();
    /// <summary>Weapons this plugin already wrote (entity index → item id + what was written), so a weapon is not rewritten on every trigger.</summary>
    private readonly Dictionary<uint, (ulong Id, string Signature, ulong Owner)> _stamped = new();

    // Econ attributes are set through the game's own function (located by signature, see gamedata/celtist.json).
    // The signature has to be re-checked after big CS2 updates; if it cannot be resolved, only the fallback fields are used.
    private MemoryFunctionVoid<nint, string, float>? _setAttribute;
    private bool _attributeSetterTried;
    private long _nextItemId = 65_578; // synthetic item ids, unique per map

    /// <summary>
    /// Applies the loadout once, shortly after the last trigger (spawn, team change): several triggers in a row used to run
    /// the glove/knife swap on top of each other, which garbled the first-person models.
    /// </summary>
    private void ScheduleSkins(ulong steamId, float delay)
    {
        var token = _skinTokens.GetValueOrDefault(steamId) + 1;
        _skinTokens[steamId] = token;
        AddTimer(delay, () =>
        {
            if (_skinTokens.GetValueOrDefault(steamId) != token) return;
            ApplyAgent(steamId);
            ApplyToHeldWeapons(steamId);
            ApplyGloves(steamId);
            // a knife changes its type first and only takes the finish on a second pass a moment later
            AddTimer(0.7f, () => { if (_skinTokens.GetValueOrDefault(steamId) == token) ApplyToHeldWeapons(steamId); }, TimerFlags.STOP_ON_MAPCHANGE);
        }, TimerFlags.STOP_ON_MAPCHANGE);
    }

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
            foreach (var i in json.GetProperty("items").EnumerateArray()) items.Add(ParseItem(i));
            if (items.Count == 0) return;
            Server.NextFrame(() =>
            {
                _loadouts[steamId] = items;
                ApplyGloves(steamId);
                RefreshWeapons(steamId); // the weapons of this life were created before the loadout was known
            });
        }
        catch (Exception e) { Logger.LogWarning("[Celtist] skin load failed for {Steam}: {Message}", steamId, e.Message); }
    }

    private static SkinItem ParseItem(JsonElement i)
    {
        string? Str(string name) => i.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        var stickers = new List<StickerPart>();
        if (i.TryGetProperty("stickers", out var arr) && arr.ValueKind == JsonValueKind.Array)
            foreach (var s in arr.EnumerateArray())
            {
                float F(string n, float d) => s.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.Number ? (float)v.GetDouble() : d;
                stickers.Add(new StickerPart(s.GetProperty("slot").GetInt32(), s.GetProperty("defIndex").GetInt32(), F("wear", 0), F("offsetX", 0), F("offsetY", 0), F("rotation", 0), F("scale", 1)));
            }
        int kcDef = 0, kcSeed = 0;
        float kcX = 0, kcY = 0, kcZ = 0;
        if (i.TryGetProperty("keychain", out var kc) && kc.ValueKind == JsonValueKind.Object)
        {
            kcDef = kc.GetProperty("defIndex").GetInt32();
            kcSeed = kc.GetProperty("seed").GetInt32();
            float K(string n) => kc.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.Number ? (float)v.GetDouble() : 0f;
            kcX = K("offsetX"); kcY = K("offsetY"); kcZ = K("offsetZ");
        }
        return new SkinItem(
            i.GetProperty("team").GetString() ?? "T", i.GetProperty("slot").GetString() ?? "", i.GetProperty("weaponDefIndex").GetInt32(), i.GetProperty("paintIndex").GetInt32(), i.GetProperty("pattern").GetInt32(),
            (float)i.GetProperty("float").GetDouble(), i.GetProperty("statTrak").GetBoolean(), i.GetProperty("statTrakCount").GetInt32(), Str("nameTag"),
            Str("modelPath"), i.TryGetProperty("legacyModel", out var lg) && lg.ValueKind == JsonValueKind.True, stickers, kcDef, kcSeed, kcX, kcY, kcZ);
    }

    private void ApplyToHeldWeapons(ulong steamId)
    {
        // a player without a loadout still has to lose a skin that belongs to somebody else (a picked-up weapon)
        var items = _loadouts.TryGetValue(steamId, out var own) ? own : new List<SkinItem>();
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

    // Weapons with a class name that differs from the plain designer name of the entity (the game reports the M4A1-S as a weapon_m4a1).
    private static readonly Dictionary<int, string> WeaponClassByDef = new()
    {
        [1] = "weapon_deagle", [2] = "weapon_elite", [3] = "weapon_fiveseven", [4] = "weapon_glock", [7] = "weapon_ak47", [8] = "weapon_aug", [9] = "weapon_awp",
        [10] = "weapon_famas", [11] = "weapon_g3sg1", [13] = "weapon_galilar", [14] = "weapon_m249", [16] = "weapon_m4a1", [17] = "weapon_mac10", [19] = "weapon_p90",
        [23] = "weapon_mp5sd", [24] = "weapon_ump45", [25] = "weapon_xm1014", [26] = "weapon_bizon", [27] = "weapon_mag7", [28] = "weapon_negev", [29] = "weapon_sawedoff",
        [30] = "weapon_tec9", [32] = "weapon_hkp2000", [33] = "weapon_mp7", [34] = "weapon_mp9", [35] = "weapon_nova", [36] = "weapon_p250", [38] = "weapon_scar20",
        [39] = "weapon_sg556", [40] = "weapon_ssg08", [60] = "weapon_m4a1_silencer", [61] = "weapon_usp_silencer", [63] = "weapon_cz75a", [64] = "weapon_revolver",
    };

    /// <summary>
    /// Removes the guns the loadout has a skin for and gives them again with the same ammo. Weapons created after the loadout
    /// is known get their skin while they are created (GiveNamedItem hook), which is the only moment the first-person model
    /// picks it up; weapons that were already in the hand are replaced this way.
    /// </summary>
    private void RefreshWeapons(ulong steamId)
    {
        try
        {
            if (!_loadouts.TryGetValue(steamId, out var all)) return;
            var player = Utilities.GetPlayerFromSteamId(steamId);
            if (!IsHuman(player) || !player!.PawnIsAlive) return;
            var pawn = player.PlayerPawn.Value;
            var weapons = pawn?.WeaponServices?.MyWeapons;
            if (pawn is null || weapons is null || weapons.Count == 0) return;
            var items = ForCurrentSide(steamId, all);
            var activeDef = pawn.WeaponServices?.ActiveWeapon.Value?.AttributeManager.Item.ItemDefinitionIndex;
            var give = new List<(string Name, int Def, int Clip, int Reserve)>();

            foreach (var handle in weapons)
            {
                var weapon = handle.Value;
                if (weapon is null || !weapon.IsValid || IsKnife(weapon.DesignerName)) continue;
                var def = weapon.AttributeManager.Item.ItemDefinitionIndex;
                if (!WeaponClassByDef.TryGetValue(def, out var className)) continue; // grenades, bomb, taser: nothing to skin
                if (!items.Any(i => i.WeaponDefIndex == def && i.Slot is not ("KNIFE" or "GLOVES" or "AGENT"))) continue;
                give.Add((className, def, weapon.Clip1, weapon.ReserveAmmo[0]));
                weapon.AddEntityIOEvent("Kill", weapon, null, "", 0.1f);
            }
            if (give.Count == 0) return;

            AddTimer(0.23f, () =>
            {
                if (!IsHuman(player) || !player.PawnIsAlive) return;
                foreach (var g in give)
                {
                    var created = new CBasePlayerWeapon(player.GiveNamedItem(g.Name));
                    Server.NextFrame(() =>
                    {
                        if (!created.IsValid) return;
                        created.Clip1 = g.Clip;
                        created.ReserveAmmo[0] = g.Reserve;
                    });
                }
                if (activeDef is { } d && WeaponClassByDef.TryGetValue(d, out var activeName))
                    AddTimer(0.15f, () => { if (player.IsValid && player.PawnIsAlive) player.ExecuteClientCommand($"use {activeName}"); }, TimerFlags.STOP_ON_MAPCHANGE);
            }, TimerFlags.STOP_ON_MAPCHANGE);
        }
        catch (Exception e) { Logger.LogWarning("[Celtist] weapon refresh failed: {Message}", e.Message); }
    }

    /// <summary>
    /// Bought weapons: the game creates them in GiveNamedItem. Hooking its result lets the skin be set on the weapon
    /// at the moment it exists, before it is shown to the client. This is the path that makes bought weapons skinned.
    /// </summary>
    private HookResult OnGiveNamedItemPost(DynamicHook hook)
    {
        try
        {
            if (!Config.SkinsEnabled) return HookResult.Continue;
            var services = hook.GetParam<CCSPlayer_ItemServices>(0);
            var weapon = hook.GetReturn<CBasePlayerWeapon>();
            if (services is null || weapon is null || !weapon.IsValid || weapon.DesignerName?.StartsWith("weapon_", StringComparison.Ordinal) != true) return HookResult.Continue;

            var controllerEntity = services.Pawn.Value?.Controller.Value;
            if (controllerEntity is null) return HookResult.Continue;
            var player = new CCSPlayerController(controllerEntity.Handle);
            if (IsHuman(player) && _loadouts.TryGetValue(player.SteamID, out var items)) ApplyToWeapon(weapon, player.SteamID, items);
        }
        catch (Exception e) { Logger.LogWarning("[Celtist] skin on given weapon failed: {Message}", e.Message); }
        return HookResult.Continue;
    }

    /// <summary>
    /// Every other way a weapon enters the world (map spawns, dropped weapons, round start gear): once it has spawned,
    /// find its owner (the original owner's SteamID is stored on the weapon) and apply that player's loadout.
    /// </summary>
    private void OnWeaponSpawned(CEntityInstance entity)
    {
        if (!Config.SkinsEnabled || !entity.DesignerName.StartsWith("weapon_", StringComparison.Ordinal)) return;
        var weapon = new CBasePlayerWeapon(entity.Handle);
        Server.NextWorldUpdate(() =>
        {
            try
            {
                if (!weapon.IsValid) return;
                CCSPlayerController? player = null;
                if (weapon.OriginalOwnerXuidLow > 0)
                    player = Utilities.GetPlayerFromSteamId(SteamId64Base + weapon.OriginalOwnerXuidLow);
                if (player is null)
                {
                    var ownerPawn = weapon.OwnerEntity.Value;
                    var controllerEntity = ownerPawn is null ? null : new CCSPlayerPawn(ownerPawn.Handle).Controller.Value;
                    if (controllerEntity is not null) player = new CCSPlayerController(controllerEntity.Handle);
                }
                if (!IsHuman(player)) return;
                if (_loadouts.TryGetValue(player!.SteamID, out var items)) ApplyToWeapon(weapon, player.SteamID, items);
            }
            catch (Exception e) { Logger.LogWarning("[Celtist] skin on spawned weapon failed: {Message}", e.Message); }
        });
    }

    /// <summary>A SteamID64 is this base plus the 32-bit account id the game stores on weapons.</summary>
    private const ulong SteamId64Base = 76561197960265728UL;

    /// <summary>
    /// The backend delivers one entry per weapon and side (T / CT). Only the entries of the side the player is on right now
    /// apply, so a weapon can carry a different skin on each side. Unknown side (spectator): nothing applies.
    /// </summary>
    private List<SkinItem> ForCurrentSide(ulong steamId, List<SkinItem> items)
    {
        var teamNum = Utilities.GetPlayerFromSteamId(steamId)?.TeamNum;
        var side = teamNum == 2 ? "T" : teamNum == 3 ? "CT" : null;
        return side is null ? new List<SkinItem>() : items.Where(i => i.Team == side).ToList();
    }

    private static bool IsKnife(string? designerName) => designerName is not null && (designerName.Contains("knife", StringComparison.Ordinal) || designerName.Contains("bayonet", StringComparison.Ordinal));

    private static string Signature(SkinItem item) =>
        $"{item.PaintIndex}:{item.Pattern}:{item.Float}:{item.StatTrak}:{item.StatTrakCount}:{item.NameTag}:{item.Legacy}:{item.KeychainDef}:{item.KeychainSeed}:{item.KeychainX}:{item.KeychainY}:{item.KeychainZ}:" +
        string.Join(",", item.Stickers.Select(s => $"{s.Slot}/{s.Def}/{s.Wear}/{s.OffsetX}/{s.OffsetY}/{s.Rotation}/{s.Scale}"));

    /// <summary>
    /// A gun carrying somebody else's skin (picked up from the floor) is replaced by a fresh one: the first-person model and the
    /// name tag are only rebuilt when a weapon is created, so editing the weapon in the hand is not enough. The fresh weapon
    /// gets the new holder's own skin for it, or none.
    /// </summary>
    private void ReplaceForeignWeapons(ulong steamId)
    {
        try
        {
            var player = Utilities.GetPlayerFromSteamId(steamId);
            if (!IsHuman(player) || !player!.PawnIsAlive) return;
            var pawn = player.PlayerPawn.Value;
            var weapons = pawn?.WeaponServices?.MyWeapons;
            if (pawn is null || weapons is null) return;
            var activeIndex = pawn.WeaponServices?.ActiveWeapon.Value?.Index;
            var swap = new List<(string Name, int Clip, int Reserve, bool Active)>();
            foreach (var handle in weapons)
            {
                var w = handle.Value;
                if (w is null || !w.IsValid || !_stamped.TryGetValue(w.Index, out var stamp) || stamp.Owner == steamId) continue;
                if (!WeaponClassByDef.TryGetValue(w.AttributeManager.Item.ItemDefinitionIndex, out var className)) continue;
                swap.Add((className, w.Clip1, w.ReserveAmmo[0], w.Index == activeIndex));
                _stamped.Remove(w.Index);
                w.AddEntityIOEvent("Kill", w, null, "", 0.1f);
            }
            if (swap.Count == 0) return;
            Logger.LogInformation("[Celtist] {Count} weapon(s) of another player replaced for {Steam}", swap.Count, steamId);
            AddTimer(0.23f, () =>
            {
                if (!IsHuman(player) || !player.PawnIsAlive) return;
                foreach (var g in swap)
                {
                    var created = new CBasePlayerWeapon(player.GiveNamedItem(g.Name));
                    Server.NextFrame(() =>
                    {
                        if (!created.IsValid) return;
                        created.Clip1 = g.Clip;
                        created.ReserveAmmo[0] = g.Reserve;
                    });
                    if (g.Active) AddTimer(0.15f, () => { if (player.IsValid && player.PawnIsAlive) player.ExecuteClientCommand($"use {g.Name}"); }, TimerFlags.STOP_ON_MAPCHANGE);
                }
            }, TimerFlags.STOP_ON_MAPCHANGE);
        }
        catch (Exception e) { Logger.LogWarning("[Celtist] replacing foreign weapons failed: {Message}", e.Message); }
    }

    /// <summary>
    /// Skins and name tags belong to their owner: when somebody else picks the weapon up, it goes back to the plain weapon
    /// (or gets the new holder's own skin for it, which ApplyToWeapon writes afterwards).
    /// </summary>
    private void StripSkin(CBasePlayerWeapon weapon)
    {
        var econ = weapon.AttributeManager.Item;
        econ.AttributeList.Attributes.RemoveAll();
        econ.NetworkedDynamicAttributes.Attributes.RemoveAll();
        econ.EntityQuality = 0;
        econ.CustomName = string.Empty;
        econ.ItemID = 0;
        econ.ItemIDLow = 0;
        econ.ItemIDHigh = 0;
        econ.AccountID = 0;
        weapon.FallbackPaintKit = 0;
        weapon.FallbackSeed = 0;
        weapon.FallbackWear = 0f;
        weapon.FallbackStatTrak = -1;
        weapon.AcceptInput("SetBodygroup", value: "body,0");
        Utilities.SetStateChanged(weapon, "CEconEntity", "m_AttributeManager");
        Logger.LogInformation("[Celtist] skin removed from {Name} (def {Def}): it now belongs to somebody without a skin for it", weapon.DesignerName, econ.ItemDefinitionIndex);
    }

    private static float AsFloat(int value) => BitConverter.Int32BitsToSingle(value);

    private void ApplyToWeapon(CBasePlayerWeapon weapon, ulong steamId, List<SkinItem> allItems)
    {
        try
        {
            var items = ForCurrentSide(steamId, allItems);
            var econ = weapon.AttributeManager.Item;
            if (IsKnife(weapon.DesignerName))
            {
                ApplyKnife(weapon, steamId, items);
                return;
            }

            var def = econ.ItemDefinitionIndex;
            var item = items.FirstOrDefault(i => i.WeaponDefIndex == def && i.Slot is not ("KNIFE" or "GLOVES" or "AGENT"));
            if (item is null)
            {
                // this weapon carries a skin this plugin wrote (for its former owner or the other side) but the holder has none for it
                if (_stamped.Remove(weapon.Index)) StripSkin(weapon);
                return;
            }

            var signature = $"{steamId}:{Signature(item)}";
            if (_stamped.TryGetValue(weapon.Index, out var done) && done.Signature == signature && done.Id == econ.ItemID) return; // already written exactly like this

            // 1. clean slate: the stickers, charm and StatTrak of the player's real Steam item must not shine through
            econ.EntityQuality = item.StatTrak ? 9 : 0;
            econ.AttributeList.Attributes.RemoveAll();
            econ.NetworkedDynamicAttributes.Attributes.RemoveAll();

            // 2. a unique item of the player
            StampItemId(econ);
            econ.AccountID = (uint)steamId;
            econ.CustomName = item.NameTag ?? string.Empty;

            // 3. finish: fallback fields + the paint attribute
            weapon.FallbackPaintKit = item.PaintIndex;
            weapon.FallbackSeed = item.Pattern;
            weapon.FallbackWear = item.Float;
            if (EnsureAttributeSetter())
            {
                var net = econ.NetworkedDynamicAttributes.Handle;
                _setAttribute!.Invoke(net, "set item texture prefab", item.PaintIndex);
                if (item.StatTrak)
                {
                    foreach (var handle in new[] { net, econ.AttributeList.Handle })
                    {
                        _setAttribute.Invoke(handle, "kill eater", AsFloat(item.StatTrakCount));
                        _setAttribute.Invoke(handle, "kill eater score type", 0);
                    }
                }
                foreach (var s in item.Stickers)
                {
                    _setAttribute.Invoke(net, $"sticker slot {s.Slot} id", AsFloat(s.Def));
                    if (s.OffsetX != 0 || s.OffsetY != 0) _setAttribute.Invoke(net, $"sticker slot {s.Slot} schema", 0);
                    _setAttribute.Invoke(net, $"sticker slot {s.Slot} offset x", s.OffsetX);
                    _setAttribute.Invoke(net, $"sticker slot {s.Slot} offset y", s.OffsetY);
                    _setAttribute.Invoke(net, $"sticker slot {s.Slot} wear", s.Wear);
                    _setAttribute.Invoke(net, $"sticker slot {s.Slot} scale", s.Scale);
                    _setAttribute.Invoke(net, $"sticker slot {s.Slot} rotation", s.Rotation);
                }
                if (item.KeychainDef > 0)
                {
                    _setAttribute.Invoke(net, "keychain slot 0 id", AsFloat(item.KeychainDef));
                    _setAttribute.Invoke(net, "keychain slot 0 offset x", item.KeychainX);
                    _setAttribute.Invoke(net, "keychain slot 0 offset y", item.KeychainY);
                    _setAttribute.Invoke(net, "keychain slot 0 offset z", item.KeychainZ);
                    _setAttribute.Invoke(net, "keychain slot 0 seed", AsFloat(item.KeychainSeed));
                }
            }

            // 4. a finish made for the old weapon model needs the old model: the "body" body group selects it
            weapon.AcceptInput("SetBodygroup", value: $"body,{(item.Legacy ? 1 : 0)}");

            Utilities.SetStateChanged(weapon, "CEconEntity", "m_AttributeManager"); // the name tag is part of the networked item
            _stamped[weapon.Index] = (econ.ItemID, signature, steamId);
            Logger.LogInformation("[Celtist] weapon {Name} def {Def} for {Steam}: paint {Paint}, seed {Seed}, wear {Wear}", weapon.DesignerName, def, steamId, item.PaintIndex, item.Pattern, item.Float);
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
        // the client also reads the networked fallback fields of the weapon, so they are set next to the attributes
        weapon.FallbackPaintKit = item.PaintIndex;
        weapon.FallbackSeed = item.Pattern;
        weapon.FallbackWear = item.Float;
        weapon.FallbackStatTrak = item.StatTrak ? item.StatTrakCount : -1;
        econ.CustomName = item.NameTag ?? string.Empty;
        SetPaintAttributes(econ, item);
        Utilities.SetStateChanged(weapon, "CEconEntity", "m_AttributeManager");
        weapon.AcceptInput("SetBodygroup", value: $"body,{(item.Legacy ? 1 : 0)}");
        Logger.LogInformation("[Celtist] knife for {Steam}: def {Def}, paint {Paint}, pattern {Seed}, float {Float}", steamId, item.WeaponDefIndex, item.PaintIndex, item.Pattern, item.Float);
    }

    // ───────────── agents (player models) ─────────────

    private readonly List<string> _agentModels = new();

    /// <summary>Loads the agent model list from the backend; the models are precached on the next map start.</summary>
    private async Task LoadAgentModelsAsync()
    {
        if (!Config.SkinsEnabled || _api is null) return;
        try
        {
            var response = await _api.GetAsync("/server/v1/agent-models").ConfigureAwait(false);
            if (!response.Ok) return;
            var models = response.Json().GetProperty("models").EnumerateArray().Select(m => m.GetString()).Where(m => !string.IsNullOrEmpty(m)).Cast<string>().ToList();
            Server.NextFrame(() => { _agentModels.Clear(); _agentModels.AddRange(models); Logger.LogInformation("[Celtist] {Count} agent models known", models.Count); });
        }
        catch (Exception e) { Logger.LogWarning("[Celtist] agent list failed: {Message}", e.Message); }
    }

    private readonly HashSet<ulong> _agentOptIn = new();

    /// <summary>!agent: every player switches their own agent on or off (off = default model from the next spawn).</summary>
    private void OnAgentCommand(CCSPlayerController? player, CommandInfo info)
    {
        if (player is null || !player.IsValid) return;
        if (!Config.AgentsEnabled) { player.PrintToChat(" Agents are disabled on this server."); return; }
        var id = player.SteamID;
        if (!_agentOptIn.Remove(id)) { _agentOptIn.Add(id); player.PrintToChat(" [Celtist] Agent on - applied now and at every spawn."); ApplyAgent(id); }
        else player.PrintToChat(" [Celtist] Agent off - your default model returns with the next spawn.");
    }

    private void ApplyAgent(ulong steamId)
    {
        if (!Config.AgentsEnabled || !_agentOptIn.Contains(steamId)) return;
        if (!_loadouts.TryGetValue(steamId, out var allItems)) return;
        var item = ForCurrentSide(steamId, allItems).FirstOrDefault(i => i.Slot == "AGENT" && !string.IsNullOrEmpty(i.ModelPath));
        var player = Utilities.GetPlayerFromSteamId(steamId);
        if (item is null || !IsHuman(player) || !player!.PawnIsAlive) return;
        var pawn = player.PlayerPawn.Value;
        if (pawn is null || !pawn.IsValid) return;
        try
        {
            Server.NextFrame(() =>
            {
                if (!pawn.IsValid) return;
                pawn.SetModel(item.ModelPath!);
                // a swapped model comes up transparent unless the render colour is set again
                pawn.Render = System.Drawing.Color.FromArgb(255, 255, 255, 255);
                Utilities.SetStateChanged(pawn, "CBaseModelEntity", "m_clrRender");
            });
            Logger.LogInformation("[Celtist] agent for {Steam}: {Model}", steamId, item.ModelPath);
        }
        catch (Exception e) { Logger.LogWarning("[Celtist] could not set agent model: {Message}", e.Message); }
    }

    // ───────────── gloves ─────────────

    private void ApplyGloves(ulong steamId)
    {
        if (!_loadouts.TryGetValue(steamId, out var allItems)) return;
        var item = ForCurrentSide(steamId, allItems).FirstOrDefault(i => i.Slot == "GLOVES");
        var player = Utilities.GetPlayerFromSteamId(steamId);
        if (item is null || !IsHuman(player) || !player!.PawnIsAlive) return;
        var pawn = player.PlayerPawn.Value;
        if (pawn is null || !pawn.IsValid) return;

        var key = $"{pawn.Index}:{item.WeaponDefIndex}:{item.PaintIndex}:{item.Pattern}";
        if (_glovesApplied.TryGetValue(steamId, out var done) && done == key) return; // already wearing exactly these
        _glovesApplied[steamId] = key;

        Logger.LogInformation("[Celtist] gloves for {Steam}: def {Def}, paint {Paint}", steamId, item.WeaponDefIndex, item.PaintIndex);
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
                Logger.LogInformation("[Celtist] gloves set: def {Def}, paint {Paint}, seed {Seed}, wear {Wear}", item.WeaponDefIndex, item.PaintIndex, item.Pattern, item.Float);

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

    private void SetPaintAttributes(CEconItemView item, SkinItem skin)
    {
        if (!EnsureAttributeSetter()) { Logger.LogWarning("[Celtist] paint attributes skipped: attribute function unavailable"); return; }
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
