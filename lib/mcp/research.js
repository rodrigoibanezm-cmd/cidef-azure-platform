import { z } from 'zod';
import { getP3Run } from '../p3/executionJournal.js';

const text = z.string().trim().min(1);
const question = z.object({ id: text.max(64), text: text.max(1000) }).strict();
const reply = out => ({ structuredContent: out, content: [{ type: 'text', text: JSON.stringify(out) }] });
function history(trace, run_id) {
  const events = (trace?.events ?? []).filter(e => e.run_id === run_id);
  const tagged = events.filter(e => e.input_json?.research?.version === 1);
  const context = tagged[0]?.input_json.research;
  const records = tagged.map(e => ({
    sequence_no: String(e.sequence_no), step_id: e.input_json.research.step.id,
    question_ids: e.input_json.research.step.question_ids, tool: e.tool_name, status: e.status,
    result_status: e.output_json?.status, error_code: e.error_code,
    evidence_id: e.output_json?.evidence_id, execution_id: e.output_json?.lineage?.execution_id
  }));
  return { context, events, records };
}

// Reuses the registered callbacks, their Zod contracts and their existing P3 writes.
// Research context is orchestration metadata in input_json, never certified evidence.
export function registerResearchTool(server, tools, readTrace = getP3Run) {
  const allowed = [...tools.keys()].filter(name => name !== 'run_trace');
  server.registerTool('research', {
    title: 'Investigate related questions using existing P1/P2/P3 tools',
    description: 'P4 multi-step investigation coordinator. Use for several dependent hypotheses or investigative questions requiring iterative P1/P2 evidence, e.g. explaining a sales decline. Do not use for one factual count, a monthly series or a straightforward P2 calculation; call P1/P2 directly. It has no internal LLM. START with questions and period; it discovers P2. ChatGPT chooses subsequent EXECUTE steps using the existing tool contracts. Steps execute sequentially; dependent P2 steps use original evidence_id values from prior results in this run. RESUME restores the question/step index; event_ids retrieves original P3 outputs without requerying sources. Progress records attempts, not proof a question is answered. Reuse evidence, preserve coverage and limitations. Use one run_id and do not call research concurrently within that run.',
    inputSchema: {
      run_id: text.max(200), action: z.enum(['START', 'EXECUTE', 'RESUME']),
      questions: z.array(question).min(1).max(10).optional(),
      period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
      steps: z.array(z.object({
        id: text.max(64), question_ids: z.array(text.max(64)).min(1).max(10),
        purpose: text.max(400).optional(), tool: z.enum(allowed),
        arguments: z.record(z.unknown()).default({})
      }).strict()).max(4).default([]),
      event_ids: z.array(text.max(30)).max(8).default([])
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
  }, async (args, extra) => {
    let state = history(await readTrace(args.run_id), args.run_id);
    if (args.action !== 'EXECUTE' && args.steps.length) throw new Error('Steps require EXECUTE');
    if (args.action === 'START' && (!args.questions || !args.period)) throw new Error('START requires questions and period');
    if (args.questions && new Set(args.questions.map(q => q.id)).size !== args.questions.length) throw new Error('Duplicate question id');
    if (state.context && ((args.period && args.period !== state.context.period) ||
      (args.questions && JSON.stringify(args.questions) !== JSON.stringify(state.context.questions)))) throw new Error('Research context is immutable; use a new run_id');
    if (!state.context && args.action !== 'START') throw new Error('Research not found; START first');
    const context = state.context ?? { version: 1, period: args.period, questions: args.questions };
    const steps = args.action === 'START' && !state.context
      ? [{ id: '__start__', question_ids: context.questions.map(q => q.id), tool: 'p2_discover', arguments: {} }]
      : args.steps;
    if (args.action === 'EXECUTE' && !steps.length) throw new Error('EXECUTE requires steps');
    const ids = new Set(), questionIds = new Set(context.questions.map(q => q.id));
    const prepared = [];
    for (const step of steps) {
      if (ids.has(step.id) || state.records.some(r => r.step_id === step.id)) throw new Error('Step id already used; RESUME to read its result');
      ids.add(step.id);
      if (step.question_ids.some(id => !questionIds.has(id))) throw new Error('Unknown question id');
      if (step.arguments.run_id !== undefined && step.arguments.run_id !== args.run_id) throw new Error('Cross-run step rejected');
      const tool = tools.get(step.tool);
      const input = await tool.input.parseAsync({ ...step.arguments, run_id: args.run_id });
      prepared.push({ step, tool, input });
    }
    const outputs = [];
    for (const { step, tool, input } of prepared) {
      if (extra?.signal?.aborted) break;
      try {
        const research = { ...context, step: { id: step.id, question_ids: step.question_ids, purpose: step.purpose } };
        const result = await tool.handler({ ...input, research }, extra);
        if (tool.output && !result.isError) await tool.output.parseAsync(result.structuredContent);
        outputs.push({ step_id: step.id, tool: step.tool,
          status: result.isError || result.structuredContent?.error ? 'ERROR' : 'RETURNED', result: result.structuredContent ?? result });
      } catch (error) {
        outputs.push({ step_id: step.id, tool: step.tool, status: 'ERROR', error: { code: error.code ?? error.name, message: error.message } });
      }
    }
    state = history(await readTrace(args.run_id), args.run_id);
    const selected = args.event_ids.map(id => {
      const event = state.events.find(e => String(e.sequence_no) === id);
      if (!event) throw new Error('Event not found in this run: ' + id);
      return { sequence_no: id, tool: event.tool_name, status: event.status, output: event.output_json };
    });
    return reply({ authority: 'ORCHESTRATION_METADATA', run_id: args.run_id, period: context.period,
      questions: context.questions, records: state.records, outputs, selected,
      recorded: outputs.every(o => state.records.some(r => r.step_id === o.step_id)),
      pending_steps: steps.slice(outputs.length).map(s => s.id),
      trace: { tool: 'run_trace', run_id: args.run_id } });
  });
}
