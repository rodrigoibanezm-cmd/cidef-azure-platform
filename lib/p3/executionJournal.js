import { createHash, randomUUID } from 'node:crypto';
import { azureQuery, getAzurePool } from '../azure-postgres.js';

let schemaReady=null;
function db(){getAzurePool();return {query:azureQuery};}
function fp(value){return createHash('sha256').update(JSON.stringify(value??null)).digest('hex');}
async function ensureSchema(sql=db()){
 if(!schemaReady)schemaReady=(async()=>{
  await sql.query(`CREATE TABLE IF NOT EXISTS p3_runs (
    run_id text PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await sql.query('ALTER TABLE p3_runs ADD COLUMN IF NOT EXISTS parent_run_id text REFERENCES p3_runs(run_id)');
  await sql.query('ALTER TABLE p3_runs ADD COLUMN IF NOT EXISTS floor text');
  await sql.query(`CREATE TABLE IF NOT EXISTS p3_events (
    event_id uuid PRIMARY KEY,
    run_id text NOT NULL REFERENCES p3_runs(run_id),
    sequence_no bigserial,
    tool_name text NOT NULL,
    status text NOT NULL,
    input_fingerprint text NOT NULL,
    output_fingerprint text,
    input_json jsonb NOT NULL,
    output_json jsonb,
    error_code text,
    duration_ms integer,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await sql.query('ALTER TABLE p3_events ADD COLUMN IF NOT EXISTS floor text');
  await sql.query('CREATE INDEX IF NOT EXISTS p3_events_run_idx ON p3_events(run_id,sequence_no)');
  await sql.query('CREATE INDEX IF NOT EXISTS p3_runs_parent_idx ON p3_runs(parent_run_id,created_at)');
 })().catch(e=>{schemaReady=null;throw e;});
 return schemaReady;
}
export async function journalP3Tool({run_id,floor,tool_name,input={},output=null,status='SUCCESS',error_code=null,duration_ms=null}){
 if(!run_id)return;
 if(!['P1','P2'].includes(floor))throw new Error('floor must be P1 or P2');
 const sql=db();await ensureSchema(sql);
 await sql.query(`INSERT INTO p3_runs(run_id,parent_run_id,floor) VALUES($1,NULL,'ROOT')
   ON CONFLICT(run_id) DO UPDATE SET updated_at=now()`,[run_id]);
 const root=await sql.query('SELECT parent_run_id,floor FROM p3_runs WHERE run_id=$1',[run_id]);
 if(root[0]?.parent_run_id!==null||root[0]?.floor!=='ROOT')throw Object.assign(new Error('RUN_IDENTITY_VIOLATION'),{code:'RUN_IDENTITY_VIOLATION',details:{run_id,actual:root[0]}});
 await sql.query(`INSERT INTO p3_events(event_id,run_id,floor,tool_name,status,input_fingerprint,output_fingerprint,input_json,output_json,error_code,duration_ms)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)`,[randomUUID(),run_id,floor,tool_name,status,fp(input),output==null?null:fp(output),JSON.stringify(input),output==null?null:JSON.stringify(output),error_code,duration_ms]);
}
export async function getP3Run(run_id){
 const sql=db();await ensureSchema(sql);
 const runs=await sql.query('SELECT run_id,parent_run_id,floor,created_at,updated_at FROM p3_runs WHERE run_id=$1',[run_id]);
 if(!runs.length)return null;
 if(runs[0].floor==='ROOT'){
   const children=await sql.query(`SELECT run_id,parent_run_id,floor,created_at,updated_at FROM p3_runs WHERE parent_run_id=$1 ORDER BY created_at,run_id`,[run_id]);
   const events=await sql.query(`SELECT e.sequence_no,e.run_id,COALESCE(e.floor,r.floor) AS floor,e.tool_name,e.status,e.input_json,e.output_json,e.error_code,e.duration_ms,e.created_at,e.output_json->'temporal_fingerprint'->>'fingerprint_id' AS temporal_fingerprint_id
     FROM p3_events e JOIN p3_runs r ON r.run_id=e.run_id
     WHERE e.run_id=$1 OR r.parent_run_id=$1 ORDER BY e.sequence_no`,[run_id]);
   return {run:runs[0],children,events};
 }
 const events=await sql.query(`SELECT sequence_no,run_id,floor,tool_name,status,input_json,output_json,error_code,duration_ms,created_at,output_json->'temporal_fingerprint'->>'fingerprint_id' AS temporal_fingerprint_id
 FROM p3_events WHERE run_id=$1 ORDER BY sequence_no`,[run_id]);
 return {run:runs[0],events};
}
export function p2EvidenceView(evidence={}){
 const {temporal_fingerprint: _llmTemporalFingerprint,...focus}=evidence??{};
 return focus;
}
// Operational evidence is strictly scoped to its producing run. Legacy child runs
// remain readable via getP3Run, but are never eligible P2 inputs.
export async function selectCurrentRunP1Evidence(sql,run_id,ids){
 return sql.query(`SELECT e.output_json
   FROM p3_events e
   WHERE e.run_id=$1 AND e.floor='P1'
     AND e.tool_name='data_observe' AND e.status='SUCCESS'
     AND e.output_json->>'evidence_id'=ANY($2::text[])
   ORDER BY e.sequence_no DESC`,[run_id,ids]);
}
export async function resolveP1EvidenceRefs(run_id,refs={}){
 if(!run_id)throw Object.assign(new Error('run_id is required to resolve P1 evidence references'),{code:'INVALID_EVIDENCE'});
 const entries=Object.entries(refs??{});
 if(!entries.length)return {};
 const ids=entries.map(([,ref])=>typeof ref==='string'?ref:ref?.evidence_id);
 if(ids.some(id=>!id))throw Object.assign(new Error('Each P2 evidence slot must reference a P1 evidence_id'),{code:'INVALID_EVIDENCE'});
 const sql=db();await ensureSchema(sql);
 const rows=await selectCurrentRunP1Evidence(sql,run_id,ids);
 const byId=new Map();
 for(const row of rows){const e=row.output_json;if(e?.evidence_id&&!byId.has(e.evidence_id))byId.set(e.evidence_id,e);}
 const resolved={};
 for(const [slot,ref] of entries){
   const id=typeof ref==='string'?ref:ref?.evidence_id;
   const evidence=byId.get(id);
   if(!evidence)throw Object.assign(new Error(`P1 evidence reference not found in run: ${id}`),{code:'INVALID_EVIDENCE',details:{slot,evidence_id:id,run_id}});
   resolved[slot]=p2EvidenceView(evidence);
 }
 return resolved;
}
