using System.Collections.Concurrent;
using System.Text.Json;
using Celtist.Tournament.Api;
using Celtist.Tournament.Match;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Memory.DynamicFunctions;
using CounterStrikeSharp.API.Modules.Memory;
using CounterStrikeSharp.API.Core.Attributes;
using CounterStrikeSharp.API.Modules.Timers;

namespace Celtist.Tournament;

/// <summary>
/// Celtist tournament plugin: heartbeat, command long-poll, join authorisation, match flow, pause, team-damage
/// penalties, result reporting and (optional) skins. All decisions are made by the backend; the plugin enforces them.
/// </summary>
[MinimumApiVersion(300)]
public sealed partial class CeltistTournamentPlugin : BasePlugin, IPluginConfig<PluginConfig>
{
    public override string ModuleName => "CeltistTournament";
    public override string ModuleVersion => "0.1.0";
    public override string ModuleAuthor => "Celtist";
    public override string ModuleDescription => "Tournament, match control and skin integration for the Celtist platform";

    public PluginConfig Config { get; set; } = new();

    private ApiClient? _api;
    private CancellationTokenSource? _cts;
    private readonly ConcurrentQueue<Dictionary<string, object?>> _outbox = new();
    private long _seq;
    private DateTimeOffset _startedAt = DateTimeOffset.UtcNow;

    // match state (touched on the game thread; the poll loop hands work over with Server.NextFrame)
    private MatchPlan? _plan;
    private MapProgress? _map;
    private string _status = "STARTING"; // STARTING | READY | IN_USE | ERROR
    private int _seriesWinsA, _seriesWinsB;

    public void OnConfigParsed(PluginConfig config)
    {
        Config = config;
        if (string.IsNullOrWhiteSpace(config.ServerId) || string.IsNullOrWhiteSpace(config.ApiKey))
        {
            Logger.LogError("[Celtist] ServerId/ApiKey missing in the plugin config - the plugin stays inactive.");
            return;
        }
        try { _api = new ApiClient(config.ApiUrl, config.ServerId, config.ApiKey); }
        catch (Exception e) { Logger.LogError("[Celtist] Invalid API key (must be hex): {Message}", e.Message); }
    }

    public override void Load(bool hotReload)
    {
        _startedAt = DateTimeOffset.UtcNow;
        RegisterGameEvents();
        RegisterChatCommands();
        if (_api is null) return;

        _cts = new CancellationTokenSource();
        AddTimer(Math.Max(5, Config.HeartbeatSeconds), () => _ = SendHeartbeatAsync(), TimerFlags.REPEAT);
        AddTimer(2f, () => _ = FlushOutboxAsync(), TimerFlags.REPEAT);
        _ = Task.Run(() => CommandLoopAsync(_cts.Token));
        _ = SendHeartbeatAsync();
        _status = "READY";
        Logger.LogInformation("[Celtist] started, API {Url}, server {Id}", Config.ApiUrl, Config.ServerId);
    }

    public override void Unload(bool hotReload)
    {
        VirtualFunctions.GiveNamedItemFunc.Unhook(OnGiveNamedItemPost, HookMode.Post);
        _cts?.Cancel();
        _api?.Dispose();
    }

    // ───────────── backend loops ─────────────

    private async Task SendHeartbeatAsync()
    {
        if (_api is null) return;
        try
        {
            var players = 0;
            string map = "";
            var tcs = new TaskCompletionSource<bool>();
            Server.NextFrame(() =>
            {
                players = Utilities.GetPlayers().Count(p => p is { IsBot: false, IsValid: true });
                map = Server.MapName;
                tcs.SetResult(true);
            });
            await tcs.Task.ConfigureAwait(false);
            var response = await _api.PostAsync("/server/v1/heartbeat", new
            {
                status = _status,
                currentMatchId = _plan?.MatchId,
                players,
                version = ModuleVersion,
                timestampMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                health = new { map, uptimeSeconds = (int)(DateTimeOffset.UtcNow - _startedAt).TotalSeconds },
            }).ConfigureAwait(false);
            if (!response.Ok) Logger.LogWarning("[Celtist] heartbeat rejected: HTTP {Status} {Body}", response.Status, response.Body);
            else if (_plan is null && response.Json().TryGetProperty("expectedMatchId", out var expected) && expected.ValueKind == JsonValueKind.String)
                _ = RecoverMatchAsync(expected.GetString()!);
        }
        catch (Exception e) { Logger.LogWarning("[Celtist] heartbeat failed: {Message}", e.Message); }
    }

    /// <summary>Long-poll: the API holds the request open until a command is pending (max 25 s).</summary>
    private async Task CommandLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var response = await _api!.GetAsync($"/server/v1/commands?wait={Math.Clamp(Config.CommandWaitSeconds, 0, 25)}", ct).ConfigureAwait(false);
                if (!response.Ok) { await Task.Delay(3000, ct).ConfigureAwait(false); continue; }
                foreach (var command in response.Json().GetProperty("commands").EnumerateArray())
                {
                    var id = command.GetProperty("id").GetString()!;
                    var type = command.GetProperty("type").GetString()!;
                    var payload = command.GetProperty("payload").Clone();
                    var matchId = command.TryGetProperty("matchId", out var m) && m.ValueKind == JsonValueKind.String ? m.GetString() : null;
                    var done = new TaskCompletionSource<(bool ok, string? reason)>();
                    Server.NextFrame(() =>
                    {
                        try { done.SetResult(ExecuteCommand(type, matchId, payload)); }
                        catch (Exception e) { done.SetResult((false, e.Message)); }
                    });
                    var (ok, reason) = await done.Task.ConfigureAwait(false);
                    await _api.PostAsync($"/server/v1/commands/{id}/ack", ok ? new { status = "ACKED" } : new { status = "FAILED", reason = Trim(reason, 280) }, ct).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) { break; }
            catch (Exception e)
            {
                Logger.LogWarning("[Celtist] command poll failed: {Message}", e.Message);
                try { await Task.Delay(3000, ct).ConfigureAwait(false); } catch (OperationCanceledException) { break; }
            }
        }
    }

    /// <summary>Events go through an outbox: a failed delivery is retried with the same idempotency key.</summary>
    private void Emit(string type, Dictionary<string, object?>? extra = null)
    {
        var evt = new Dictionary<string, object?>
        {
            ["type"] = type,
            ["seq"] = Interlocked.Increment(ref _seq),
            ["idempotencyKey"] = $"{Config.ServerId[..Math.Min(8, Config.ServerId.Length)]}-{_startedAt.ToUnixTimeSeconds()}-{_seq}",
            ["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ["matchId"] = _plan?.MatchId,
        };
        if (extra is not null) foreach (var (k, v) in extra) evt[k] = v;
        _outbox.Enqueue(evt);
    }

    private int _flushing;
    private async Task FlushOutboxAsync()
    {
        if (_api is null || _outbox.IsEmpty || Interlocked.Exchange(ref _flushing, 1) == 1) return;
        try
        {
            var batch = new List<Dictionary<string, object?>>();
            while (batch.Count < 50 && _outbox.TryDequeue(out var e)) batch.Add(e);
            if (batch.Count == 0) return;
            var response = await _api.PostAsync("/server/v1/events", new { events = batch }).ConfigureAwait(false);
            if (!response.Ok && response.Status >= 500 || response.Status == 429)
                foreach (var e in batch) _outbox.Enqueue(e); // transient: retry later, same keys
            else if (!response.Ok) Logger.LogWarning("[Celtist] events rejected: HTTP {Status} {Body}", response.Status, response.Body);
        }
        catch (Exception e) { Logger.LogWarning("[Celtist] event flush failed: {Message}", e.Message); }
        finally { Interlocked.Exchange(ref _flushing, 0); }
    }

    private int _recovering;

    /// <summary>
    /// The backend says this server should host a match we do not know (e.g. the game server was restarted):
    /// fetch the match description and prepare it exactly like a MATCH_PREPARE command would.
    /// </summary>
    private async Task RecoverMatchAsync(string matchId)
    {
        if (_api is null || Interlocked.Exchange(ref _recovering, 1) == 1) return;
        try
        {
            var response = await _api.GetAsync($"/server/v1/matches/{matchId}/config").ConfigureAwait(false);
            if (!response.Ok) { Logger.LogWarning("[Celtist] could not recover match {Match}: HTTP {Status}", matchId, response.Status); return; }
            var payload = JsonDocument.Parse("{\"config\":" + response.Body + "}").RootElement.Clone();
            Server.NextFrame(() =>
            {
                if (_plan is not null) return;
                var (ok, reason) = ExecuteCommand("MATCH_PREPARE", matchId, payload);
                Logger.LogInformation("[Celtist] recovered match {Match}: {Result}", matchId, ok ? "ok" : reason);
            });
        }
        catch (Exception e) { Logger.LogWarning("[Celtist] match recovery failed: {Message}", e.Message); }
        finally { await Task.Delay(15000).ConfigureAwait(false); Interlocked.Exchange(ref _recovering, 0); }
    }

    private static string? Trim(string? s, int max) => s is null ? null : s.Length <= max ? s : s[..max];
}
