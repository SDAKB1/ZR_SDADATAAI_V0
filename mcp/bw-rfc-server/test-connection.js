'use strict';

/**
 * Standalone connection test, meant to run as a one-off `cf run-task`
 * against the deployed app (same env vars, same network egress) rather
 * than through the MCP/HTTP layer -- so it works even with no-route:true.
 *
 *   cf run-task sdadataai-bw-rfc-mcp --command "node test-connection.js" --name bw-test
 *   cf logs sdadataai-bw-rfc-mcp --recent
 */

const { Client } = require('open-rfc');

async function main() {
  const ashost = process.env.SDADATAAI_SAP_ASHOST;
  const sysnr = process.env.SDADATAAI_SAP_SYSNR || '00';
  const client_ = process.env.SDADATAAI_SAP_CLIENT;
  const user = process.env.SDADATAAI_SAP_USER;
  const passwd = process.env.SDADATAAI_SAP_PASSWD;

  if (!ashost || !client_ || !user || !passwd) {
    console.error('Missing one of SDADATAAI_SAP_ASHOST / _CLIENT / _USER / _PASSWD env vars.');
    process.exit(1);
  }

  console.log(`Connecting to ${ashost} (sysnr ${sysnr}, client ${client_})...`);
  const client = new Client({ ashost, sysnr, client: client_, user, passwd, lang: 'EN' }, { timeout: 30 });

  await client.open();
  console.log('Connection opened.');

  try {
    console.log('Calling BAPI_CUBE_GETLIST...');
    const result = await client.call('BAPI_CUBE_GETLIST', {});
    const cubeListKey = Object.keys(result).find((k) => Array.isArray(result[k]));
    const cubes = cubeListKey ? result[cubeListKey] : [];
    console.log(`BAPI_CUBE_GETLIST returned ${cubes.length} rows under key "${cubeListKey}".`);
    console.log('First 5 rows:', JSON.stringify(cubes.slice(0, 5), null, 2));
  } catch (err) {
    console.error('BAPI_CUBE_GETLIST call failed:', err.message || err);
  } finally {
    await client.close();
    console.log('Connection closed.');
  }
}

main().catch((err) => {
  console.error('Test failed:', err.message || err);
  process.exit(1);
});
