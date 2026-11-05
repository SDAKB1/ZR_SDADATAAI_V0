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

const CATALOG_TYPES = {
  odso: {
    table: 'RSDODSO', fields: ['ODSOBJECT'], options: ["OBJVERS = 'A'"], verified: false,
    note: 'Classic DataStore Object directory -- standard convention, not yet confirmed live.'
  },
  adso: {
    table: 'RSDODSO', fields: ['ODSOBJECT'], options: ["OBJVERS = 'A'", "TYPE = 'ADSO'"], verified: false,
    note: 'Advanced DSO is built on the ODS object framework (same RSDODSO table); the TYPE filter distinguishing it from classic DSO is an unverified guess.'
  },
  multiprovider: {
    table: 'RSDMPRO', fields: ['MULTIPROV'], options: ["OBJVERS = 'A'"], verified: false,
    note: 'MultiProvider directory -- standard convention, not yet confirmed live.'
  },
  composite: {
    table: 'RSDCPRO', fields: ['COMPPROV'], options: ["OBJVERS = 'A'"], verified: false,
    note: 'CompositeProvider directory -- table/field name is a best-effort guess following the RSD+code convention, not confirmed to exist.'
  },
  queries: {
    table: 'RSZCOMPDIR', fields: ['COMPID'], options: ["OBJVERS = 'A'", "COMPTYPE = 'REP'"], verified: false,
    note: 'BEx query component directory -- standard convention, not yet confirmed live.'
  },
  transformations: {
    table: 'RSTRAN', fields: ['TRANID'], options: ["OBJVERS = 'A'"], verified: false,
    note: 'Transformation directory -- table/field name is a best-effort guess, not confirmed to exist.'
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
