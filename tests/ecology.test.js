const test=require('node:test'),assert=require('node:assert/strict');
const lib=require('..'),{KIT:K,makeBuilder,SpriteSurface}=lib.load(),E=K.ecology;
const near=(a,b,e=1e-5)=>assert(Math.abs(a-b)<e,`${a} != ${b}`);
const advance=(sim,t,dt=.1)=>{for(let now=0;now<t-dt*.5;now+=dt)sim.update(dt);};
function fire(options={}){return E.create({width:12,height:5,materials:{grass:{fuel:.7},stone:{fuel:0},wet:{fuel:.7,moisture:1}},processes:[E.processes.fire({seed:19})],...options});}

test('named channels support a custom ecology process with no fire or renderer',()=>{
  const sim=E.create({width:3,height:2,channels:{water:{},moss:{}},materials:{soil:{water:.7}},processes:[{id:'moss',step(ctx,h){for(let i=0;i<ctx.count;i++){const amount=Math.min(ctx.read('water',i),h*.2);ctx.add('water',i,-amount);ctx.add('moss',i,amount);}}}]});
  advance(sim,1);near(sim.read('water',0),.5);near(sim.read('moss',0),.2);
  assert.deepEqual(sim.channels,['water','moss']);assert.equal(sim.sample([-1,0,0]),null);
  assert.equal(sim.sample([.5,0,.5]).material,'soil');
});

test('bounded transfers diffuse a channel without inventing or losing its quantity',()=>{
  const sim=E.create({width:8,height:5,channels:{moisture:{}},materials:{wet:{moisture:1},dry:{}},materialAt:x=>x<2?'wet':'dry',processes:[E.processes.diffusion({id:'water',field:'moisture',rate:20})]});
  const sum=()=>Array.from({length:sim.count},(_,i)=>sim.read('moisture',i)).reduce((a,b)=>a+b,0),initial=sum();
  advance(sim,4);near(sum(),initial,1e-4);assert(sim.read('moisture',3)>.05);
  for(let i=0;i<sim.count;i++)assert(sim.read('moisture',i)>=0&&sim.read('moisture',i)<=1);
});

test('fire consumes actual fuel, respects a stone firebreak and does not char wet foliage',()=>{
  const sim=fire({materialAt:(x,z)=>x>=5&&x<6?'stone':x>=9?'wet':'grass'});
  sim.contact({type:'ignite',p:[1.5,0,2.5],radius:.5});
  sim.contact({type:'ignite',p:[9.5,0,2.5],radius:.5});advance(sim,14);
  assert(sim.sample([1.5,0,2.5]).values.char>.9);near(sim.sample([1.5,0,2.5]).values.fuel,0);
  assert(sim.sample([3.5,0,2.5]).values.char>.5);
  near(sim.sample([5.5,0,2.5]).values.char,0);near(sim.sample([7.5,0,2.5]).values.char,0);
  near(sim.sample([9.5,0,2.5]).values.char,0);
  assert(sim.drainEvents().some(e=>e.kind==='fuel-exhausted'));
});

test('water contacts extinguish fire and keep their shared moisture state',()=>{
  const sim=fire();sim.contact({type:'ignite',p:[2.5,0,2.5],radius:.4});advance(sim,.6);
  assert(sim.sample([2.5,0,2.5]).values.burning>0);
  sim.contact({type:'water',p:[2.5,0,2.5],radius:2,values:{moisture:1,heat:0}});advance(sim,.5);
  const cell=sim.sample([2.5,0,2.5]);near(cell.values.burning,0);near(cell.values.moisture,1);
  const fuel=cell.values.fuel;advance(sim,2);near(sim.sample([2.5,0,2.5]).values.fuel,fuel);
});

test('fixed steps, checkpoints and reset replay give the same seeded spread',()=>{
  const run=dt=>{const sim=fire();sim.contact({type:'ignite',id:'start',p:[1.5,0,2.5],radius:.6});advance(sim,2,dt);return sim;};
  const a=run(.1),b=run(.025);assert.deepEqual(a.snapshot().fields,b.snapshot().fields);
  const saved=JSON.parse(JSON.stringify(a.snapshot()));advance(a,2);const expected=a.snapshot();
  a.restore(saved);advance(a,2);assert.deepEqual(a.snapshot().fields,expected.fields);assert.deepEqual(a.snapshot().processes,expected.processes);
  a.reset();a.contact({type:'ignite',id:'start',p:[1.5,0,2.5],radius:.6});advance(a,2);assert.deepEqual(a.snapshot().fields,b.snapshot().fields);
});

test('a failed process rolls back channels, private fire state, random draws and pending contacts',()=>{
  let fail=true;
  const sim=fire({processes:[E.processes.fire(),{id:'failure',step(ctx){ctx.random();ctx.set('char',0,1);if(fail)throw new Error('try again');}}]});
  sim.contact({type:'ignite',p:[1.5,0,1.5],radius:.2});const before=sim.snapshot();
  assert.throws(()=>sim.update(.1),/try again/);const after=sim.snapshot();
  assert.deepEqual(after.fields,before.fields);assert.deepEqual(after.processes,before.processes);assert.equal(after.randomState,before.randomState);assert.equal(after.contacts.length,1);
  fail=false;sim.update(0);assert.equal(sim.stats.tick,1);
});

test('contacts carry arbitrary ecological actions, schedule at tick boundaries and deduplicate event IDs',()=>{
  const sim=E.create({width:2,height:1,channels:{wear:{}},materials:{path:{}},processes:[{id:'trampling',contact(ctx,e){if(e.type==='step')for(const i of ctx.cellsInDisc(e.p,e.radius))ctx.add('wear',i,.1);},step(){}}]});
  let batch=[{id:'foot',type:'step',p:[.5,0,.5],radius:0,time:.3}];
  const input=E.contacts(sim,{read:()=>batch});input.update();input.update();advance(sim,.2);near(sim.read('wear',0),0);
  advance(sim,.1);near(sim.read('wear',0),.1);batch=[];input.update();
  assert.equal(sim.drainEvents().filter(e=>e.kind==='contact').length,1);
});

test('one appearance function applies the same channels to splats and textured atlas texels, including reset',()=>{
  const B=makeBuilder(1,[0x809040]);B.iso(.5,0,.5,.1,B.P[0],3);B.iso(3.5,0,.5,.1,B.P[0],3);
  const W=B.finish(),stage=K.stage(W),atlas={width:1,height:1,pixels:Uint8Array.from([128,144,64,255]),vertices:new Float32Array(0)};
  const sim=E.create({width:4,height:1,channels:{scar:{}},materials:{ground:{}}});
  stage.add(E.bind(stage,sim,{style:[{field:'scar',color:[.05,.06,.07]}],splats:[{ids:[0,1]}],textures:[{atlas,point:()=>[.5,0,.5]}]}));
  sim.contact({type:'damage',p:[.5,0,.5],radius:0,values:{scar:.8}});sim.update(.1);stage.update(0,0);
  const packed=W.data[7],splat=[packed&255,packed>>8&255,packed>>16&255];
  splat.forEach((v,i)=>near(v,atlas.pixels[i],1.01));assert(atlas.revision>0);
  const initialOther=stage.base[23];near(W.data[23],initialOther);
  sim.reset();stage.update(0,.1);assert.deepEqual(Array.from(atlas.pixels),[128,144,64,255]);near(W.data[7],stage.base[7]);
});

test('light output is bounded and heat-free material nearby receives the same local lighting across surface types',()=>{
  const B=makeBuilder(1,[0x606060]);B.iso(1.5,0,.5,.1,B.P[0],3);const W=B.finish(),stage=K.stage(W);
  const sim=fire({width:4,height:1});const binding=stage.add(E.bind(stage,sim,{lights:{max:1},splats:[{ids:[0]}]}));
  sim.contact({type:'ignite',p:[.5,0,.5],radius:0});sim.update(.1);stage.update(0,0);
  assert.equal(binding.lights.length,1);assert(W.data[7]!==stage.base[7]);
  sim.reset();stage.update(0,.1);assert.equal(binding.lights.length,0);near(W.data[7],stage.base[7]);
});

test('atlas update history supports independent consumers and falls back safely after missed revisions',()=>{
  const atlas={width:4,height:4,pixels:new Uint8Array(64)};
  SpriteSurface.markDirty(atlas,{x:0,y:0,width:1,height:1});SpriteSurface.markDirty(atlas,{x:3,y:2,width:1,height:1});
  assert.equal(SpriteSurface.updatesSince(atlas,0).length,2);assert.equal(SpriteSurface.updatesSince(atlas,1).length,1);
  assert.equal(SpriteSurface.updatesSince(atlas,0).length,2);
  for(let i=0;i<40;i++)SpriteSurface.markDirty(atlas);
  assert.equal(SpriteSurface.updatesSince(atlas,0),null);assert.deepEqual(SpriteSurface.updatesSince(atlas,atlas.revision),[]);
});

test('invalid snapshots, overlapping binding ownership and ambiguous reused UVs fail before altering state',()=>{
  const sim=fire(),before=sim.snapshot(),bad=JSON.parse(JSON.stringify(before));bad.fields.fuel[0]=-1;
  assert.throws(()=>sim.restore(bad),/channels/);assert.deepEqual(sim.snapshot(),before);
  assert.throws(()=>sim.contact({type:'x',p:[0,0,0],values:{unknown:1}}),/channel/);
  const B=makeBuilder(1);B.iso(.5,0,.5,.1,B.P[0],3);const stage=K.stage(B.finish());const bind=stage.add(E.bind(stage,sim,{splats:[{ids:[0]}]}));
  assert.throws(()=>E.bind(stage,sim,{splats:[{ids:[0]}]}),/ownership/);bind.dispose();stage.add(E.bind(stage,sim,{splats:[{ids:[0]}]}));
  const atlas={width:2,height:2,pixels:new Uint8Array(16),vertices:Float32Array.from([
    0,0,0,.5,.5, 1,0,0,1.5,.5, 0,0,1,.5,1.5,
    5,0,0,.5,.5, 6,0,0,1.5,.5, 5,0,1,.5,1.5])};
  assert.throws(()=>E.atlasPoints(atlas),/unique world positions/);
});
