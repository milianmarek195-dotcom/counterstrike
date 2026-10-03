using System.Text.Json;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Memory;
using CounterStrikeSharp.API.Modules.Memory.DynamicFunctions;
using CounterStrikeSharp.API.Modules.Timers;

namespace Celtist.Tournament;

public sealed partial class CeltistTournamentPlugin
{
    private sealed record SkinItem(string Team, string Slot, int WeaponDefIndex, int PaintIndex, int Pattern, float Float, bool StatTrak, int StatTrakCount, string? NameTag, string? ModelPath = null, bool Legacy = false, List<(int Slot, int Def, float Wear)>? Stickers = null, int KeychainDef = 0, int KeychainSeed = 0);

    private readonly Dictionary<ulong, List<SkinItem>> _loadouts = new();
    // switches for finding out why a skin does not show (!skindbg): each part of the weapon skin can be turned off on its own
    private bool _dbgClear = true, _dbgPaint = true, _dbgMesh = true, _dbgExtras = true;
    // the first-person model is a separate entity from the weapon: changing its mesh group made the held skin disappear, so it stays off unless tested with !skindbg vm
    private bool _dbgViewModel;
    private bool _dbgRedeploy = true;
    private readonly Dictionary<ulong, string> _redeployed = new();
    private readonly Dictionary<ulong, int> _skinTokens = new();
    private readonly Dictionary<ulong, string> _glovesApplied = new();

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
                    i.GetProperty("team").GetString() ?? "T", i.GetProperty("slot").GetString() ?? "", i.GetProperty("weaponDefIndex").GetInt32(), i.GetProperty("paintIndex").GetInt32(), i.GetProperty("pattern").GetInt32(),
                    (float)i.GetProperty("float").GetDouble(), i.GetProperty("statTrak").GetBoolean(), i.GetProperty("statTrakCount").GetInt32(),
                    i.TryGetProperty("nameTag", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null,
                    i.TryGetProperty("modelPath", out var mp) && mp.ValueKind == JsonValueKind.String ? mp.GetString() : null,
                    i.TryGetProperty("legacyModel", out var lg) && lg.ValueKind == JsonValueKind.True,
                    ParseStickers(i), i.TryGetProperty("keychain", out var kc) && kc.ValueKind == JsonValueKind.Object ? kc.GetProperty("defIndex").GetInt32() : 0,
                    i.TryGetProperty("keychain", out var kc2) && kc2.ValueKind == JsonValueKind.Object ? kc2.GetProperty("seed").GetInt32() : 0));
            if (items.Count == 0) return;
            Server.NextFrame(() => { _loadouts[steamId] = items; ApplyToHeldWeapons(steamId); ApplyGloves(steamId); });
        }
        catch (Exception e) { Logger.LogWarning("[Celtist] skin load failed for {Steam}: {Message}", steamId, e.Message); }
    }

    private static List<(int Slot, int Def, float Wear)> ParseStickers(JsonElement item)
    {
        var list = new List<(int, int, float)>();
        if (item.TryGetProperty("stickers", out var arr) && arr.ValueKind == JsonValueKind.Array)
            foreach (var s in arr.EnumerateArray())
                list.Add((s.GetProperty("slot").GetInt32(), s.GetProperty("defIndex").GetInt32(), (float)s.GetProperty("wear").GetDouble()));
        return list;
    }

    /// <summary>
    /// A weapon the game created for the player carries the stickers and charm of the player's real Steam item. The loadout
    /// decides what is on the weapon, so everything is removed first and only the loadout's own stickers and charm are set.
    /// </summary>
    private void ApplyExtras(CEconItemView econ, SkinItem item)
    {
        if (_dbgClear)
        {
            econ.NetworkedDynamicAttributes.Attributes.RemoveAll();
            econ.AttributeList.Attributes.RemoveAll();
        }
        if (!_dbgExtras) return;
        // StatTrak needs the "strange" quality and the kill counter next to the fallback value
        if (item.StatTrak) econ.EntityQuality = 9;
        if (!EnsureAttributeSetter()) return;
        // the paint also goes in as item attributes (like on knives): the kill feed and the "killed by" panel name the item from them
        if (_dbgPaint) SetPaintAttributes(econ, item);
        foreach (var handle in new[] { econ.NetworkedDynamicAttributes.Handle, econ.AttributeList.Handle })
        {
            if (item.StatTrak)
            {
                _setAttribute!.Invoke(handle, "kill eater", BitConverter.UInt32BitsToSingle((uint)item.StatTrakCount));
                _setAttribute.Invoke(handle, "kill eater score type", 0);
            }
            foreach (var (slot, def, wear) in item.Stickers ?? new())
            {
                _setAttribute!.Invoke(handle, $"sticker slot {slot} id", BitConverter.UInt32BitsToSingle((uint)def));
                _setAttribute.Invoke(handle, $"sticker slot {slot} wear", wear);
            }
            if (item.KeychainDef > 0)
            {
                _setAttribute!.Invoke(handle, "keychain slot 0 id", BitConverter.UInt32BitsToSingle((uint)item.KeychainDef));
                _setAttribute.Invoke(handle, "keychain slot 0 seed", BitConverter.UInt32BitsToSingle((uint)item.KeychainSeed));
            }
        }
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
        UpdateViewModelMask(steamId);
        RedeployActiveWeapon(steamId);
    }

    /// <summary>
    /// The first-person model is built when a weapon is drawn. A skin that arrives afterwards shows on the weapon lying on the
    /// ground but not in the hand, so the weapon in hand is put away and drawn again once after its skin was set.
    /// </summary>
    private void RedeployActiveWeapon(ulong steamId)
    {
        try
        {
            if (!_dbgRedeploy || !_loadouts.TryGetValue(steamId, out var all)) return;
            var player = Utilities.GetPlayerFromSteamId(steamId);
            var active = player?.PlayerPawn.Value?.WeaponServices?.ActiveWeapon.Value;
            if (!IsHuman(player) || !player!.PawnIsAlive || active is null || !active.IsValid || IsKnife(active.DesignerName)) return;
            var def = active.AttributeManager.Item.ItemDefinitionIndex;
            var item = ForCurrentSide(steamId, all).FirstOrDefault(i => i.WeaponDefIndex == def && i.Slot is not ("KNIFE" or "GLOVES"));
            if (item is null) return;
            var signature = $"{active.Index}:{def}:{item.PaintIndex}:{item.Pattern}";
            if (_redeployed.TryGetValue(steamId, out var last) && last == signature) return;
            _redeployed[steamId] = signature;
            player.ExecuteClientCommand("lastinv");
            AddTimer(0.25f, () => { if (player.IsValid && player.PawnIsAlive) player.ExecuteClientCommand("lastinv"); }, TimerFlags.STOP_ON_MAPCHANGE);
        }
        catch (Exception e) { Logger.LogWarning("[Celtist] weapon redeploy failed: {Message}", e.Message); }
    }

    /// <summary>
    /// CS2 keeps the old (legacy) and the new weapon mesh in one model. A finish made for the old mesh looks scrambled on the
    /// new one and the other way round, so the mesh group follows the finish: 2 = legacy, 1 = current.
    /// </summary>
    private void SetMeshMask(CBaseEntity? entity, bool legacy)
    {
        try
        {
            var node = entity?.CBodyComponent?.SceneNode;
            if (node is null) return;
            var state = node.GetSkeletonInstance().ModelState;
            var value = legacy ? 2UL : 1UL;
            if (state.MeshGroupMask != value) state.MeshGroupMask = value;
        }
        catch (Exception e) { Logger.LogWarning("[Celtist] mesh group failed: {Message}", e.Message); }
    }

    /// <summary>The first-person model of the weapon in hand needs the same mesh group as the weapon itself.</summary>
    private void UpdateViewModelMask(ulong steamId)
    {
        try
        {
            if (!_loadouts.TryGetValue(steamId, out var all)) return;
            var player = Utilities.GetPlayerFromSteamId(steamId);
            var pawn = player?.PlayerPawn.Value;
            var active = pawn?.WeaponServices?.ActiveWeapon.Value;
            if (pawn is null || active is null || !active.IsValid) return;
            var items = ForCurrentSide(steamId, all);
            var item = IsKnife(active.DesignerName)
                ? items.FirstOrDefault(i => i.Slot == "KNIFE")
                : items.FirstOrDefault(i => i.WeaponDefIndex == active.AttributeManager.Item.ItemDefinitionIndex && i.Slot is not ("KNIFE" or "GLOVES"));
            if (item is null || !_dbgMesh || !_dbgViewModel) return;
            foreach (var viewModel in Utilities.FindAllEntitiesByDesignerName<CBaseEntity>("predicted_viewmodel"))
                if (viewModel.IsValid && viewModel.OwnerEntity.Value?.Index == pawn.Index) SetMeshMask(viewModel, item.Legacy);
        }
        catch (Exception e) { Logger.LogWarning("[Celtist] view model mesh failed: {Message}", e.Message); }
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
            var item = items.FirstOrDefault(i => i.WeaponDefIndex == def && i.Slot is not ("KNIFE" or "GLOVES"));
            if (item is null)
            {
                Logger.LogInformation("[Celtist] weapon {Name} def {Def} for {Steam}: no entry on this side ({Side} items: {Count})", weapon.DesignerName, def, steamId, Utilities.GetPlayerFromSteamId(steamId)?.TeamNum, items.Count);
                return;
            }

            econ.ItemID = 16384; // marks the econ item as custom so the fallback values below are used
            econ.ItemIDLow = 16384 & 0xFFFFFFFF;
            econ.ItemIDHigh = 0;
            econ.AccountID = (uint)steamId; // the item belongs to the player, otherwise the client ignores the fallback paint
            weapon.FallbackPaintKit = item.PaintIndex;
            weapon.FallbackSeed = item.Pattern;
            weapon.FallbackWear = item.Float;
            weapon.FallbackStatTrak = item.StatTrak ? item.StatTrakCount : -1;
            ApplyExtras(econ, item);
            Utilities.SetStateChanged(weapon, "CEconEntity", "m_AttributeManager");
            if (_dbgMesh) SetMeshMask(weapon, item.Legacy);
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
        SetPaintAttributes(econ, item);
        Utilities.SetStateChanged(weapon, "CEconEntity", "m_AttributeManager");
        SetMeshMask(weapon, item.Legacy);
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
        if (!Config.AgentsEnabled) { player.PrintToChat(" Agents are disabled on this server."); return; }
        var id = player.SteamID;
        if (!_agentOptIn.Remove(id)) { _agentOptIn.Add(id); player.PrintToChat(" [Celtist] Agent on - applied now and at every spawn."); ApplyAgent(id); }
        else player.PrintToChat(" [Celtist] Agent off - your default model returns with the next spawn.");
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

    /// <summary>Paint kit, pattern and wear (and the StatTrak counter) as econ attributes, on both attribute lists the client reads.</summary>
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
