# SDADATAAI BW RFC MCP Server — Quick Start

If you've cloned/branched this repo, this is how to actually **call**
the deployed MCP server (or run it locally).

Ported from SDAINTAI's `mcp/pipo-rfc-server` (see the sibling
`ZR_SDAINTAI_V01` repo) — same generic RFC-call/metadata-lookup design,
just with the allowlisted systems flipped: **SDADATAAI** is the active
one here, **SDAINTAI** is the reserved slot.

## What this is, in one line

A standalone MCP server that lets Claude (or any MCP client, or
SDADATAAI's own CAP backend) call SAP RFCs/BAPIs by name on the
**SDADATAAI** system (SDAINTAI reserved for later, not yet enabled) —
e.g. BW metadata/extract RFCs needed for the BW migration cockpit.

## Option A — Connect to it as a remote MCP server (Claude Desktop / Claude Code)

Once deployed, the server is reachable at a CF route ending in `/mcp`
(confirm the exact URL with `cf app sdadataai-bw-rfc-mcp` — defaults to
`https://sdadataai-bw-rfc-mcp.cfapps.us10.hana.ondemand.com/mcp`, but CF
may have suffixed it if that route was already taken).

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
npm install            # needs SAP_NPM_REGISTRY_TOKEN set first, see below
npm start
curl http://localhost:8080/health   # should return "ok"
```

`npm install` pulls `@sap-rfc/node-rfc-library` from SDA's private npm
feed (configured in `.npmrc`, scoped to `@sap-rfc`) — set
`SAP_NPM_REGISTRY_TOKEN` in your shell before running `npm install`, or
it will 404. Ask whoever manages SDA's private npm feed for the token if
you don't already have it from another SDA project.

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
cf set-env sdadataai-bw-rfc-mcp SAP_NPM_REGISTRY_TOKEN '<token>'
cf set-env sdadataai-bw-rfc-mcp SDADATAAI_SAP_ASHOST '<host>'
cf set-env sdadataai-bw-rfc-mcp SDADATAAI_SAP_SYSNR '00'
cf set-env sdadataai-bw-rfc-mcp SDADATAAI_SAP_CLIENT '<client>'
cf set-env sdadataai-bw-rfc-mcp SDADATAAI_SAP_USER '<user>'
cf set-env sdadataai-bw-rfc-mcp SDADATAAI_SAP_PASSWD '<password>'
cf restage sdadataai-bw-rfc-mcp
```

## What this server will NOT do

It only accepts `system: "SDADATAAI"` or `system: "SDAINTAI"` — never an
arbitrary host. `SDAINTAI` is a reserved name until its own
`SDAINTAI_SAP_*` env vars are set; calling it before then returns an
explicit error rather than silently doing nothing or falling back to
SDADATAAI. There's no way around this allowlist from the client side —
it's enforced in `server.js`, not just this doc.
