const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { config } = require('../src/experiment/config');
const { evaluate } = require('../src/escalation/gate');
const { GoalManager, planSchema } = require('../src/goal/manager');
const { WorldModel, RunMemory, KnowledgeMemory } = require('../src/memory/state');
const { SaveSystem } = require('../src/save/save_system');
const { ActionArbiter } = require('../src/bot/arbiter');
const { SkillExecutor } = require('../src/skills/executor');
const { createPlanner } = require('../src/agent/planner');
const goal = { id: 'wood', description: 'Acquire wood', objective: 'ACQUIRE', target: 'oak_log', amount: 2, constraints: [] };
const plan = { rationale: 'begin', goals: [goal] };
const obs = { inventory: {}, dimension: 'overworld', player: { hp: 20, position: { x: 0, y: 64, z: 0 } } };
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(),'mineblind-')); t.after(() => fs.rmSync(dir,{recursive:true,force:true})); return dir; }
test('ablation flags are cumulative and validated', () => {
  assert.equal(config({EXPERIMENT_MODE:'A'}).agent,false);
  assert.equal(config({EXPERIMENT_MODE:'B'}).gate,false);
  assert.equal(config({EXPERIMENT_MODE:'D'}).memory,false);
  assert.equal(config({EXPERIMENT_MODE:'E'}).memory,true);
  assert.throws(() => config({EXPERIMENT_MODE:'F'}));
  assert.throws(() => config({DECISION_INTERVAL_MS:'-1'}));
});
test('gate exact boundaries and clamping', () => {
  assert.equal(evaluate({}).verdict,'reject');
  assert.equal(evaluate({uncertainty:1, invalid:1}).verdict,'defer');
  assert.equal(evaluate({stagnation:1,uncertainty:1,value:1}).verdict,'defer');
  assert.equal(evaluate({stagnation:1,uncertainty:1,invalid:1,value:1}).score,1);
});
test('macro schema, inventory completion and new-chunk stagnation evidence', () => {
  assert.throws(() => planSchema.parse({goals:[]}));
  const m = new GoalManager(100); m.setPlan(plan); m.lastProgress = 0;
  assert.equal(m.evaluate(obs,{new_chunks_visited:1},10),null);
  assert.equal(m.evaluate(obs,{new_chunks_visited:2},110),null);
  assert.equal(m.evaluate(obs,{new_chunks_visited:2},211).type,'stagnation');
  assert.equal(m.evaluate({...obs,inventory:{oak_log:2}},{new_chunks_visited:2},212).type,'goal_complete');
});
test('world separates dimensions and excludes dimension jumps from distance', () => {
  const w = new WorldModel(); w.update(obs);
  assert.equal(w.update({...obs,dimension:'the_nether'}).new_chunks_visited,2);
  assert.equal(w.distance,0);
  assert.equal(new WorldModel(w.snapshot()).chunks.size,2);
});
test('metrics use intervals between agent calls', () => {
  const r = new RunMemory(); r.agentCalled(100); r.agentCalled(300); r.agentCalled(600);
  assert.equal(r.metrics().meanAutonomousHorizonMs,250);
});
test('save roundtrip, identity rejection and corruption', t => {
  const s = new SaveSystem(temp(t),{world:'test',mode:'E'});
  s.log('test'); const snapshot = {run_memory:{gameDay:2},world_model:{},goal_manager:{},agent_plan:plan};
  const dir = s.save(snapshot,'manual'); assert.deepEqual(s.restore('latest'),snapshot);
  assert.throws(() => new SaveSystem(s.root,{world:'other',mode:'E'}).restore('latest'),/mismatch/);
  fs.writeFileSync(path.join(dir,'agent_plan.json'),'{'); assert.throws(() => s.restore('latest'),/Cannot restore/);
});
test('knowledge caching and D memory ablation', t => {
  const dir = temp(t); const k = new KnowledgeMemory(dir); k.put('portal',{answer:'obsidian'});
  assert.equal(k.get('portal').answer,'obsidian'); assert.throws(() => k.get('../secret'));
  const disabled = new KnowledgeMemory(dir,false); assert.equal(disabled.get('portal'),null);
  disabled.put('disabled',{}); assert.equal(k.get('disabled'),null);
});
test('arbiter preserves highest pending reflex until old writer settles', () => {
  const executor = {busy:false,start(skill,params){this.busy=true;this.current={skill,params};return true;},cancel(){}};
  const a = new ActionArbiter(executor); a.submit('EXPLORE_AREA',{},3);
  a.submit('FLEE',{},0); assert.equal(a.submit('EAT',{},1),false);
  executor.busy=false; a.tick(); assert.equal(executor.current.skill,'FLEE');
  executor.busy=false; a.tick(); assert.equal(executor.current.skill,'EXPLORE_AREA');
});
test('cancelled container opening always closes without withdrawal', async () => {
  let resolve; let closed=false; let withdrew=false;
  const { Vec3 } = require('vec3');
  const bot = { entity:{position:new Vec3(0,0,0)}, registry:{blocksByName:{chest:{id:1}}}, inventory:{items:()=>[]},
    findBlock:()=>({position:{x:0,y:0,z:0}}), pathfinder:{goto:async()=>{},setGoal(){}},
    openContainer:()=>new Promise(r=>{resolve=r;}), stopDigging(){},clearControlStates(){},deactivateItem(){} };
  const e = new SkillExecutor(bot); e.start('LOOT_CONTAINER');
  await new Promise(r=>setImmediate(r)); e.cancel(); resolve({close(){closed=true;},containerItems(){withdrew=true;return [];}});
  await e.current.promise; assert.equal(closed,true); assert.equal(withdrew,false); assert.equal(e.busy,false);
});
test('Mastra planner structured output contract (mocked generate, no network)', async () => {
  const p = createPlanner(config({EXPERIMENT_MODE:'B'}),null);
  p.agent.generate = async (input, options) => { assert.equal(options.maxSteps,5); assert.ok(options.structuredOutput.schema); return {object:plan,usage:{totalTokens:20}}; };
  assert.deepEqual((await p.plan({reason:'startup'},new AbortController().signal)).plan,plan);
});
