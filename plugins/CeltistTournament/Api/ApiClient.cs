using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Celtist.Tournament.Api;

public sealed record ApiResponse(int Status, string Body)
{
    public bool Ok => Status is >= 200 and < 300;
    public JsonElement Json() => JsonDocument.Parse(string.IsNullOrEmpty(Body) ? "{}" : Body).RootElement.Clone();
}

/// <summary>
/// Signs every request: HMAC-SHA256(key, METHOD \n pathWithQuery \n timestampMs \n nonce \n sha256hex(body)).
/// Identical to packages/shared/src/signing.ts; see docs/PLUGIN.md.
/// </summary>
public sealed class ApiClient : IDisposable
{
    private readonly HttpClient _http;
    private readonly string _serverId;
    private readonly byte[] _key;

    public ApiClient(string baseUrl, string serverId, string apiKeyHex)
    {
        _serverId = serverId;
        _key = Convert.FromHexString(apiKeyHex.Trim());
        _http = new HttpClient { BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/"), Timeout = TimeSpan.FromSeconds(40) };
    }

    public static string Sha256Hex(string body) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(body))).ToLowerInvariant();

    public static string Sign(byte[] key, string method, string pathWithQuery, long timestampMs, string nonce, string body)
    {
        var canonical = string.Join('\n', method.ToUpperInvariant(), pathWithQuery, timestampMs.ToString(), nonce, Sha256Hex(body));
        return Convert.ToHexString(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
    }

    public async Task<ApiResponse> SendAsync(HttpMethod method, string pathWithQuery, object? payload = null, CancellationToken ct = default)
    {
        var body = payload is null ? "" : JsonSerializer.Serialize(payload);
        var ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var nonce = Guid.NewGuid().ToString("N");
        using var request = new HttpRequestMessage(method, pathWithQuery.TrimStart('/'));
        if (payload is not null) request.Content = new StringContent(body, Encoding.UTF8, new MediaTypeHeaderValue("application/json"));
        request.Headers.Add("x-celtist-server", _serverId);
        request.Headers.Add("x-celtist-timestamp", ts.ToString());
        request.Headers.Add("x-celtist-nonce", nonce);
        request.Headers.Add("x-celtist-signature", Sign(_key, method.Method, "/" + pathWithQuery.TrimStart('/'), ts, nonce, body));
        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        return new ApiResponse((int)response.StatusCode, await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false));
    }

    public Task<ApiResponse> GetAsync(string path, CancellationToken ct = default) => SendAsync(HttpMethod.Get, path, null, ct);
    public Task<ApiResponse> PostAsync(string path, object payload, CancellationToken ct = default) => SendAsync(HttpMethod.Post, path, payload, ct);

    public void Dispose() => _http.Dispose();
}
