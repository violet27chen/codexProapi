# Codex Pro API

Exposes Codex models discovered dynamically from your account as an OpenAI-compatible API so you can use it in Cline, Cursor, or any client that supports OpenAI-style endpoints. Supports Chat Completions (/v1/chat/completions), the Responses API (/v1/responses), and image generation (/v1/images/generations) when an image model is available.

For Chinese documentation, please see README.zh-CN.md.

---

## Core Features

- Multi-Account Round-Robin & Failover: Automatically rotates through configured accounts for requests. If one account fails, the proxy immediately retries the request using the next available account.
- Independent Account Proxy: Allows configuring a separate proxy server (supporting HTTP, HTTPS, SOCKS) for each individual account. Calls to the Codex backend and token refresh operations will be routed through the bound proxy.
- Token Auto Refresh: Periodically refreshes OAuth access tokens in the background based on a configurable interval (minimum 5 minutes). Restores failed or rate-limited accounts back to the active pool once their tokens are successfully refreshed.
- Batch Account Import: Supports importing multiple accounts at once by uploading a text file (.txt) containing a list of Refresh Tokens (one per line) or directly pasting them into the batch import interface.
- Rich Interactive Dashboard: Manage accounts, configure independent proxies, monitor real-time requests, inspect detailed logs, probe model availability, and view usage statistics.
- Bilingual Interface: Full support for both English and Simplified Chinese in both the user interface and system logs.

---

## Architecture

![Codex Pro API architecture](architecture-en.png)

Clients (Cline, Cursor, etc.) call the OpenAI-compatible API; this service round-robins requests using configured Codex accounts and forwards them to the Codex backend (chatgpt.com), optionally routing through account-specific proxy servers.

---

## Screenshots

**Accounts — add Codex accounts via OAuth Login, configure independent proxies, or perform batch imports:**

![Accounts](accounts.png)

**Models — view available models, status, latencies, and quota:**

![Models](models.png)

---

## How to get started

### Option 1: Desktop app (recommended)

If you prefer not to use the command line:

1. Open GitHub Releases at https://github.com/violettoolssite/codexProapi/releases.
2. Select the latest release and download the Windows installer from Assets: Codex Pro API Setup x.x.x.exe.
   Note: The desktop app is Windows only for now.
3. Install and run. The configuration panel opens inside the app window. Closing the app stops the local service. All accounts and configuration data are stored in your local user data directory, separate from the installation folder.

---

## Client Configuration (Cline, Cursor, etc.)

Configure your client using the following settings:

| Setting | Value |
|---------|-------|
| Base URL | http://localhost:1455/v1 (must include /v1; or your custom host/port + /v1) |
| Model | Any model returned by `GET /v1/models`; choose a default in System Settings or pass a model ID in each request |
| API Key | Any value (not validated; authentication is derived from your configured accounts) |

### OpenAI request formats

Chat Completions uses `messages` at `/v1/chat/completions`; the Responses API uses text/image `input` at `/v1/responses`. Non-streaming Responses requests return a standard `response` object, and `stream: true` returns Responses events. Responses API tools / function calling are not supported yet.

```bash
# Chat Completions
curl http://localhost:1455/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"dynamically-discovered-model-id","messages":[{"role":"user","content":"Hello"}],"stream":false}'

# Responses API
curl http://localhost:1455/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"dynamically-discovered-model-id","input":"Hello","stream":false}'
```

### Steps:

1. Add accounts at http://localhost:1455/ on the Accounts page via OAuth login, manual JSON input, Batch Import, or **Log in with Local Codex** to start `codex login` and automatically import the session after success. **Import Existing Login** remains available for an already authenticated local session.
2. If needed, click Modify next to the account in the proxy column to bind a dedicated proxy (e.g. http://127.0.0.1:7890).
3. In your client (Cline, Cursor, etc.), specify the Base URL and model names as described above. Set the API Key to any string.
4. Send requests normally. The proxy handles routing, rotation, and auto-refresh behind the scenes.

---

## Proxy and Token Refresh Management

### VPN and Per-Account Proxy

If you encounter region restrictions or access denied errors, you have two options:
1. Global VPN: Ensure your system-wide VPN is active and correctly routing traffic. OpenAI's login page must also go through the VPN.
2. Per-Account Proxy: Bind a dedicated proxy URL (HTTP, HTTPS, or SOCKS) to the account directly. Both background requests and token refresh requests for that account will be securely routed through the configured proxy.

### Token Auto Refresh

Configurable under System Settings. The scheduler runs periodically in the background (minimum interval of 5 minutes).
- Successfully refreshed accounts will be automatically unmarked from the unavailable list.
- A "Refresh Now" button is available on the settings page to manually trigger a token refresh cycle for all accounts.

### Batch Import

Located on the Accounts page under the "Batch Import" button.
- Accepts raw text input or file uploads (.txt) containing one Refresh Token per line.
- The server will sequentially exchange each Refresh Token for an access token, extract account details, and save them automatically.

---

## Troubleshooting

### Region not supported or access_denied when logging in

- Ensure the login page uses the VPN: When clicking "Login with Codex", you are redirected to the OpenAI login page, which must also go through your VPN.
- Try another VPN node: Some servers may leak DNS/IP or be flagged. Try using reliable US or EU nodes.
- Use pasting auth.json: If login succeeds on another machine, retrieve its auth.json file (Windows: %USERPROFILE%\.codex\auth.json), copy the content, and paste it under Accounts -> Add account -> Paste JSON.

### Backend 400 "Missing required parameter: tool..."

If client tools or function-calling cause a 400 error, disable tools/function-calling in the client or switch to chat-only mode. The proxy automatically injects tool_choice: none when no tools are present, but some clients send custom tools formats that might trigger backend rejections.

### Request returns "fetch failed" / proxy_error

- Verify accounts: Ensure at least one account is active and verified.
- Verify connectivity: Check if the server machine can reach chatgpt.com via `curl -I https://chatgpt.com`. If it times out, bind a proxy to your accounts or enable a global VPN.

---

## Claude Messages Compatibility

`POST /v1/messages` accepts Claude Messages request format. Authenticate with `Authorization: Bearer <API_KEY>` or `x-api-key: <API_KEY>`. Responses use the OpenAI `chat.completion` or `chat.completion.chunk` format.

```bash
curl -X POST http://localhost:1455/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API_KEY>" \
  -d '{"model":"dynamically-discovered-model-id","max_tokens":1024,"system":"You are a helpful assistant.","messages":[{"role":"user","content":"Hello"}],"stream":false}'
```

---

## Image Generation

POST /v1/images/generations is available only when the upstream catalog contains an image model. It is OpenAI-compatible and powered by picture_v2 system hints.
- Image models are discovered dynamically from the upstream model catalog and account capabilities. If no image model is available, the endpoint does not guess a model and returns 503.
- Output: Returns a local proxy URL with a 30-minute browser cache.

Request Example:
```bash
curl -X POST http://localhost:1455/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{"prompt":"a cat","n":1,"size":"1024x1024"}'
```

Parameters: model, prompt, n (1-10), size, quality, output_format, background, moderation.

---

## License

MIT. For issues and suggestions, visit GitHub Issues: https://github.com/violettoolssite/codexProapi/issues.
