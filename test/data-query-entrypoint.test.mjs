import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../lib/mcp/server.js',import.meta.url),'utf8');
const start=source.indexOf("  // Single declarative entry point.");
const end=source.indexOf("  const salesFilterValue=",start);
const section=source.slice(start,end);

test('data_query delegates to the existing P1 observation handler',()=>{
  assert.ok(start>=0&&end>start);
  assert.match(section,/tools\.get\('data_observe'\)/);
  assert.match(section,/registerTool\('data_query'/);
  assert.match(section,/request:observation\.input\.shape\.request\.unwrap\(\)/);
  assert.match(section,/outputSchema:observation\.output\.shape/);
  assert.match(section,/observation\.handler\(args\)/);
  assert.doesNotMatch(section,/switch\s*\(|case\s+['"]|source\s*===|SALES:|FORUM:/);
});
