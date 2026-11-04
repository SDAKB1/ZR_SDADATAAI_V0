# SDADATAAI Platform — v0.0.1

SAP CAP-based BW Migration platform with an integrated Brain AI system
powered by LangChain and LangGraph.

This repo is a scoped-down sibling of `ZR_SDAINTAI_V01` / `SDAINTAI`,
carrying only the **BW migration cockpit** and the backend/MCP
capabilities relevant to it. It does not carry SDAINTAI's PI/PO,
MuleSoft, or Kara HR (RAP dev) content.

## ZR_SDADATAAI_V0 — scope of this repo

File or Folder | Purpose
---------|----------
`app/aiconx/webapp/sdadataai_bw_cockpit.html` | The BW migration cockpit UI (self-contained, no local JS/CSS deps)
`mcp/bw-rfc-server/` | Standalone MCP server for SAP BW/S4HANA RFC calls (SDADATAAI active, SDAINTAI reserved) — ported from SDAINTAI's `mcp/pipo-rfc-server`
`srv/utils/bwMcpClient.js` | CAP-side helper to call `mcp/bw-rfc-server` — ported from `pipoMcpClient.js`
`srv/brain-service.cds/.js` | Brain AI — self-learning event capture/insight engine (generic mechanism kept; the original SDAINTAI seed knowledge was PI/PO-specific and was emptied out, not guessed-replaced — see comments in `srv/brain-service.js`)
`srv/document-service.cds/.js` | Document parsing (Claude) feeding the Brain's vector store — generic, already BW-aware (`sourceContext` example: `bw_bdc_source_system`)
`db/` | `brain-schema.cds`, `documents-schema.cds`
`mtar/` | Pre-built `.mtar` deployment archives

**Deliberately NOT carried over from SDAINTAI**, because it's PI/PO,
MuleSoft, or Kara-HR-specific rather than BW:
- `app/aiconx/webapp/btp_*` (the BTP/PI-PO cockpit)
- `srv/aiconx-service.cds/.js` + `db/aiconx-schema.cds` (`importBtpAssets`, Mule2BTP mock data)
- `srv/rap-dev-orchestrator-service.cds/.js` + `db/rap-dev-schema.cds` + `mcp/adt-mcp-server` (Kara HR RAP dev orchestration)
- `mcp/pipo-rfc-server` (replaced by `mcp/bw-rfc-server`)
- `db/sql/sdaintai_pattern_vector_setup.sql` (PI/PO & MuleSoft pattern-vector DDL)
- `docs/SAD-Solution-Architecture.*`, `docs/TDD-Technical-Design.*`, `docs/MCP on CF SDA.md` (written around the PI/PO+MuleSoft+Boomi+Informatica business scope — not reused here to avoid carrying that narrative into a BW-scoped repo)

**Known residual limitation, flagged rather than silently fixed:**
`srv/brain-service.js`'s Migration Advisor pipeline (`classifyObjectNode`
→ `scoreComplexityNode` → `recommendToolNode` → ...) still takes
PI/PO-shaped inputs (`adapterType: idoc|soap|rest|...`, `isBpmProcess`,
`hasZFields`, `isEdiBased`) — those describe an *integration interface*,
not a BW object. Only the seed *data* (`MIGRATION_KNOWLEDGE`, `BAPI_MAP`,
`HUB_PACKAGE_MAP`, the `isKnowledge` array) was emptied out per an
explicit scoping decision; redesigning the action's input schema around
real BW object attributes (InfoProvider type, data flow depth, ABAP
routine count, etc.) is new design work, not a straight port, and is
still open.

## Developer workflow: one branch + one local Docker preview per developer

Same pattern as `ZR_SDAINTAI_V01`: each developer works on their own
branch and previews their own changes in their own local Docker
container — nobody's build or `cf` deploy touches anyone else's work or
the shared production route.

1. Clone the repo and create your own branch:
   ```bash
   git clone https://github.com/SDAKB1/ZR_SDADATAAI_V0.git
   cd ZR_SDADATAAI_V0
   git checkout -b <yourname>/<short-feature-name>
   ```
2. Make your changes under `app/aiconx/webapp/sdadataai_bw_cockpit.html`.
3. Preview locally with Docker — no CF route, no quota, fully isolated:
   ```bash
   docker compose -f docker-compose.dev.yml up --build dev1
   ```
   Open `http://localhost:8091/sdadataai_bw_cockpit.html`.

   `docker-compose.dev.yml` has one service block per developer
   (`dev1` on port 8091, `dev2` on port 8092, ...). If you're the next
   developer, copy the commented `dev3` block, give it your own
   name/port, and use that instead of `dev1`/`dev2`.
4. Commit and push your branch, then open a PR into `main` when ready:
   ```bash
   git push -u origin <yourname>/<short-feature-name>
   ```
5. Only merge to `main` — and only run a real `cf deploy` /
   `mbt build -t mtar/` — when the change is actually meant to ship.
   `mta-sdadataai.yaml` deploys the static console to
   `sdadataai.cfapps.us10.hana.ondemand.com`; `mta.yaml` deploys the full
   CAP backend + Brain AI. Neither has been deployed yet from this repo.

## BW RFC MCP Server

See `mcp/bw-rfc-server/README.md` for the full quick-start (connecting
as a remote MCP server, calling it from CAP code via
`srv/utils/bwMcpClient.js`, running it locally, or deploying/redeploying
it to Cloud Foundry).

## Brain AI System

The Brain AI system (`BrainService`) is a self-learning event capture
and analysis engine built on top of LangChain and LangGraph.

### Architecture

```
captureEvent()
    │
    ▼
LocalVectorStore          ← deterministic 128-dim embeddings (no API key needed)
    │
    ▼
LangGraph Pipeline
  [classify node] → classifies event into category (frontend_interaction | backend_call | ...)
  [insight node]  → generates structured insight (optimization | bug | pattern | warning)
    │
    ▼
BrainEvent (CDS entity)   ← stored in CAP DB
BrainInsight (CDS entity) ← stored in CAP DB
```

### Brain AI Files

| File | Role |
|---|---|
| `db/brain-schema.cds` | CDS entities: BrainEvent, BrainInsight, BrainSession, BrainConfig |
| `srv/brain-service.cds` | OData service definition with 6 actions |
| `srv/brain-service.js` | Service handler — LangGraph pipeline + all action implementations |
| `srv/ai/brainConfig.js` | Master key verification, brain on/off state (persisted to `.brain-state.json`) |
| `srv/ai/vectorStore.js` | Local cosine-similarity vector store (persisted to `.brain-vectors.json`) |

### Brain Service Actions

| Action | Description |
|---|---|
| `toggleBrain(key, enabled)` | Activate or deactivate the brain (requires master key) |
| `captureEvent(key, ...)` | Capture an event, embed it, run LangGraph analysis inline |
| `runAnalysis(key)` | Batch-process all unprocessed events and generate insights |
| `getBrainStatus(key)` | Dashboard: event count, insight count, vector count, coherence score |
| `exportBrain(key)` | Export full brain state as a base64 `.sdab` archive |
| `importBrain(key, data)` | Merge a `.sdab` archive back into the brain |

### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `BRAIN_MASTER_KEY` | `AYMAN2026` | Gate key for all Brain actions |
| `ANTHROPIC_API_KEY` | _(none)_ | Required for LangGraph LLM nodes; falls back to rule-based if absent |

### LangChain / LangGraph Packages

```json
"@langchain/anthropic": "^1.5.1",
"@langchain/core":      "^1.2.1",
"@langchain/langgraph": "^1.4.5",
"langchain":            "^1.5.2"
```

The LangGraph pipeline uses `claude-haiku-4-5-20251001` for fast, low-cost event classification and insight generation. If the Anthropic API key is not present, a deterministic rule-based classifier takes over automatically.

## Running Locally

```bash
cds watch
# Brain service available at: /odata/v4/brain/
```

## Deployment

Build from source:

```bash
mbt build -t mtar/
```

## Learn More

- [SAP CAP Documentation](https://cap.cloud.sap)
- [LangChain JS](https://js.langchain.com)
- [LangGraph JS](https://langchain-ai.github.io/langgraphjs/)
