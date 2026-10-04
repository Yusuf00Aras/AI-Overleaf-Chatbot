# Overleaf Chat Studio

Local chat interface and MCP gateway that lets an AI read Overleaf projects and, with explicit permission, modify them. Supports **overleaf.com** and **self-hosted Overleaf instances** with a custom base URL.

> **Experimental.** The connector uses Overleaf's private web endpoints and project socket. These interfaces are unofficial and can change at any time. The tests use mocks and local fixtures; compatibility with real instances is not proven. Test with a disposable project first. Automated access to overleaf.com may violate its terms of use.

## Requirements

- Node.js ≥ 22.21 (the server starts with `--use-env-proxy`)
- Chromium for Playwright, installed once: `npm run browser:install`
- An API key for the chat: OpenAI or your own OpenAI-compatible endpoint (kept only in the memory of the browser tab)

## Commands

Run all commands in the project folder.

| Purpose | Command |
|---|---|
| Install dependencies | `npm install` |
| Typecheck, build and all tests | `npm run check` |
| Tests only | `npm test` |
| Development (UI: http://127.0.0.1:5173) | `npm run dev` |
| Production (run `npm run build` first) | `npm start` → http://127.0.0.1:3001 |
| MCP over stdio | `npm run mcp` |

VS Code tasks: **Studio: Start development** and **Studio: Check all**.

## Using the chat studio

The interface has a navigation bar at the top with two tabs: **Chat** and **Settings**. The status chips on the right show the connection, the project selection, and the endpoint and model. All settings live in windows on the *Settings* tab; your draft and history are kept when you switch tabs.

1. *Settings* → **1 · Overleaf**: choose the instance (overleaf.com or a self-hosted base URL) and optionally a project by link or ID.
2. **Open browser**: a separate Chromium window with a temporary profile opens. Log in there. Logins from other browsers are not reused.
3. **Check connection**, optionally **Load project list**, and select a project.
4. **2 · AI endpoint & model**: choose the endpoint and model and enter the API key. **3 · Permissions**: confirm the privacy notice and set the permissions you need.
5. Write in the *Chat* tab. When **Confirm each change with a diff** is on (the default), text changes and destructive actions are only proposed. They are shown as a diff and executed only after **Apply**. Each proposal is valid once and expires after 15 minutes. When you apply it, the revision and confirmations are checked again.

### Custom AI endpoints

Besides OpenAI, you can add any OpenAI-compatible **Chat Completions** endpoint, e.g. `https://llm.example.org/api/v1`. Use the form (endpoint URL, model ID, tool calling, vision, token limits) or a **JSON import** in the VS Code format:

```json
[{
  "name": "https://llm.example.org/api/v1",
  "vendor": "customendpoint",
  "apiType": "chat-completions",
  "models": [{ "id": "model-a", "name": "Model A", "url": "https://llm.example.org/api/v1",
    "toolCalling": true, "vision": true, "maxInputTokens": 128000, "maxOutputTokens": 16000 }]
}]
```

- **Key:** An `apiKey` in the JSON (even a placeholder such as `${input:…}`) is ignored. Enter the key per endpoint on the *Settings* tab; it is kept only in memory and sent only to that endpoint.
- **Stored:** Only the endpoint definitions, without keys, are saved in the browser's `localStorage` (at most 20 endpoints with 50 models each). Removing an endpoint deletes its definition.
- **URL rules:** HTTPS (HTTP is also allowed locally for `localhost`, `127.0.0.1`, `[::1]`), no credentials, no query/fragment, no link-local addresses. The check runs in the browser and again on the server. The local server calls the endpoint and uses `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` from the environment (start flag `--use-env-proxy`). Add local endpoints such as `http://127.0.0.1:11434` to `NO_PROXY`.
- **`toolCalling`:** Only models with `"toolCalling": true` receive the Overleaf tools. Without it, the model runs as a plain chat without Overleaf access (the default is `false` on import and `true` in the form).
- **Token limits:** `maxOutputTokens` is sent as `max_completion_tokens`. For small context windows, `maxInputTokens` reduces the document limit for the AI (about 2 characters per token). Some gateways reject `max_completion_tokens`; in that case leave the field empty.
- `vision` is only displayed; images are currently not sent. `apiType` values other than `chat-completions` are rejected.
- The privacy notice names the selected endpoint and must be confirmed again after switching.

### Permissions

| Permission | Effect | Duration |
|---|---|---|
| Write | modify/create text files, folders, rename/move, upload, project settings | until the instance or project is changed |
| Create project | exactly one attempt to create, copy or import a ZIP, consumed even on failure | one message |
| Project management | rename, archive, restore | one message |
| Destructive | delete, overwrite upload, trash/permanently delete (in addition to Write or Management) | one message |
| Comments | add, reply, resolve/reopen | one message |

**Grant all permissions** sets all five permissions at once and keeps them after each message until the instance or project is changed. Per-change confirmation with a diff is separate and on by default. When several proposals are open, **Apply all** and **Discard all** are available: proposals are executed in order, failures (e.g. a revision conflict) are reported per proposal, and any destructive actions included are named on the button.

Changes are only allowed in the explicitly selected project. Text and comment changes require that the file was read beforehand, and the returned revision must be passed back unchanged. Failed changes are never retried automatically.

## Protocol support

- **ShareJS and history-OT**: reading, minimal text changes, tracked changes (`writeMode: "tracked"`), anchored comments and comment status. Every change is confirmed by re-reading. If a tracked change is not observed afterwards, the tool reports `PARTIAL_RESULT`. There is no silent fallback to untracked changes.
- **Revisions** bind project, document, protocol, OT version and content hash.
- **Legacy aliases** `read_document`, `write_document` and `compile_document` use the same document-bound connector. The browser editor path is only a fallback for adapters without a connector. It checks the project URL and the selected file in the same step as reading and writing.
- **Large documents**: from 150,000 characters, the AI does not receive the full text. It then works with `get_sections`, `get_section_content` and `write_section`. Individual tool results are limited to 400,000 characters. Omitted fields are explicitly marked.
- `validate_latex` only checks statically and does not replace compiling. `preview_edit` does not write.

## MCP gateway

External MCP clients use the same tool core. Write and management permissions are set only by the operator through environment variables; the AI cannot set them itself.

| Variable | Effect |
|---|---|
| `OVERLEAF_ALLOW_WRITES=1` | Allow writing (otherwise read-only) |
| `OVERLEAF_ALLOW_CREATE_PROJECTS=1` | Allow create, copy and import (one attempt per connection) |
| `OVERLEAF_ALLOW_MANAGE_PROJECTS=1` | Allow project management |
| `OVERLEAF_ALLOW_DESTRUCTIVE=1` | Allow destructive actions |
| `OVERLEAF_ALLOW_COMMENTS=1` | Allow comments |
| `MCP_NETWORK=1` | Enable the WebSocket and TCP gateway |
| `MCP_GATEWAY_TOKEN` | Required with `MCP_NETWORK=1`, at least 32 characters |
| `MCP_TCP_PORT` | TCP port (default 3002) |
| `PORT` | HTTP port (default 3001) |

**stdio** (example MCP client configuration):

```json
{
  "servers": {
    "overleaf-studio": {
      "type": "stdio",
      "command": "npm",
      "args": ["run", "--silent", "mcp"],
      "cwd": "/path/to/AI Overleaf Agent",
      "env": { "OVERLEAF_ALLOW_WRITES": "0" }
    }
  }
}
```

**WebSocket** `ws://127.0.0.1:3001/mcp`: one JSON-RPC message per text frame. Authentication happens at the upgrade with `Authorization: Bearer <MCP_GATEWAY_TOKEN>`.

**TCP** `127.0.0.1:3002`: NDJSON. The first line must be `{"auth":"<MCP_GATEWAY_TOKEN>"}`. If it is missing or wrong, the connection is closed (timeout 10 s).

WebSocket and TCP are custom transport adapters, not standard MCP remote endpoints. At most four concurrent gateway connections are possible. Messages are limited to 1 MiB. The gateway accepts no attachments and returns only metadata for `download_file`, no binary data.

## Security model and privacy

- The server listens only on `127.0.0.1`. Host and Origin are validated, and state-changing routes require a CSRF token. Security headers, a CSP and size limits also apply.
- API keys, cookies, chat history, document contents and attachments are neither stored nor logged. The Overleaf login exists only in the temporary Chromium context. Open change proposals are held in memory for at most 15 minutes and are discarded on reconnect.
- The chat and any document contents that were read go to the selected AI endpoint (OpenAI or your own). Attachment bytes and downloads are not sent to the model.
- Local trust boundary: other processes on the same machine can fetch the CSRF token via `/api/session`. The permission checkboxes are not authentication against local processes.

## Known limitations

- Live-tested (2026-10-03) against a self-hosted instance (ShareJS, without the review feature) and, for writing in a throwaway project only, against overleaf.com (also ShareJS): reading, writing, file management, import/copy, settings, compiling, history, and MCP over TCP, WebSocket and stdio. **Not live-tested** are history-OT (neither instance provided it), tracked changes (both rejected them), comments, and the chat with a real AI key. Private Overleaf interfaces change without notice. Please test with a throwaway project first.
- The project list covers only accessible projects. Section detection is lexical and ignores `\input`/`\include` files.
- Compiling consumes the instance's compile quota.

## License

[MIT](LICENSE)
