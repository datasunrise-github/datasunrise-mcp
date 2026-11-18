# DataSunrise for Claude Code

A Claude Code plugin that connects Claude Code to a
[DataSunrise Database Security Suite](https://www.datasunrise.com) installation. Its skill downloads the DataSunrise
MCP server from your own DataSunrise, checks the connection and registers the server in Claude Code. With it, Claude
can read and operate DataSunrise: security, audit and masking rules, audit events and sessions, data discovery,
database instances, users and roles, and system status.

The MCP server itself is not in this repository. Every DataSunrise installation serves the server that matches its
version, together with its HTTPS certificate, so the server you get always fits the backend it talks to.

## What you need

- Claude Code.
- Node.js 22.18.0 or newer on this computer. Check with `node --version`.
- A DataSunrise version that includes the MCP server, reachable from this computer.
- A Personal Access Token. In the DataSunrise console, open System Settings > Access Control > Personal Access
  Tokens, add a token and copy it when it is shown. **Read** permission is enough for the read-only tools; the tools
  that change the configuration need **Write**. The token's user and permissions are what actually limit Claude.

The setup skill has been tested on Linux. It has not been tested on Windows yet; if it fails there, please report it
as a GitHub issue.

## Install

```
claude plugin marketplace add datasunrise-github/datasunrise-mcp
claude plugin install datasunrise@datasunrise
```

Keep the token out of the conversation: export it before starting Claude Code.

```
export DS_TOKEN=<token>          # PowerShell: $env:DS_TOKEN = "<token>"
claude
```

Then ask Claude to set up DataSunrise, or run `/datasunrise:setup-datasunrise-mcp https://datasunrise.example.com:11000`.
The skill asks for the tool mode (`read` or `all`) and the install folder, downloads the server, checks the
connection and registers it as `datasunrise`. Start a new session afterwards; `/mcp` should show `datasunrise` as
connected.

Run the same skill again after upgrading DataSunrise to get the matching server, or to change the URL, token or mode.

If DataSunrise uses a certificate this computer does not trust, such as the self-signed certificate of a fresh
installation, the skill shows its SHA-256 fingerprint and asks you to compare it with the one your browser shows for
the DataSunrise console. After you confirm, it trusts that certificate for the first download; the downloaded server
then trusts the certificate DataSunrise shipped with it. The URL must use a name the certificate lists: a default
certificate lists only `localhost` and `127.0.0.1`.

## Other MCP clients

In the DataSunrise console, open Configuration > MCP Connection: it downloads the same server and generates the
configuration for any MCP client. The `README.md` inside the download describes the settings.

## Network access and privacy

The skill talks only to the DataSunrise URL you give it. The MCP server talks only to that DataSunrise backend, sends
no telemetry and contacts nothing else. Tool results become part of the conversation with the model, which can
include configuration, audit records and, in `all` mode, customer data. Where that matters, use `read` mode and a
token with narrow permissions.

## Issues and changes

We publish this repository from our development repository with each DataSunrise release, and each release replaces
its contents. Please report problems and ideas as GitHub issues.

## License

This plugin is released under the [MIT license](LICENSE). DataSunrise Database Security Suite itself is covered by
its own End User License Agreement.
