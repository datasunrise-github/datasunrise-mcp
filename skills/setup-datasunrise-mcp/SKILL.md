---
name: setup-datasunrise-mcp
description: Install or update the DataSunrise MCP server in Claude Code. Downloads the server from the user's DataSunrise installation through its API, checks the connection and registers it. Use when the user wants to connect Claude Code to DataSunrise, set up or update the DataSunrise MCP server, or change its URL, token or tool mode.
argument-hint: "[DataSunrise URL]"
---

# Set up the DataSunrise MCP server

The MCP server is not shipped with this plugin. Each DataSunrise installation serves the server that matches its
own version, together with its HTTPS certificate. `scripts/install.mjs` downloads it through the DataSunrise API,
unpacks it, runs its connection check and registers it with `claude mcp add-json`.

## 1. Check Node.js

Run `node --version`. Node.js 22.18.0 or newer is required. If it is missing or older, stop and ask the user to
install it; do not install it yourself.

## 2. Collect the settings

Ask the user for anything not given in `$ARGUMENTS` or earlier in the conversation:

- **DataSunrise URL**: the address of the DataSunrise console as seen from this computer, for example
  `https://datasunrise.example.com:11000`. Without `/api` and without a path after the port. It must be HTTPS:
  DataSunrise accepts access tokens only over HTTPS. In a cluster behind a
  load balancer without sticky sessions, use the address of one node.
- **Tool mode**: `read` (default) offers only the tools that read; `all` also offers the tools that change the
  DataSunrise configuration and that read customer data. Suggest `read` unless the user asks for changes.
- **Install folder**: default `~/datasunrise-mcp`. The server runs from there, so it must stay.
- **Scope**: `user` (default, every project), `local` or `project`.

## 3. Get the access token without exposing it

The script reads the token only from the `DS_TOKEN` environment variable. The user issues it in the DataSunrise
console under **System Settings > Access Control > Personal Access Tokens**: **Read** permission is enough for
`read` mode, `all` mode needs **Write**.

Check whether the variable is already set without printing it:

```bash
node -e "console.log(process.env.DS_TOKEN ? 'DS_TOKEN is set' : 'DS_TOKEN is not set')"
```

If it is not set, tell the user that the safest way is to exit Claude Code, export the token in their shell
(`export DS_TOKEN=...`, or `$env:DS_TOKEN = "..."` in PowerShell) and start Claude Code again, then rerun this skill.
Only if the user explicitly prefers to paste the token into the conversation, use it inline as
`DS_TOKEN='<token>' node ...` and tell them that it then stays in the conversation history. Never echo the token,
never write it to a file and never ask the user to run a command with `!` that prints it.

The token always ends up in the Claude Code MCP configuration, because the server needs it to run. Revoking it in
the console cuts the access.

## 4. Run the installer

```bash
node "${CLAUDE_SKILL_DIR}/scripts/install.mjs" --url "<DataSunrise URL>" --mode read --dir "<install folder>" --scope user
```

The installer replaces the files in the install folder and an existing registration with the same name, so the same
command updates the server after a DataSunrise upgrade.

## 5. If the certificate is not trusted

A fresh DataSunrise uses a self-signed certificate, so the first run often stops with
`TLS certificate ... could not be verified`. Only the download needs extra trust: the downloaded server trusts the
certificate DataSunrise ships with it. Do not disable TLS verification in any other way.

1. Show the certificate DataSunrise presents (no token needed):

   ```bash
   node "${CLAUDE_SKILL_DIR}/scripts/install.mjs" --url "<DataSunrise URL>" --show-certificate
   ```

2. Show the user the subject, names and SHA-256 fingerprint. Ask them to compare the fingerprint with the one their
   browser shows for the DataSunrise console (the padlock in the address bar, certificate details, SHA-256), or
   with one their administrator gives them. Continue only after the user confirms that it matches; never confirm it
   yourself.
3. Rerun the installer with `--trust-fingerprint "<confirmed fingerprint>"`. It refuses to download if the certificate
   changed in between.

If the user has the CA certificate that issued the DataSunrise certificate as a PEM file, `--ca-file "<path>"` works
instead of the fingerprint.

If the error says the certificate `is not issued for` the host, the URL uses a name or address the certificate does
not list (`--show-certificate` prints the names; a default certificate lists only `localhost` and `127.0.0.1`). The
MCP server checks the name too, so trusting the certificate does not help. Ask the user for a URL with a listed name,
or to give DataSunrise a certificate for the name they use.

## 6. Handle other errors

- `DataSunrise refused access` or `permission_denied`: the token is wrong, expired, revoked or lacks permissions.
- `answered by another DataSunrise node`: the URL points to a load balancer; ask for the address of one node.
- `could not run claude`: register manually. Show the user the `claude mcp add-json` command from
  `README.md` in the install folder with `YOUR_DATASUNRISE_ACCESS_TOKEN` as a placeholder and let them run it in
  their own terminal.
- `The MCP release files are not installed or incomplete`: the DataSunrise installation has no MCP server files;
  this needs a DataSunrise version that includes MCP.

## 7. Finish

Tell the user to start a new Claude Code session: MCP servers are loaded when a session starts. In the new session
`/mcp` shows `datasunrise` as connected.
