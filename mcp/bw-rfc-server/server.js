'use strict';

/**
 * SDADATAAI BW & S/4HANA RFC bridge, exposed as a remote MCP server.
 *
 * Scope, enforced in code, not just documentation: this server only talks to
 * the "SDADATAAI" system, with connection params supplied entirely via
 * environment variables. There is no way to call an arbitrary SAP host
 * through this server, and no other system name is recognized at all.
 *
 * Uses `open-rfc` (public npm, zero runtime dependencies, no SAP NW RFC SDK
 * and no private registry token needed) instead of a vendor-specific RFC
 * library. It's 0.x/beta software with no production SLA -- acceptable for
 * a short demo, but verify real calls work before relying on it further.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const basicAuth = require('basic-auth');
const { Client } = require('open-rfc');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

// --- Allowlisted system --------------------------------------------------
// Connection params come entirely from env vars. If ASHOST isn't configured,
// the system is treated as "not yet set up" and calls to it are rejected,
// rather than silently falling back to any default.

function systemFromEnv(prefix) {
  const ashost = process.env[`${prefix}_SAP_ASHOST`];
  if (!ashost) return null; // not configured yet
  // SDADATAAI_SAP_SID (e.g. "BI7") is informational only here -- open-rfc
  // rejects sysid unless it's paired with mshost (message-server routing),
  // and this is a direct ashost connection.
  return {
    ashost,
    sysnr: process.env[`${prefix}_SAP_SYSNR`] || '00',
    client: process.env[`${prefix}_SAP_CLIENT`],
    user: process.env[`${prefix}_SAP_USER`],
    passwd: process.env[`${prefix}_SAP_PASSWD`],
    lang: process.env[`${prefix}_SAP_LANG`] || 'EN'
  };
}

const SYSTEMS = {
  SDADATAAI: systemFromEnv('SDADATAAI')
};

function getSystemConnectionParams(systemName) {
  if (!(systemName in SYSTEMS)) {
    throw new Error(
      `Unknown system "${systemName}". This server only serves: ${Object.keys(SYSTEMS).join(', ')}.`
    );
  }
  const params = SYSTEMS[systemName];
  if (!params) {
    throw new Error(
      `System "${systemName}" has no connection configured yet ` +
      `(set ${systemName}_SAP_ASHOST etc. as CF env vars to enable it).`
    );
  }
  return params;
}

// --- Basic Auth, two fixed users ----------------------------------------
// Credentials come from env vars (CF: cf set-env), with the two usernames
// requested as the default so the server is usable immediately on deploy.
// NOTE: identical username/password per user is weak by design, per explicit
// request — rotate these via `cf set-env` + restage before relying on this
// for anything beyond initial wiring.

const MCP_USERS = {
  [process.env.MCP_USER_1 || 'AYMANK']: process.env.MCP_PASS_1 || 'AYMANK',
  [process.env.MCP_USER_2 || 'SAIREDDY']: process.env.MCP_PASS_2 || 'SAIREDDY'
};

function requireBasicAuth(req, res, next) {
  const credentials = basicAuth(req);
  if (!credentials || MCP_USERS[credentials.name] !== credentials.pass) {
    res.set('WWW-Authenticate', 'Basic realm="SDADATAAI BW RFC MCP"');
    return res.status(401).send('Authentication required.');
  }
  next();
}

// --- RFC execution helpers -----------------------------------------------

async function withRfcConnection(systemName, fn) {
  const connectionParams = getSystemConnectionParams(systemName);
  const client = new Client(connectionParams, { timeout: 30 });
  await client.open();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

// --- Generic catalog table reads (RFC_READ_TABLE) -------------------------
// BAPI_CUBE_GETLIST is the only dedicated "list" BAPI BW ships for any
// InfoProvider type -- there's no equivalent BAPI for ODS/ADSO/MultiProvider/
// CompositeProvider/Queries/Transformations. RFC_READ_TABLE (remote-enabled
// on effectively every SAP system) reads the underlying metadata directory
// table directly instead. Table/field names below follow SAP's standard
// "RSD + 4-char object-type code" convention for the InfoProvider family
// (RSDCUBE, RSDODSO, RSDMPRO, ...); CATALOG_TYPES entries marked `verified:
// false` are this convention applied by inference, not confirmed against a
// live system the way BAPI_CUBE_GETLIST's 217 real cubes were -- if a guess
// is wrong, RFC_READ_TABLE just errors cleanly (unknown table/field) and
// that one card falls back to demo data via the same live/error banner
// pattern already used for cubes, same as the runbook's own discovery
// approach for unknown FMs.

async function readCatalogNames(systemName, tableName, fields, options, maxRows) {
  const result = await withRfcConnection(systemName, (client) => client.call('RFC_READ_TABLE', {
    QUERY_TABLE: tableName,
    DELIMITER: '|',
    FIELDS: fields.map((f) => ({ FIELDNAME: f })),
    OPTIONS: (options || []).map((text) => ({ TEXT: text })),
    ROWCOUNT: maxRows || 1000
  }));
  const nameField = fields[0];
  return (result.DATA || [])
    .map((row) => (row.WA || '').split('|')[0].trim())
    .filter(Boolean)
    .map((name) => ({ [nameField]: name }));
}

// Same RFC_READ_TABLE mechanics as readCatalogNames, but keeps every
// requested field per row instead of only the first -- needed for actual
// fact-table data pulls (multiple key figures + dimension keys per row),
// not just a name list.
async function readFullRows(systemName, tableName, fields, options, maxRows) {
  const result = await withRfcConnection(systemName, (client) => client.call('RFC_READ_TABLE', {
    QUERY_TABLE: tableName,
    DELIMITER: '|',
    FIELDS: fields.map((f) => ({ FIELDNAME: f })),
    OPTIONS: (options || []).map((text) => ({ TEXT: text })),
    ROWCOUNT: maxRows || 100
  }));
  return (result.DATA || []).map((row) => {
    const parts = (row.WA || '').split('|');
    const obj = {};
    fields.forEach((f, i) => { obj[f] = (parts[i] || '').trim(); });
    return obj;
  });
}

// --- Hot/Cold pilot: 0D_NW_C01 -------------------------------------------
// Proof of concept for the CJX hot/cold design (see
// docs/SDADATAAI-CJX-HotCold-Data-Architecture.md): pull real row data out
// of one standard SAP demo InfoCube, archive it as Parquet, and only read
// that archive back when a CJX query actually asks for it -- the pointer
// (rowCount/pulledAt/archiveUri) is the only thing kept "hot" in memory.
//
// InfoCubes don't expose row data through a BAPI; the classic approach
// (used by BW extraction tools for decades) is reading the cube's own fact
// table directly. E = compressed/active data, F = uncompressed request
// data -- a demo cube's data is typically in E after compression, so that
// is tried first. Fields confirmed live via DD03L against BI7: 7 dimension
// foreign keys (KEY_0D_NW_C01*) + 6 key figures (D_NW_*).

const PILOT_CUBE = '0D_NW_C01';
const PILOT_TABLES = ['/BI0/E0D_NW_C01', '/BI0/F0D_NW_C01'];
const PILOT_FIELDS = [
  'KEY_0D_NW_C011', 'KEY_0D_NW_C012', 'KEY_0D_NW_C013', 'KEY_0D_NW_C014',
  'KEY_0D_NW_C015', 'KEY_0D_NW_C016', 'KEY_0D_NW_C017',
  'KEY_0D_NW_C01P', 'KEY_0D_NW_C01T', 'KEY_0D_NW_C01U',
  'D_NW_COSTV', 'D_NW_DOCUM', 'D_NW_NETV', 'D_NW_OORQT', 'D_NW_OORV', 'D_NW_QUANT'
];
const PILOT_KEY_FIGURES = ['D_NW_COSTV', 'D_NW_DOCUM', 'D_NW_NETV', 'D_NW_OORQT', 'D_NW_OORV', 'D_NW_QUANT'];
const ARCHIVE_DIR = path.join(os.tmpdir(), 'cjx-archive');
const ARCHIVE_PATH = path.join(ARCHIVE_DIR, `${PILOT_CUBE}.parquet`);

// The pointer -- the HOT part. Everything else (the Parquet bytes) is COLD
// and only ever opened inside dereferencePilotData().
let pilotPointer = null; // {cube, sourceTable, rowCount, pulledAt, archiveUri}

async function pullPilotData() {
  let rows = [];
  let sourceTable = null;
  for (const table of PILOT_TABLES) {
    rows = await readFullRows('SDADATAAI', table, PILOT_FIELDS, [], 100);
    if (rows.length) { sourceTable = table; break; }
  }
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const { parquetWriteFile } = await import('hyparquet-writer');
  parquetWriteFile({
    filename: ARCHIVE_PATH,
    columnData: PILOT_FIELDS.map((name) => ({
      name, type: 'STRING', data: rows.map((r) => r[name] || '')
    }))
  });
  pilotPointer = {
    cube: PILOT_CUBE,
    sourceTable: sourceTable || '(no rows found)',
    rowCount: rows.length,
    pulledAt: new Date().toISOString(),
    archiveUri: '/api/data/0d_nw_c01/archive'
  };
  return pilotPointer;
}

async function readPilotArchive() {
  const { asyncBufferFromFile, parquetReadObjects } = await import('hyparquet');
  const file = await asyncBufferFromFile(ARCHIVE_PATH);
  return parquetReadObjects({ file });
}

// The dereference step CJX calls: hot pointer check, cold pull only if
// missing/stale, then open the archive to answer the actual query.
async function dereferencePilotData(maxAgeMs) {
  let source = 'archive-cache';
  const isStale = !pilotPointer || (Date.now() - new Date(pilotPointer.pulledAt).getTime()) > (maxAgeMs || 10 * 60 * 1000);
  if (isStale) {
    await pullPilotData();
    source = 'cold-pull-triggered';
  }
  const rows = await readPilotArchive();
  return { rows, source, pointer: pilotPointer };
}

// --- SID resolution: business value -> real fact rows ---------------------
// Fact-table rows are keyed by DIMID (dimension surrogate), not by SID or
// business value directly -- resolving "company code 1111" to actual rows
// takes three hops, each confirmed live against BI7 (see
// docs/SDADATAAI-TDD-BW-SID-Resolution.md for the full writeup):
//   1. value -> SID, via the characteristic's SID table. The table name is
//      NOT simply /BI0/S<InfoObject> -- BW generates a shortened internal
//      name (RSDIOBJ-FIELDNM) when the display name doesn't fit the 9-char
//      ABAP field-name budget, e.g. 0D_NW_CODE -> field name D_NW_CODE ->
//      table /BI0/SD_NW_CODE.
//   2. SID -> one or more DIMIDs, via the cube's dimension table
//      (/BI0/D<cube><dim#>), since one SID can appear in many dimension
//      rows (other characteristics sharing that dimension vary).
//   3. DIMID set -> fact rows, via an IN-style OR filter on the fact table.
//
// Pinned to the two pilot characteristics (Organization/0D_NW_CODE,
// Product/0D_NW_PROD) proven live; generalizing to arbitrary characteristics
// is future work, not done here.

const PILOT_CHARACTERISTICS = {
  org: { sidTable: '/BI0/SD_NW_CODE', sidField: 'D_NW_CODE', dimTable: '/BI0/D0D_NW_C011', dimSidField: 'SID_0D_NW_CODE', factField: 'KEY_0D_NW_C011' },
  product: { sidTable: '/BI0/SD_NW_PROD', sidField: 'D_NW_PROD', dimTable: '/BI0/D0D_NW_C013', dimSidField: 'SID_0D_NW_PROD', factField: 'KEY_0D_NW_C013' }
};

// RFC_READ_TABLE's OPTIONS table is raw text concatenation, max 72 chars per
// row, with no implicit separator between rows -- so a long WHERE clause
// has to be chunked at <=72 chars per entry, not passed as one long string.
function chunkWhereClause(text, maxLen) {
  const limit = maxLen || 72;
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function resolveValueToDimIds(characteristic, value) {
  const cfg = PILOT_CHARACTERISTICS[characteristic];
  if (!cfg) throw new Error(`Unknown characteristic "${characteristic}". Known: ${Object.keys(PILOT_CHARACTERISTICS).join(', ')}.`);
  const sidRows = await readFullRows('SDADATAAI', cfg.sidTable, ['SID', cfg.sidField], [`${cfg.sidField} = '${value}'`], 5);
  if (!sidRows.length) return { cfg, value, sid: null, dimIds: [] };
  const sid = sidRows[0].SID;
  const dimRows = await readFullRows('SDADATAAI', cfg.dimTable, ['DIMID'], [`${cfg.dimSidField} = ${sid}`], 500);
  return { cfg, value, sid, dimIds: dimRows.map((r) => r.DIMID).filter(Boolean) };
}

// Resolves org + product business values to real fact rows and aggregates
// the pilot cube's key figures over the intersection -- the end-to-end
// proof that CJX can answer "total X for company code Y, product Z" with
// real numbers, not mocked ones.
async function queryPilotByBusinessValues({ org, product }) {
  const resolved = {};
  const filters = [];
  if (org) {
    resolved.org = await resolveValueToDimIds('org', org);
    if (resolved.org.dimIds.length) {
      filters.push('(' + resolved.org.dimIds.map((id) => `${PILOT_CHARACTERISTICS.org.factField} = ${id}`).join(' OR ') + ')');
    }
  }
  if (product) {
    resolved.product = await resolveValueToDimIds('product', product);
    if (resolved.product.dimIds.length) {
      filters.push('(' + resolved.product.dimIds.map((id) => `${PILOT_CHARACTERISTICS.product.factField} = ${id}`).join(' OR ') + ')');
    }
  }
  if (!filters.length) return { resolved, rows: [], sums: {}, sourceTable: null };

  const whereClause = filters.join(' AND ');
  const options = chunkWhereClause(whereClause);

  let rows = [];
  let sourceTable = null;
  for (const table of PILOT_TABLES) {
    rows = await readFullRows('SDADATAAI', table, PILOT_FIELDS, options, 2000);
    if (rows.length) { sourceTable = table; break; }
  }
  const sums = {};
  PILOT_KEY_FIGURES.forEach((kf) => {
    sums[kf] = rows.reduce((acc, r) => acc + (parseFloat(r[kf]) || 0), 0);
  });
  return { resolved, rows, sums, sourceTable };
}

const CATALOG_TYPES = {
  // Classic DataStore (ODSO) and Advanced DSO both live in RSDODSO -- there
  // is no separate ADSO table. ODSOTYPE blank = classic; non-blank (live
  // values seen: 'T', 'W') = the non-standard DSO subtypes, used here as
  // the ADSO bucket -- confirmed live against BI7, not a guess anymore.
  odso: {
    table: 'RSDODSO', fields: ['ODSOBJECT'], options: ["OBJVERS = 'A' AND ODSOTYPE = ''"], verified: true,
    note: 'Classic DataStore Object directory, confirmed live.'
  },
  adso: {
    table: 'RSDODSO', fields: ['ODSOBJECT'], options: ["OBJVERS = 'A' AND ODSOTYPE <> ''"], verified: true,
    note: 'DSO rows with a non-blank ODSOTYPE subtype code (T/W seen live) -- this classic BW system has no distinct Advanced DSO object type, so these are the closest real equivalent, not literal ADSOs.'
  },
  // MultiProvider/CompositeProvider aren't separate tables -- RSDCUBE holds
  // the whole InfoCube family (Basic/Multi/Virtual/Hybrid/Aggregation Level)
  // discriminated by CUBETYPE (B/M/V/H/A, confirmed live, sums to the exact
  // 217 BAPI_CUBE_GETLIST returns for Cubes -- meaning Cubes today already
  // includes MultiProviders etc. mixed in; left as-is per the existing
  // Cubes wiring, these two just re-slice the same table by subtype).
  multiprovider: {
    table: 'RSDCUBE', fields: ['INFOCUBE'], options: ["OBJVERS = 'A' AND CUBETYPE = 'M'"], verified: true,
    note: 'RSDCUBE where CUBETYPE = M, confirmed live (46 found).'
  },
  composite: {
    table: 'RSDCUBE', fields: ['INFOCUBE'], options: ["OBJVERS = 'A' AND CUBETYPE = 'V'"], verified: true,
    note: 'This classic BW system has no true CompositeProvider (HCPR) object type -- CUBETYPE = V (VirtualProvider) is the closest classic-BW equivalent, used as a practical proxy, confirmed live (28 found).'
  },
  queries: {
    table: 'RSZCOMPDIR', fields: ['COMPID'], options: ["OBJVERS = 'A'"], verified: true,
    note: 'BEx query component directory, confirmed live (table has no COMPTYPE field to narrow further).'
  },
  transformations: {
    table: 'RSTRAN', fields: ['TRANID'], options: ["OBJVERS = 'A'"], verified: true,
    note: 'Transformation directory, confirmed live. TRANID is a GUID, not a readable technical name -- that is real BW behavior, not a bug.'
  }
};

// --- MCP server + tools ----------------------------------------------------

function buildMcpServer() {
  const server = new McpServer({
    name: 'sdadataai-bw-rfc-bridge',
    version: '0.1.0'
  });

  server.tool(
    'call_rfc',
    'Executes a named RFC/BAPI on the SDADATAAI SAP system and returns the ' +
    'result, including nested structures/tables, directly as tool output.',
    {
      system: z.enum(['SDADATAAI']).describe('The only allowlisted system.'),
      rfc_name: z.string().describe('The RFC/BAPI name to execute, e.g. BAPI_CUBE_GETLIST.'),
      import_parameters: z.record(z.any()).optional().default({})
        .describe('Import parameters for the RFC.'),
      changing_parameters: z.record(z.any()).optional().default({})
        .describe('Changing parameters for the RFC, if any.'),
      table_parameters: z.record(z.array(z.any())).optional().default({})
        .describe('Table parameters for the RFC. Mandatory output tables must still be passed as empty arrays.')
    },
    async ({ system, rfc_name, import_parameters, changing_parameters, table_parameters }) => {
      try {
        // open-rfc's call() takes one flat parameter object keyed by ABAP
        // parameter name (import/changing/table are not separate buckets at
        // the wire level) and returns a flat result object the same way.
        const input = { ...import_parameters, ...changing_parameters, ...table_parameters };
        const result = await withRfcConnection(system, (client) => client.call(rfc_name, input));
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `RFC call failed: ${err.message || String(err)}` }]
        };
      }
    }
  );

  server.tool(
    'get_rfc_metadata',
    'Looks up the expected import/changing/table parameters for a named RFC/BAPI on the ' +
    'SDADATAAI SAP system, before calling it — use this to avoid guessing a call signature.',
    {
      system: z.enum(['SDADATAAI']),
      rfc_name: z.string()
    },
    async ({ system, rfc_name }) => {
      try {
        const metadata = await withRfcConnection(system, (client) => client.getFunctionInterface(rfc_name));
        return { content: [{ type: 'text', text: JSON.stringify(metadata) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Metadata lookup failed: ${err.message || String(err)}` }]
        };
      }
    }
  );

  return server;
}

// --- HTTP wiring (Streamable HTTP transport, CF-friendly) ------------------

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.status(200).send('ok')); // unauthenticated, for CF health checks

// --- Plain JSON REST endpoints, for the BW cockpit page in the browser -----
// Deliberately NOT behind the MCP/Basic-Auth layer below -- a browser page
// calling an MCP server directly would mean embedding Basic Auth credentials
// in client-side JS (visible in page source), which is worse than leaving
// these specific read-only, low-sensitivity endpoints (cube names/metadata,
// no customer data) open for this short demo. Revisit before any longer-lived
// or less-trusted deployment.

app.use('/api', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/api/cubes', async (req, res) => {
  try {
    const result = await withRfcConnection('SDADATAAI', (client) => client.call('BAPI_CUBE_GETLIST', {}));
    const listKey = Object.keys(result).find((k) => Array.isArray(result[k]));
    res.json({ cubes: listKey ? result[listKey] : [] });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

Object.entries(CATALOG_TYPES).forEach(([key, cfg]) => {
  app.get(`/api/${key}`, async (req, res) => {
    try {
      const rows = await readCatalogNames('SDADATAAI', cfg.table, cfg.fields, cfg.options, 1000);
      res.json({ items: rows, verified: cfg.verified, note: cfg.note });
    } catch (err) {
      res.status(500).json({ items: [], error: err.message || String(err), note: cfg.note });
    }
  });
});

// --- Hot/Cold pilot routes -------------------------------------------------

app.get('/api/data/0d_nw_c01/pull', async (req, res) => {
  try {
    res.json(await pullPilotData());
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get('/api/data/0d_nw_c01/pointer', (req, res) => {
  if (!pilotPointer) return res.status(404).json({ error: 'Not pulled yet -- call /api/data/0d_nw_c01/pull or /api/cjx/query first.' });
  res.json(pilotPointer);
});

app.get('/api/data/0d_nw_c01/archive', (req, res) => {
  if (!fs.existsSync(ARCHIVE_PATH)) return res.status(404).json({ error: 'Not pulled yet.' });
  res.type('application/octet-stream').sendFile(ARCHIVE_PATH);
});

// CJX query, pinned to the one pilot cube for this proof of concept --
// object resolution (which cube the prompt means) is the next build step
// per the design doc, not implemented here. Dereferences the hot pointer,
// cold-pulling only if missing/stale, then answers from the Parquet archive.
app.get('/api/cjx/query', async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase();
    const { rows, source, pointer } = await dereferencePilotData();
    const sums = {};
    PILOT_KEY_FIGURES.forEach((kf) => {
      sums[kf] = rows.reduce((acc, r) => acc + (parseFloat(r[kf]) || 0), 0);
    });
    const matchedFigure = PILOT_KEY_FIGURES.find((kf) => q.includes(kf.toLowerCase().replace('d_nw_', '')));
    res.json({
      cube: PILOT_CUBE,
      prompt: req.query.q || '',
      source, // 'archive-cache' = served from Parquet, no BW call; 'cold-pull-triggered' = just pulled live
      pointer,
      rowCount: rows.length,
      answer: matchedFigure ? { [matchedFigure]: sums[matchedFigure] } : sums,
      sampleRows: rows.slice(0, 5)
    });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// CJX query by real business values -- resolves org/product to SIDs/DIMIDs
// live (see queryPilotByBusinessValues above), filters the fact table, and
// returns the aggregated key figures plus what each value resolved to.
app.get('/api/cjx/resolve', async (req, res) => {
  try {
    const { org, product } = req.query;
    if (!org && !product) return res.status(400).json({ error: 'Pass ?org=<value> and/or ?product=<value>.' });
    const result = await queryPilotByBusinessValues({ org, product });
    res.json({
      cube: PILOT_CUBE,
      org: org || null,
      product: product || null,
      resolvedOrgSid: result.resolved.org ? result.resolved.org.sid : null,
      resolvedProductSid: result.resolved.product ? result.resolved.product.sid : null,
      matchedOrgDimIds: result.resolved.org ? result.resolved.org.dimIds : [],
      matchedProductDimIds: result.resolved.product ? result.resolved.product.dimIds : [],
      sourceTable: result.sourceTable,
      rowCount: result.rows.length,
      aggregates: result.sums,
      sampleRows: result.rows.slice(0, 10)
    });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.use('/mcp', requireBasicAuth);

app.post('/mcp', async (req, res) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`SDADATAAI BW RFC MCP server listening on ${port}`);
  console.log(`Configured systems: ${Object.entries(SYSTEMS).map(([k, v]) => `${k}=${v ? 'configured' : 'NOT configured'}`).join(', ')}`);
});
