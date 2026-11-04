'use strict';

const cds = require('@sap/cds');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

let _log;
function getLogger() {
    if (!_log) _log = cds.log('bw-mcp-client');
    return _log;
}

/**
 * Calls a named RFC/BAPI through the SDADATAAI BW RFC MCP server
 * (mcp/bw-rfc-server), deployed standalone on Cloud Foundry.
 *
 * @param {string} rfcName - e.g. 'RSA1_ODSO_GET_DETAIL'
 * @param {object} importParameters
 * @param {object} [options]
 * @param {'SDADATAAI'|'SDAINTAI'} [options.system='SDADATAAI'] - allowlisted target system
 * @param {object} [options.changingParameters]
 * @param {object} [options.tableParameters]
 * @returns {Promise<object>} the RFC result
 * @throws {Error} on auth failure, connection failure, or an RFC-level error
 */
async function callBwRfc(rfcName, importParameters, options = {}) {
    const LOG = getLogger();
    const {
        system = 'SDADATAAI',
        changingParameters = {},
        tableParameters = {}
    } = options;

    const mcpUrl = process.env.BW_MCP_URL; // e.g. https://sdadataai-bw-rfc-mcp.cfapps.us10.hana.ondemand.com/mcp
    const mcpUser = process.env.BW_MCP_USER;
    const mcpPass = process.env.BW_MCP_PASS;

    if (!mcpUrl || !mcpUser || !mcpPass) {
        throw new Error('BW_MCP_URL / BW_MCP_USER / BW_MCP_PASS must be set (bind as CF env vars or a user-provided service).');
    }

    const authHeader = 'Basic ' + Buffer.from(`${mcpUser}:${mcpPass}`).toString('base64');
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: { headers: { Authorization: authHeader } }
    });

    const client = new Client({ name: 'sdadataai-cap-backend', version: '1.0.0' });

    try {
        await client.connect(transport);

        const result = await client.callTool({
            name: 'call_rfc',
            arguments: {
                system,
                rfc_name: rfcName,
                import_parameters: importParameters,
                changing_parameters: changingParameters,
                table_parameters: tableParameters
            }
        });

        if (result.isError) {
            const message = result.content?.[0]?.text || 'Unknown MCP tool error';
            LOG.error('[BW-MCP] RFC call returned an error', { rfcName, system, message });
            throw new Error(message);
        }

        return JSON.parse(result.content[0].text);
    } finally {
        await client.close();
    }
}

module.exports = { callBwRfc };
