import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../lib/mcp/server.js',import.meta.url),'utf8');
const start=source.indexOf('  // The public action catalog');
const end=source.indexOf("  registerTool('p2_discover'",start);
const section=source.slice(start,end);

test('data_query routes through existing registered P1 schemas and handlers',()=>{
  assert.ok(start>=0&&end>start);
  assert.match(section,/const internalP1Actions = \[\.\.\.tools\.keys\(\)\]/);
  assert.match(section,/registerTool\('data_query'/);
  assert.match(section,/action:z\.enum\(internalP1Actions\)\.default\('data_observe'\)/);
  assert.match(section,/backend\.input\.parseAsync\(payload\)/);
  assert.match(section,/backend\.handler\(/);
  assert.match(section,/DATA_QUERY_DECLARATIVE_REQUEST_REQUIRED/);
  assert.doesNotMatch(section,/switch\s*\(|case\s+['"]/);
});
