const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { recoveryCandidates, localRecovery } = require('../src/skills/local-recovery');
const { recoveryAction } = require('../src/skills/recovery-action');
function fixture() {
  const removed = new Set();
  const bot = { entity: { position: new Vec3(.5,40,.5) },
    blockAt(p) { const air = removed.has(p.toString()) || (p.x === 0 && p.z === 0 && [40,41].includes(p.y));
      return { position:p, name:air?'air':'stone', boundingBox:air?'empty':'block' }; },
    canDigBlock:()=>true, pathfinder:{bestHarvestTool:()=>null}, dig:async b=>removed.add(b.position.toString()) };
  return bot;
}
test('recovery only clears head/feet horizontally and then navigates', async()=>{
  const bot=fixture(), dug=[];const dig=bot.dig;bot.dig=async b=>{dug.push(b.position);await dig(b)};
  let destination;
  const result=await localRecovery({bot,check(){},step:async(_t,f)=>f(),navigate:async(_t,p)=>{destination=p}},{});
  assert.equal(result.cleared,2);assert.deepEqual(dug.map(p=>p.y),[41,40]);assert.equal(destination.y,40);
});
test('recovery refuses lava, falling blocks, unloaded terrain and unsafe floors',()=>{
  for(const name of ['lava','gravel',null]) {
    const bot=fixture(), original=bot.blockAt;
    bot.blockAt=p=>p.y===42?(name?{position:p,name,boundingBox:'block'}:null):original(p);
    assert.equal(recoveryCandidates(bot).length,0);
  }
  const bot=fixture(),original=bot.blockAt;
  bot.blockAt=p=>p.y===39?{position:p,name:'air',boundingBox:'empty'}:original(p);
  assert.equal(recoveryCandidates(bot).length,0);
});
test('blocked target can choose local recovery, but excavation budget and guard are enforced',()=>{
  const bot=fixture(),guard={check:()=>({ok:true}),checkBlock:()=>true};
  const o={environment:{nearby_resources:[],exploration:{destination:null}}};
  assert.equal(recoveryAction(bot,guard,o,0).skill,'EXPLORE_AREA');
  assert.equal(recoveryAction(bot,guard,o,3),null);
  guard.check=()=>({ok:false});assert.equal(recoveryAction(bot,guard,o,0),null);
});
test('reachable observed resource is preferred to excavation',()=>{
  const bot=fixture(),guard={check:()=>({ok:true}),checkBlock:()=>true};
  const o={environment:{nearby_resources:[{type:'stone',category:'ore',can_harvest:true,position:{x:1,y:40,z:0}}]}};
  assert.equal(recoveryAction(bot,guard,o).skill,'MINE_RESOURCE');
  o.player = { hp: 1, hunger: 0 };
  const survival = recoveryAction(bot,guard,o);
  assert.equal(survival.skill, 'EXPLORE_AREA');
  assert.equal(survival.params.target, 'food');
  assert.equal(recoveryAction(bot,guard,o,3), null);
});
