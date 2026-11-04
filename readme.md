# SDADATAAI Platform — v0.0.1

SAP CAP-based BW Migration platform with an integrated Brain AI system
powered by LangChain and LangGraph.

## Project Layout

File or Folder | Purpose
---------|----------
`app/aiconx/webapp/sdadataai_bw_cockpit.html` | The BW migration cockpit UI (self-contained, no local JS/CSS deps)
`mcp/bw-rfc-server/` | Standalone MCP server exposing SAP BW/S4HANA RFC calls
`srv/utils/bwMcpClient.js` | CAP-side helper to call `mcp/bw-rfc-server`
`srv/brain-service.cds/.js` | Brain AI — self-learning event capture/insight engine
`srv/document-service.cds/.js` | Document parsing (Claude) feeding the Brain's vector store
`db/` | Domain models — `brain-schema.cds`, `documents-schema.cds`
`mtar/` | Pre-built `.mtar` deployment archives
`readme.md` | This guide

**Known open item:** the Brain's Migration Advisor pipeline
(`classifyObjectNode` → `scoreComplexityNode` → `recommendToolNode` →
...) currently takes integration-interface-shaped inputs (`adapterType`,
`isBpmProcess`, `hasZFields`) rather than real BW object attributes
(InfoProvider type, data flow depth, ABAP routine count, etc.), and its
seed knowledge arrays (`MIGRATION_KNOWLEDGE`, `BAPI_MAP`,
`HUB_PACKAGE_MAP`, `isKnowledge`) are currently empty rather than
populated with guessed data. Add real BW seed data and redesign the
input schema around real BW object attributes as that knowledge becomes
available — don't guess it.

## Developer workflow: one branch + one local Docker preview per developer

Each developer works on their own branch and previews their own
changes in their own local Docker container — nobody's build or `cf`
deploy touches anyone else's work or the shared production route.

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
