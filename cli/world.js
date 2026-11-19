const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const read = file => JSON.parse(fs.readFileSync(path.resolve(file),'utf8'));
const parse = input => JSON.parse(String(input));
const numbers = value => String(value).split(',').map(Number);
function ensure(condition,message) {
  if (!condition) throw Error(message);
}
function write(file,value) {
  ensure(typeof file === 'string' && file.length > 0,'Expected an output file');
  const destination = path.resolve(file);
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  const temporary = destination+'.'+randomUUID()+'.tmp';
  try {
    fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
    fs.renameSync(temporary,destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function target(opt) {
  if (opt.at !== undefined) return {point:numbers(opt.at)};
  if (opt.entity !== undefined) return {entity:opt.entity,...(opt.socket?{socket:opt.socket}:{})};
  return {};
}

module.exports = function createCLI({kit,build,pose,dataScene,opt}) {
  const W = kit.KIT.world, R = W.runtime;
  const args = () => opt.args ? parse(opt.args) : {};
  const respond = value => {
    if (opt.out) write(opt.out,value);
    else process.stdout.write(JSON.stringify(value,null,opt.json?0:2)+'\n');
  };
  function load(file) {
    ensure(typeof file === 'string','Expected a scene or run file');
    if (/\.(js|cjs)$/i.test(file)) {
      const factory = require(path.resolve(file)), value = typeof factory === 'function' ? factory(kit) : factory;
      return value.format===W.format ? {world:value} : value.simulation ? {world:value.simulation} : {legacy:file};
    }
    if (/\.json$/i.test(file)) {
      const value = read(file);
      if (value.format === W.format) return {world:value};
      if (value.format === R.checkpointFormat) return {world:value.world,checkpoint:value};
      if (value.format === R.runFormat) return {world:value.end.world,checkpoint:value.end,log:value};
      return {legacy:file,document:value};
    }
    return {legacy:file};
  }
  function runtime(input, profile = false) {
    ensure(input.world,'The scene must expose an Ink Studio world manifest');
    const source = !input.checkpoint && (opt.seed !== undefined || opt.dt !== undefined)
      ? {...input.world,...(opt.seed===undefined?{}:{seed:Number(opt.seed)}),...(opt.dt===undefined?{}:{dt:Number(opt.dt)})}
      : input.world;
    if (input.checkpoint) ensure(opt.seed===undefined && opt.dt===undefined,'A resumed run uses its checkpoint seed and timestep');
    return R.create(source,{checkpoint:input.checkpoint,profile});
  }
  function to(run) {
    const {tick,world} = run.view(), modes = [opt.ticks,opt.steps,opt.t].filter(v => v !== undefined);
    ensure(modes.length<=1 && modes.every(v => v!==true && Number.isFinite(Number(v))),'Specify one finite time using --ticks, --steps or --t');
    return opt.ticks !== undefined ? Number(opt.ticks) :
      opt.steps !== undefined ? tick + Number(opt.steps) :
      opt.t !== undefined ? Math.floor(Number(opt.t)/world.dt+1e-10) :
      world.scenario?.until !== undefined ? Math.max(tick,world.scenario.until) : tick;
  }
  function schedule(run) {
    if (opt.actions) run.schedule(read(opt.actions));
  }
  function view(file) {
    const input = load(file);
    if (input.world) {
      const run = runtime(input);
      if (opt.actions || opt.ticks !== undefined || opt.steps !== undefined || opt.t !== undefined) {
        schedule(run);
        run.advance(to(run));
      }
      return run.query();
    }
    const world = build(input.legacy);
    const t = Number(opt.t ?? 0);
    ensure(Number.isFinite(t) && t>=0,'Invalid probe time');
    pose(world,t);
    return W.query.fromScene(world,t);
  }
  function assert(run,rules) {
    ensure(Array.isArray(rules) && rules.length<=10000,'Expected an assertion list');
    const out=[], temporal=[];
    const log=run.recording(), tick=run.view().tick;
    function evaluate(rule,query,at) {
      const sample=query.probe(rule.field,rule.at,rule.args);
      return {id:rule.id,tick:at,pass:sample.status===(rule.status??'ok')&&W.query.condition(rule.when,sample.value),result:sample};
    }
    for(const [i,raw] of rules.entries()){
      ensure(raw&&typeof raw==='object','Expected assertion '+(i+1));
      const rule={id:i+1,...raw};
      if(rule.profile!==undefined){
        const metric=rule.metric??'ms', data=run.profile()[rule.profile]?.[metric];
        ensure(['ms','maxMs','calls'].includes(metric)&&Number.isFinite(rule.max)&&rule.max>=0,'Invalid profile assertion');
        out[i]={id:rule.id,pass:Number.isFinite(data)&&data<=rule.max,result:{metric,value:data??null,max:rule.max}};
        continue;
      }
      ensure(typeof rule.field==='string','Assertion '+rule.id+' needs a field');
      if(rule.tick===undefined&&rule.byTick===undefined){out[i]=evaluate(rule,run.query(),tick);continue;}
      const at=rule.tick??rule.byTick;
      ensure((rule.tick===undefined||rule.byTick===undefined)&&Number.isSafeInteger(at)&&at>=log.origin.tick&&at<=tick,
        'Assertion tick lies outside the run');
      temporal.push({i,rule,at});
    }
    if(temporal.length){
      const replay=R.create(log.origin.world,{checkpoint:log.origin});
      replay.schedule(log.commands);
      const exact=new Map(), deadlines=[];
      for(const item of temporal){
        if(item.rule.tick===undefined)deadlines.push(item);
        else {
          const group=exact.get(item.at)??[];
          group.push(item);
          exact.set(item.at,group);
        }
      }
      function sample(frame,query){
        for(const {i,rule} of exact.get(frame.tick)??[])out[i]=evaluate(rule,query,frame.tick);
        for(const {i,rule,at} of deadlines){
          if(out[i])continue;
          const result=evaluate(rule,query,frame.tick);
          if(result.pass||frame.tick===at)out[i]=result;
        }
      }
      sample(replay.view(),replay.query());
      replay.advance(Math.max(...temporal.map(item=>item.at)),{onTick:sample});
    }
    return out;
  }
  function summary(run, checks) {
    const checkpoint = run.checkpoint(), {world,tick} = checkpoint;
    return {id:world.id,seed:world.seed,dt:world.dt,tick,time:tick*world.dt,
      systems:Object.keys(checkpoint.states),commands:run.commandCounts(),events:checkpoint.history.length,historyDropped:checkpoint.dropped,
      scenario:run.scenario,...(checks?{checks}:{}),...(opt.profile?{profile:run.profile()}:{})};
  }
  function finish(run) {
    const checks = opt.assert ? assert(run,read(opt.assert)) : null;
    if (opt.checkpoint) write(opt.checkpoint,run.checkpoint());
    if (opt.record) write(opt.record,run.recording());
    respond(summary(run,checks));
    if (checks?.some(row => !row.pass) || opt.scenario && ['fail','timeout'].includes(run.scenario.status))
      process.exitCode = 2;
  }
  function getCheckpoint(file) {
    const input = load(file);
    ensure(input.checkpoint,'Expected a checkpoint or recording');
    if (opt.ticks === undefined || Number(opt.ticks)===input.checkpoint.tick) return input.checkpoint;
    ensure(input.log,'Earlier ticks require a recording');
    const at=Number(opt.ticks);
    ensure(Number.isSafeInteger(at)&&at>=input.log.origin.tick&&at<=input.log.end.tick,'Tick lies outside the recording');
    const run = R.create(input.log.origin.world,{checkpoint:input.log.origin});
    run.schedule(input.log.commands);
    run.advance(at);
    return run.checkpoint();
  }
  function sim([mode,file,other]) {
    switch (mode) {
      case 'run':
      case 'resume':
      case 'fork': {
        const input = load(file);
        ensure(mode==='run' || input.checkpoint,'Expected a checkpoint or recording to resume or fork');
        const run = runtime(input,!!(opt.profile||opt.assert));
        schedule(run);
        run.advance(to(run),{stopOnOutcome:!!opt.scenario});
        finish(run);
        break;
      }
      case 'reset': {
        const input=load(file);
        finish(input.log?R.create(input.log.origin.world,{checkpoint:input.log.origin}):runtime(input));
        break;
      }
      case 'replay': {
        const input=load(file);
        ensure(input.log,'Expected a run recording');
        finish(R.replay(input.log,{profile:!!(opt.profile||opt.assert)}));
        break;
      }
      case 'diff': {
        const a=getCheckpoint(file), b=getCheckpoint(other);
        if(!opt.field){respond(R.diff(a,b));break;}
        ensure(a.tick===b.tick,'Simulation diff needs matched ticks');
        const queries=[a,b].map(checkpoint=>R.create(checkpoint.world,{checkpoint}).query());
        const spec=opt.spec?read(opt.spec):null;
        const readings=queries.map(query=>spec?query.export(opt.field,spec,args()):query.probe(opt.field,target(opt),args()));
        respond({tick:a.tick,field:opt.field,edits:W.query.keyedChanges(...readings),...(spec?{grid:readings[0].grid}:{})});
        break;
      }
      case 'sweep': {
        const input=load(file), spec=read(other);
        ensure(Array.isArray(spec) && spec.length>0 && spec.length<=2000,'Expected a bounded sweep list');
        ensure(input.world,'Sweep needs a simulation world');
        const runs=spec.map((row,i)=>{
          let source=input.world;
          if (row.edits || row.seed!==undefined) {
            ensure(!input.checkpoint,'Use scheduled actions to vary a checkpoint branch');
            if (row.edits) source=W.apply(W.manifest(source),row.edits).world;
            if (row.seed!==undefined) source={...source,seed:row.seed};
          }
          const run=runtime({...input,world:source},!!(opt.profile||row.assert));
          run.schedule(row.actions??[]);
          run.advance(row.ticks??to(run),{stopOnOutcome:!!opt.scenario});
          const measurements=(row.probes??[]).map(spec=>({field:spec.field,...run.query().probe(spec.field,spec.at,spec.args)}));
          return {id:row.id??i, ...summary(run,row.assert?assert(run,row.assert):null),measurements};
        });
        respond({runs});
        if (runs.some(row => row.checks?.some(check => !check.pass))) process.exitCode=2;
        break;
      }
      case 'render': {
        const input=load(file), run=runtime(input);
        schedule(run);
        run.advance(to(run));
        ensure(typeof opt.out==='string','Simulation render needs --out image.png');
        const world=W.visual(kit,run.view(),run.query());
        const studio=require('../index.js');
        const image=studio.render(world,{w:Number(opt.w??720),h:Number(opt.h??475),colored:!!opt.colored});
        const output=path.resolve(opt.out);
        fs.mkdirSync(path.dirname(output),{recursive:true});
        require('./png.js').write(output,image.w,image.h,image.rgb);
        break;
      }
      default: throw Error('Use sim run|resume|fork|reset|replay|diff|sweep|render');
    }
  }
  function legacyValidator(input) {
    return value=>input.document.format==='ink-studio/authoring'?
      kit.KIT.authoring.data.documentView(value):dataScene(input.legacy,value);
  }
  function scene([mode,file,reference]) {
    const input=load(file);
    if (mode==='apply'&&input.document){
      const validator=legacyValidator(input);
      validator(input.document);
      const result=W.apply(kit.KIT.procedural.data.freeze(W.data.copy(input.document)),read(reference),{validate:validator});
      respond(opt['dry-run']?{changed:result.paths}:result.world);
      return;
    }
    if(mode==='promote'){
      ensure(input.checkpoint&&typeof reference==='string','Promote needs a run or checkpoint and a trace name');
      const options=args(), trace=runtime(input).query().trace(reference,target(opt),options);
      ensure(trace.status==='ok',trace.reason??'Trace failed');
      const result=W.history.trail(input.world,opt.as,trace.value,options);
      R.validate(result.world);
      respond(opt['dry-run']?{changed:result.paths}:result.world);
      return;
    }
    ensure(input.world && !input.checkpoint,'Expected a world manifest');
    const world=R.validate(input.world);
    let result;
    if (mode==='capture') result=W.capture(world,reference,opt.as);
    else if (mode==='apply') result=W.apply(world,read(reference),{validate:R.validate});
    else if (mode==='stamp') result=W.stamp(world,reference,opt.as,opt.args?args():{});
    else if (mode==='remix') result=W.remix(world,reference,opt.as,opt.edits?read(opt.edits):[]);
    else if (mode==='history') result=W.history.generate(world,read(reference));
    else throw Error('Use scene apply|stamp|remix|capture|history|promote');
    R.validate(result.world);
    respond(opt['dry-run']?{changed:result.paths,...(result.events?{events:result.events}:{})}:result.world);
  }
  function execute(command,pos) {
    const [file,name] = pos;
    switch (command) {
      case 'inspect': {
        const query=view(file), where=opt.where?parse(opt.where):undefined;
        respond(opt.near?query.spatial({point:numbers(opt.near),radius:Number(opt.radius),where}):query.inspect({where}));
        break;
      }
      case 'probe':
        ensure(typeof opt.field==='string','Use --field to select a query');
        respond(view(file).probe(opt.field,target(opt),args()));
        break;
      case 'trace':
        ensure(typeof name==='string','Supply a named trace');
        respond(view(file).trace(name,target(opt),args()));
        break;
      case 'field': {
        ensure(typeof name==='string'&&typeof opt.spec==='string','Provide a field and --spec file.json');
        const spec=read(opt.spec);
        if (spec.ticks) {
          const run=runtime(load(file));
          schedule(run);
          ensure(Array.isArray(spec.ticks)&&spec.ticks.length<=10000,'Invalid sample ticks');
          const ticks=spec.ticks.slice().sort((a,b)=>a-b);
          if (spec.spatial) {
            const samples=[], limit=100000;
            let count=0;
            for(const tick of ticks){
              run.advance(tick);
              const frame=run.query().export(name,spec.spatial,args());
              count+=frame.samples.length;
              ensure(count<=limit,'Time-series spatial sample budget exceeded');
              samples.push(frame);
            }
            respond({field:name,series:samples});
          } else respond({field:name,series:ticks.map(tick=>{
            run.advance(tick);
            return {tick,time:run.view().time,...run.query().probe(name,spec.at??target(opt),args())};
          })});
        } else respond(view(file).export(name,spec,args()));
        break;
      }
      case 'scene': scene(pos); break;
      case 'sim': sim(pos); break;
      default: throw Error('Unknown world command');
    }
  }
  function validate(file) {
    if(opt.world){
      const input=load(opt.world);
      ensure(input.world||input.document,'Provide a scene, world or checkpoint with --world');
      const edits=read(file);
      if(opt.kind==='edits'){
        if(input.world){
          const source=R.validate(input.world);
          W.apply(source,edits,{validate:R.validate});
        }else{
          const validator=legacyValidator(input);
          validator(input.document);
          W.apply(kit.KIT.procedural.data.freeze(W.data.copy(input.document)),edits,{validate:validator});
        }
      } else if(opt.kind==='actions') runtime(input).schedule(edits);
      else throw Error('Validation with --world needs --kind edits or actions');
      respond({valid:true,kind:opt.kind});
      return true;
    }
    if (!/\.json$/i.test(file??'')) return false;
    const raw=read(file);
    if (raw.format==='ink-studio/authoring') {
      kit.KIT.authoring.data.documentView(raw);
      respond({valid:true,format:raw.format});
      return true;
    }
    if (raw.format!==W.format && raw.format!==R.checkpointFormat && raw.format!==R.runFormat) return false;
    if (raw.format===W.format) R.validate(raw);
    else if (raw.format===R.checkpointFormat) R.create(raw.world,{checkpoint:raw});
    else R.replay(raw);
    respond({valid:true,format:raw.format});
    return true;
  }
  return {execute,validate};
};
