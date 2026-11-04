'use strict';

/**
 * SDADATAAI BW & S/4HANA RFC bridge, exposed as a remote MCP server.
 *
 * Scope, enforced in code, not just documentation: this server only talks to
 * the "SDADATAAI" system, with connection params supplied entirely via
 * environment variables. There is no way to call an arbitrary SAP host
 * through this server, and no other system name is recognized at all.
 */

const express = require('express');
const basicAuth = require('basic-auth');
const { RFCClient } = require('@sap-rfc/node-rfc-library');
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
  return {
    ashost,
    sysnr: process.env[`${prefix}_SAP_SYSNR`] || '00',
    client: process.env[`${prefix}_SAP_CLIENT`],
    user: process.env[`${prefix}_SAP_USER`],
    passwd: process.env[`${prefix}_SAP_PASSWD`]
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
  const client = new RFCClient();
  const connection = await client.open(connectionParams);
  try {
    return await fn(connection);
  } finally {
    await connection.close();
  }
}

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
      rfc_name: z.string().describe('The RFC/BAPI name to execute, e.g. RSA1_ODSO_GET_DETAIL.'),
      import_parameters: z.record(z.any()).optional().default({})
        .describe('Import parameters for the RFC.'),
      changing_parameters: z.record(z.any()).optional().default({})
        .describe('Changing parameters for the RFC, if any.'),
      table_parameters: z.record(z.array(z.any())).optional().default({})
        .describe('Table parameters for the RFC. Mandatory output tables must still be passed as empty arrays.')
    },
    async ({ system, rfc_name, import_parameters, changing_parameters, table_parameters }) => {
      try {
        const result = await withRfcConnection(system, (connection) =>
          connection.execute(rfc_name, {
            import: import_parameters,
            changing: changing_parameters,
            table: table_parameters
          })
        );
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
        const metadata = await withRfcConnection(system, (connection) =>
          connection.getMetadata(rfc_name)
        );
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
