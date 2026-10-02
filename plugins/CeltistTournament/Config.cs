using System.Text.Json.Serialization;
using CounterStrikeSharp.API.Core;

namespace Celtist.Tournament;

/// <summary>Written to addons/counterstrikesharp/configs/plugins/CeltistTournament/CeltistTournament.json on first start.</summary>
public sealed class PluginConfig : BasePluginConfig
{
    /// <summary>Base URL of the Celtist API, e.g. https://api.example.com</summary>
    [JsonPropertyName("ApiUrl")] public string ApiUrl { get; set; } = "http://localhost:4000";

    /// <summary>Server id (UUID) shown in the admin panel when the server was created.</summary>
    [JsonPropertyName("ServerId")] public string ServerId { get; set; } = "";

    /// <summary>Hex API key shown ONCE when the server was created or its key rotated.</summary>
    [JsonPropertyName("ApiKey")] public string ApiKey { get; set; } = "";

    [JsonPropertyName("HeartbeatSeconds")] public int HeartbeatSeconds { get; set; } = 10;

    /// <summary>Long-poll window for commands (the API caps it at 25).</summary>
    [JsonPropertyName("CommandWaitSeconds")] public int CommandWaitSeconds { get; set; } = 25;

    /// <summary>Message shown to players the backend refuses.</summary>
    [JsonPropertyName("DenyMessage")] public string DenyMessage { get; set; } = "ACCESS DENIED - you are not assigned to this match";

    /// <summary>Skin module. Off by default: enable only after testing on your server build (see docs/SKIN_SYSTEM.md).</summary>
    [JsonPropertyName("SkinsEnabled")] public bool SkinsEnabled { get; set; } = false;
}
