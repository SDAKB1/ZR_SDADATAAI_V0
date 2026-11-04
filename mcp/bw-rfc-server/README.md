# SDADATAAI BW RFC MCP Server — Quick Start

If you've cloned/branched this repo, this is how to actually **call**
the deployed MCP server (or run it locally).

## What this is, in one line

A standalone MCP server that lets Claude (or any MCP client, or
SDADATAAI's own CAP backend) call SAP RFCs/BAPIs by name on the
**SDADATAAI** system — e.g. BW metadata/extract RFCs needed for the BW
migration cockpit.

Built on [`open-rfc`](https://github.com/marianfoo/open-rfc) — public npm,
zero runtime dependencies, no SAP NW RFC SDK, no private registry token.
It's 0.x/beta software with no production SLA, which is fine for a short
demo but worth re-checking if this becomes long-lived.

**Current deploy has no public route** (`no-route: true` in
`manifest.yml` — `lab-sda_Space`'s CF route quota is maxed at 30/30).
Use `test-connection.js` via `cf run-task` (below) to verify/use it for
now; add a real route deliberately later if the CAP backend needs to
reach it over HTTP from outside this space.

## Option A — Connect to it as a remote MCP server (Claude Desktop / Claude Code)

Needs a public route first (see above — not deployed yet). Once one
exists, the server is reachable at a CF route ending in `/mcp` (confirm
the exact URL with `cf app sdadataai-bw-rfc-mcp`).

Every request needs **HTTP Basic Auth**. Ask whoever deployed the server
for the current username/password (don't assume the placeholder
defaults in `server.js` are still in use — they're meant to be rotated).

Add it to your MCP client config, e.g. `claude_desktop_config.json` /
Claude Code's MCP settings:

```json
{
  "mcpServers": {
    "sdadataai-bw-rfc": {
      "url": "https://<your-route>.cfapps.us10.hana.ondemand.com/mcp",
      "headers": {
        "Authorization": "Basic <base64 of username:password>"
      }
    }
  }
}
```

(Generate the `Authorization` value with
`echo -n 'USERNAME:PASSWORD' | base64`.)

Once connected, two tools are available:
- **`call_rfc`** — `{ system: "SDADATAAI", rfc_name: "...", import_parameters: {...} }`
- **`get_rfc_metadata`** — `{ system: "SDADATAAI", rfc_name: "..." }` — look up an
  RFC's expected parameters before calling it blind.

## Option B — Call it from Node.js/CAP code

Use `srv/utils/bwMcpClient.js` (already in this repo):

```js
const { callBwRfc } = require('../../srv/utils/bwMcpClient');

const result = await callBwRfc('RSA1_ODSO_GET_DETAIL', {
  I_ODSOBJECT: 'ZBW_SALES_ODS'
}, {
  tableParameters: { E_FIELDS: [] }
});
```

Requires three environment variables on whatever app is calling it:

| Variable | What it is |
|---|---|
| `BW_MCP_URL` | the deployed server's `/mcp` URL |
| `BW_MCP_USER` | Basic Auth username |
| `BW_MCP_PASS` | Basic Auth password |

## Option C — Run the server itself locally (for development)

```bash
cd mcp/bw-rfc-server
cp .env.example .env   # fill in real values — never commit .env
npm install
npm start
curl http://localhost:8080/health   # should return "ok"
```

No registry token needed — `open-rfc` installs straight from public npm.

## Verifying the live connection without a public route

```bash
cf run-task sdadataai-bw-rfc-mcp --command "node test-connection.js" --name bw-test
cf logs sdadataai-bw-rfc-mcp --recent
```

`test-connection.js` opens a connection using the `SDADATAAI_SAP_*` env
vars already set on the app and calls `BAPI_CUBE_GETLIST` directly
(bypassing the MCP/HTTP layer entirely), printing the row count and
first 5 cubes to the task's log output.

## Deploying/redeploying to Cloud Foundry

```bash
cf login -a https://api.cf.us10.hana.ondemand.com   # if not already logged in
cd mcp/bw-rfc-server
cf push
```

The app starts even with `SDADATAAI_SAP_*` connection vars unset — it'll
just return a clear "not configured" error from `call_rfc`/
`get_rfc_metadata` until those are set:

```bash
cf set-env sdadataai-bw-rfc-mcp SDADATAAI_SAP_ASHOST '<host>'
cf set-env sdadataai-bw-rfc-mcp SDADATAAI_SAP_SYSNR '00'
cf set-env sdadataai-bw-rfc-mcp SDADATAAI_SAP_CLIENT '<client>'
cf set-env sdadataai-bw-rfc-mcp SDADATAAI_SAP_USER '<user>'
cf set-env sdadataai-bw-rfc-mcp SDADATAAI_SAP_PASSWD '<password>'
cf restage sdadataai-bw-rfc-mcp
```

## What this server will NOT do

It only accepts `system: "SDADATAAI"` — never an arbitrary host, and no
other system name is recognized at all. There's no way around this
allowlist from the client side — it's enforced in `server.js`, not just
this doc.
