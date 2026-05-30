// plan.js — Layer 1, the AI planner. Generates a ContentPlan (the SEMANTIC video
// plan) from StrategyFacts + the Node Catalog. The LLM writes ONLY semantics
// (narration lines, emotion, the outro); it never sees a selector or a timing.
// Every `actionRef` it emits is validated against the anchor table — an
// unresolved ref fails the run, so the model can't invent a node.
//
// Providers (auto-selected by which key is present in env or .env):
//   • OpenRouter (OPENROUTER_API_KEY) — dev. Falls back across free models and
//     retries; free tier is heavily rate-limited (429), so fallback matters.
//   • Anthropic  (ANTHROPIC_API_KEY)  — prod. claude-opus-4-7, structured output.
//
// Usage: node scripts/plan.js <flow> [--force]   (e.g. macd)
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/build-flow.js';

// ── minimal .env loader (no dep): KEY=VALUE lines, doesn't override real env.
(function loadEnv() {
  const p = path.resolve(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const ANTHROPIC_MODEL = 'claude-opus-4-7';
// Ordered free-model fallback for OpenRouter dev use (most capable first).
const OR_FREE_MODELS = [
  'deepseek/deepseek-v4-flash:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'arcee-ai/trinity-large-thinking:free',
  'google/gemma-4-31b-it:free',
];

function parseArgs(argv) {
  const a = { flow: null, force: false };
  for (const arg of argv) { if (arg === '--force') a.force = true; else if (!arg.startsWith('-') && !a.flow) a.flow = arg; }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const flow = args.flow || 'macd';
const log = (m) => console.log(`\x1b[35m[plan]\x1b[0m ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Structured-output schema (Anthropic). Exactly what the compiler consumes.
const OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['video', 'build', 'outro'],
  properties: {
    video: { type: 'object', additionalProperties: false, required: ['flow', 'title', 'tone'],
      properties: { flow: { type: 'string' }, title: { type: 'string' }, tone: { type: 'string' } } },
    build: { type: 'object', additionalProperties: false, required: ['voiceoverSegments'],
      properties: { voiceoverSegments: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['line', 'actionRef', 'emotion'],
        properties: { line: { type: 'string' }, actionRef: { type: 'string' }, emotion: { type: 'string' } } } } } },
    outro: { type: 'object', additionalProperties: false, required: ['voiceover'],
      properties: { voiceover: { type: 'string' } } },
  },
};

const SYSTEM = `You are a scriptwriter for short-form vertical (9:16) trading-education reels that show a strategy being BUILT node-by-node in a visual editor, then revealed on a chart.

You write ONLY narration. You never describe UI, clicks, or timing — another system handles that. Work strictly from the StrategyFacts you are given. Each anchor carries the node's "label", a "meaning" (what the node does), its "params", and sometimes a "paramGloss" explaining each param — narrate from those, nothing else. NEVER invent backtest numbers: if the facts contain no metrics, narrate the result qualitatively.

Rules for the build section:
- Emit EXACTLY ONE voiceoverSegment per node in StrategyFacts.anchors, in the SAME ORDER as the anchors array.
- Each segment's actionRef MUST equal that anchor's semanticId (copy it verbatim).
- Each line is ONE spoken sentence, ~12-22 words, conversational and concrete. Explain what the node does using its "meaning", and weave in its "params" (use "paramGloss" to phrase them when present, e.g. MACD's 12/26/9). Spell numbers as digits.
- Vary sentence openings; it should sound like a person narrating, not a list.
- emotion is a one-word mood tag (calm, focus, excited, precision, …).
- Speak like a person, not a robot. NEVER read machine-readable literals out loud — no hex codes (#3b82f6), no rgb/rgba tuples (rgba(187,247,208,1)), no selectors, no pixel sizes, no raw enum values. If a param is a color, name the color in plain English (e.g. "#3b82f6" → "blue", "#14b8a6" → "teal", "#facc15" → "gold"); add a soft qualifier when helpful ("bright blue", "soft teal", "deep red") but never echo the literal value. If a param value has no natural spoken form, paraphrase it conversationally or omit it. Parentheticals quoting the literal (e.g. "blue (#3b82f6)") are FORBIDDEN.

Rules for the outro:
- One sentence describing what the viewer now sees on the chart (the plotted result), ending with a light forward nudge (e.g. ready to backtest).

Match the tone in video.tone. Set video.flow to the flow name from the facts and write a short video.title.

Output ONLY a single JSON object — no markdown fences, no commentary — with EXACTLY this shape:
{"video":{"flow":string,"title":string,"tone":string},"build":{"voiceoverSegments":[{"line":string,"actionRef":string,"emotion":string}]},"outro":{"voiceover":string}}`;

// Extract a JSON object from possibly-chatty model output (free models often add
// preamble or code fences). Strips fences, then scans for the first balanced {…}.
function extractJson(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('{');
  if (s < 0) throw new Error('no JSON object in model output');
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { if (--depth === 0) return JSON.parse(t.slice(s, i + 1)); }
  }
  throw new Error('unbalanced JSON in model output');
}

async function callOpenRouter(systemText, userText) {
  const key = process.env.OPENROUTER_API_KEY;
  const models = process.env.OPENROUTER_MODEL ? [process.env.OPENROUTER_MODEL] : OR_FREE_MODELS;
  let lastErr = 'none';
  // Two passes over the model list (free models are intermittently 429).
  for (let pass = 0; pass < 2; pass++) {
    for (const model of models) {
      try {
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'content-engine planner' },
          body: JSON.stringify({
            // 8000 leaves headroom for "thinking" free models that burn tokens on
            // reasoning before the JSON — 4000 truncated nemotron mid-object.
            model, max_tokens: 8000, temperature: 0.7,
            response_format: { type: 'json_object' },
            messages: [{ role: 'system', content: systemText }, { role: 'user', content: userText }],
          }),
        });
        const j = await r.json().catch(() => ({}));
        if (r.status === 429 || j?.error?.code === 429) { lastErr = `429 ${model}`; continue; }
        if (j?.error) { lastErr = `${model}: ${j.error.message || JSON.stringify(j.error)}`; continue; }
        const choice = j?.choices?.[0];
        const text = choice?.message?.content;
        if (!text || !text.trim()) { lastErr = `${model}: empty response`; continue; }
        // Validate parseability HERE so a truncated/garbled reply falls through to
        // the next model instead of bubbling up as a hard failure.
        try { extractJson(text); }
        catch { lastErr = `${model}: ${choice?.finish_reason === 'length' ? 'truncated output' : 'unparseable JSON'}`; continue; }
        log(`model: ${model}`); return text;
      } catch (e) { lastErr = `${model}: ${e.message}`; }
    }
    if (pass === 0) { log('all free models busy — retrying in 4s…'); await sleep(4000); }
  }
  throw new Error(`OpenRouter free models unavailable (last: ${lastErr}). Retry shortly, set OPENROUTER_MODEL=<id>, or add credits at openrouter.ai for higher free limits.`);
}

async function callAnthropic(systemText, userText) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const response = await client.messages.create({
    model: ANTHROPIC_MODEL, max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA }, effort: 'high' },
    // The facts (with per-node meaning) are now flow-specific and small, so they
    // ride in the user turn; the stable system prompt is the cacheable prefix.
    system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userText }],
  });
  if (response.usage) log(`tokens in ${response.usage.input_tokens} (cache ${response.usage.cache_read_input_tokens ?? 0}), out ${response.usage.output_tokens}`);
  const block = response.content.find((b) => b.type === 'text');
  if (!block) throw new Error('Anthropic returned no text block');
  return block.text;
}

async function main() {
  const useOR = !!process.env.OPENROUTER_API_KEY && !process.env.PLAN_FORCE_ANTHROPIC;
  if (!useOR && !process.env.ANTHROPIC_API_KEY) {
    throw new Error('No LLM key. Set OPENROUTER_API_KEY (dev) or ANTHROPIC_API_KEY (prod) in .env or env.');
  }

  const factsPath = path.resolve(ROOT, `flows/${flow}/facts.json`);
  if (!fs.existsSync(factsPath)) throw new Error(`No facts at flows/${flow}/facts.json — run "npm run gen:facts ${flow}" first.`);
  const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));

  // The catalog is now an OPTIONAL enrichment, keyed by nodeKey — never required.
  // Each anchor already self-describes (its `meaning` comes from the flow's own
  // Description), so an absent or partial catalog just means plainer copy, not a
  // failure. This is what lets a brand-new flow with unseen nodes plan correctly.
  const catalogPath = path.resolve(ROOT, 'data/node-catalog.json');
  const catalog = fs.existsSync(catalogPath) ? JSON.parse(fs.readFileSync(catalogPath, 'utf8')) : {};
  let overridden = 0;
  for (const a of facts.anchors || []) {
    const c = catalog[a.nodeKey];
    if (!c) continue;
    if (c.meaning) { a.meaning = c.meaning; overridden++; } // richer than the flow's tooltip
    if (c.paramGloss && Object.keys(c.paramGloss).length) a.paramGloss = c.paramGloss;
  }
  const unseen = (facts.anchors || []).filter((a) => !catalog[a.nodeKey]).map((a) => a.nodeKey);
  if (unseen.length) log(`catalog: ${overridden} enriched, ${unseen.length} narrating from flow description (${[...new Set(unseen)].join(', ')})`);

  const outPath = path.resolve(ROOT, `flows/${flow}/content-plan.json`);
  if (fs.existsSync(outPath) && !args.force) {
    throw new Error(`flows/${flow}/content-plan.json already exists. Re-run with --force to overwrite (a backup is kept).`);
  }

  const userText = `StrategyFacts for this flow (each anchor carries its own meaning + params):\n${JSON.stringify(facts, null, 2)}\n\nGenerate the ContentPlan now. Output ONLY the JSON object.`;

  log(`planning "${flow}" via ${useOR ? 'OpenRouter (free)' : 'Anthropic ' + ANTHROPIC_MODEL}…`);
  const raw = useOR
    ? await callOpenRouter(SYSTEM, userText)
    : await callAnthropic(SYSTEM, userText);

  let plan;
  try { plan = extractJson(raw); }
  catch (e) { throw new Error(`model output was not valid JSON: ${e.message}\n${String(raw).slice(0, 400)}`); }

  // ── Validate against the anchor table — the hallucination guard.
  plan.video = plan.video || {};
  plan.video.flow = flow;
  const valid = new Set(facts.anchors.map((a) => a.semanticId));
  const segs = plan.build?.voiceoverSegments || [];
  if (!segs.length) throw new Error('ContentPlan has no build.voiceoverSegments');
  const bad = [...new Set(segs.filter((s) => !valid.has(s.actionRef)).map((s) => s.actionRef))];
  if (bad.length) throw new Error(`unknown actionRef(s): ${bad.join(', ')}. Valid: ${[...valid].join(', ')}`);
  const refs = new Set(segs.map((s) => s.actionRef));
  const missing = facts.anchors.filter((a) => !refs.has(a.semanticId)).map((a) => a.semanticId);
  if (missing.length) log(`note: ${missing.length} node(s) have no narration: ${missing.join(', ')}`);

  if (fs.existsSync(outPath)) { const bak = outPath.replace(/\.json$/, '.bak.json'); fs.copyFileSync(outPath, bak); log(`backed up existing → flows/${flow}/${path.basename(bak)}`); }
  fs.writeFileSync(outPath, JSON.stringify(plan, null, 2) + '\n');
  log(`\x1b[32mwrote\x1b[0m flows/${flow}/content-plan.json — ${segs.length} segments + outro`);
  for (const s of segs) console.log(`  ${s.actionRef}: "${s.line}"`);
  console.log(`  outro: "${plan.outro?.voiceover || ''}"`);
}

main().catch((err) => { console.error(`\x1b[31m[plan] ${err.message}\x1b[0m`); process.exit(1); });
