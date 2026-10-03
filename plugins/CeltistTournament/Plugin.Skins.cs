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
    private sealed record SkinItem(string Team, string Slot, int WeaponDefIndex, int PaintIndex, int Pattern, float Float, bool StatTrak, int StatTrakCount, string? NameTag, string? ModelPath = null);

    private readonly Dictionary<ulong, List<SkinItem>> _loadouts = new();
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
                    i.TryGetProperty("modelPath", out var mp) && mp.ValueKind == JsonValueKind.String ? mp.GetString() : null));
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
            Utilities.SetStateChanged(weapon, "CEconEntity", "m_AttributeManager");
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
