/* Composable bounded samplers, typed control blocks and terrain water. */
(function (K) {
  const W = K.world, P = K.procedural, Q = W.query;
  const {check,record,id,vector,own} = W.data;
  const clamp = (value,min,max) => Math.min(max,Math.max(min,value));
  const zone = (point,bounds) => !bounds || point.every((value,i) => value >= bounds.min[i] && value <= bounds.max[i]);
  function bounds(value, dimensions = 3) {
    check(record(value) && vector(value.min,dimensions) && vector(value.max,dimensions) &&
      value.min.every((n,i) => n <= value.max[i]), 'Invalid world bounds');
    return value;
  }
  function patchList(source,dimensions=3) {
    check(Array.isArray(source) && source.length <= 4096,'Expected a bounded list of field regions');
    for (const row of source) {
      bounds(row.bounds,dimensions);
      check(Number.isFinite(row.value),'A field region needs a finite value');
    }
    return source;
  }
  function regions(source,point,base=0) {
    let value = base;
    for (const entry of source) if (zone(point,entry.bounds)) value = entry.value;
    return value;
  }
  function scalarFields(config) {
    const entries = Object.entries(config.fields ?? {});
    check(entries.length <= 256 && entries.every(([name,spec]) => id(name) && record(spec) && Number.isFinite(spec.default ?? 0)),
      'Invalid scalar field definitions');
    const descriptors = {}, initial = {};
    for (const [name,spec] of entries) {
      initial[name] = patchList(spec.regions ?? []);
      descriptors[name] = {type:'number',units:spec.units ?? null,read:({state,target}) => {
        const point = target.point;
        return point ? Q.ok(regions(state[name],point,spec.default ?? 0)) : Q.missing('point required');
      }};
    }
    return {initial:() => initial,fields:descriptors,actions:{
      set(state,{field,region},ctx) {
        check(own(state,field),'Unknown scalar field ' + field);
        const values = patchList([...state[field],region]);
        ctx.emit('field-edit',{field,bounds:region.bounds});
        return {...state,[field]:values};
      }
    }};
  }
  function control(config) {
    const kind = config.op ?? 'pass';
    const specs = {
      pass:{inputs:{value:'number'},outputs:{value:'number'}},
      threshold:{inputs:{value:'number'},outputs:{value:'bool'}},
      sum:{inputs:{a:'number',b:'number'},outputs:{value:'number'}},
      scale:{inputs:{value:'number'},outputs:{value:'number'}},
      choose:{inputs:{enabled:'bool',a:'number',b:'number'},outputs:{value:'number'}},
      and:{inputs:{a:'bool',b:'bool'},outputs:{value:'bool'}},
      not:{inputs:{value:'bool'},outputs:{value:'bool'}},
      pulse:{inputs:{value:'bool'},outputs:{value:'event'}},
      latch:{inputs:{set:'event',reset:'event'},outputs:{value:'bool'}},
      timer:{inputs:{enabled:'bool'},outputs:{value:'number',done:'bool'}},
      hysteresis:{inputs:{value:'number'},outputs:{value:'bool'}}
    };
    check(own(specs,kind),'Unknown control operation ' + kind);
    check([config.scale??1,config.offset??0,config.threshold??0,config.low??0,config.high??1].every(Number.isFinite) &&
      (config.low??0) <= (config.high??1) && Number.isSafeInteger(config.ticks??1) && (config.ticks??1)>0,
      'Invalid control parameters');
    const {inputs,outputs} = specs[kind];
    const stateless = !['pulse','latch','timer','hysteresis'].includes(kind);
    function step(state,{input,tick}) {
      let value, done;
      switch (kind) {
        case 'pass': value = input.value; break;
        case 'threshold': value = input.value >= (config.threshold ?? 0); break;
        case 'sum': value = input.a+input.b; break;
        case 'scale': value = input.value*(config.scale??1)+(config.offset??0); break;
        case 'choose': value = input.enabled ? input.b : input.a; break;
        case 'and': value = input.a && input.b; break;
        case 'not': value = !input.value; break;
        case 'pulse': return {value:input.value && !state.last ? [{tick}] : [],last:input.value};
        case 'latch': value = input.reset.length ? false : input.set.length ? true : state.value; break;
        case 'timer':
          value = input.enabled ? Math.min(config.ticks??1,state.value+1) : 0;
          done = value >= (config.ticks??1);
          return {value,done};
        case 'hysteresis': value = state.value ? input.value > (config.low??0) : input.value >= (config.high??1); break;
      }
      return {value};
    }
    const initial = {value:outputs.value==='bool'?false:outputs.value==='event'?[]:0,...(kind==='timer'?{done:false}:{})};
    return {combinational:stateless,initial:() => initial,inputs,outputs,step,output:state =>
      Object.fromEntries(Object.keys(outputs).map(key => [key,state[key]]))};
  }
  function water(config) {
    const {width,height,cell=1,origin=[0,0]} = config;
    const [dx,dz] = Array.isArray(cell) ? cell : [cell,cell];
    check(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width>0 && height>0 && width*height<=65536 &&
      [dx,dz].every(n => Number.isFinite(n)&&n>0) && vector(origin,2),'Water needs a bounded XZ grid');
    const cellArea=dx*dz;
    const index = (x,z) => {
      const ix=Math.floor((x-origin[0])/dx), iz=Math.floor((z-origin[1])/dz);
      return ix>=0 && ix<width && iz>=0 && iz<height ? iz*width+ix : -1;
    };
    const point = i => [origin[0]+(i%width+.5)*dx,origin[1]+(Math.floor(i/width)+.5)*dz];
    const bed = patchList(config.bed ?? [],2), seed = patchList(config.initial ?? [],2);
    check([config.base??0,config.rain??0,config.drain??0,config.friction??.13].every(Number.isFinite) &&
      [config.rain??0,config.drain??0,config.friction??.13].every(n=>n>=0) &&
      seed.every(item=>item.value>=0),'Invalid water rates or initial depths');
    const gates=config.gates??{}, pumps=config.pumps??{}, sensors=config.sensors??{};
    check([gates,pumps,sensors].every(group => record(group) && Object.keys(group).length<=128 &&
      Object.keys(group).every(id)), 'Invalid water controls');
    const inputs={}, outputs={volume:'number'}, byFace=new Map(), gateInit={}, pumpInit={};
    for (const [key,spec] of Object.entries(gates)) {
      check(record(spec) && [0,1,undefined].includes(spec.axis), 'Invalid gate axis');
      bounds(spec.bounds,2);
      const value=spec.opening??0;
      check(Number.isFinite(value) && value>=0 && value<=1, 'Invalid gate opening');
      inputs['gate.'+key] = {type:'number',default:value};
      gateInit[key]=value;
      outputs['gate.'+key]='number';
    }
    for (const [key,spec] of Object.entries(pumps)) {
      check(record(spec) && vector(spec.from,2) && vector(spec.to,2) && Number.isFinite(spec.rate??0) && (spec.rate??0)>=0,
        'Invalid pump ' + key);
      check(index(...spec.from)>=0 && index(...spec.to)>=0 && index(...spec.from)!==index(...spec.to),'Pump endpoints need distinct cells');
      inputs['pump.'+key] = {type:'number',default:spec.rate??0};
      pumpInit[key]=spec.rate??0;
      outputs['pump.'+key]='number';
    }
    for (const [key,point] of Object.entries(sensors)) {
      check(vector(point,2) && index(...point)>=0,'Sensor is outside water grid: ' + key);
      outputs['depth.'+key]='number';
      outputs['flow.'+key]='number';
    }
    function matchFaces(x,z,axis,left) {
      const cache=left*2+axis;
      if (!byFace.has(cache)) byFace.set(cache,Object.keys(gates).filter(key =>
        (gates[key].axis===undefined||gates[key].axis===axis) && zone([x,z],gates[key].bounds)));
      return byFace.get(cache);
    }
    function makeSolver(withTerrain = false) {
      return P.motion.shallowWater({width,height,cell,origin,
        ...(withTerrain?{terrain:(x,z)=>regions(bed,[x,z],config.base??0),initial:(x,z)=>regions(seed,[x,z])}:{})});
    }
    const solver = makeSolver();
    function sample(state,x,z) {
      const i=index(x,z);
      if (i<0) return null;
      const depth=state.fluid.depth[i], b=state.fluid.bed[i];
      return {bed:b,depth,surface:b+depth,velocity:depth>1e-6?
        [state.fluid.mx[i]/depth,state.fluid.mz[i]/depth]:[0,0]};
    }
    function column({state,target,system}) {
      if (!target.point) return Q.missing('point required');
      const [x,,z]=target.point, hit=sample(state,x,z);
      if (!hit) return Q.missing('outside water grid','outside');
      return hit.depth>1e-6 ? Q.ok({id:system,...hit}) : {status:'dry',value:{id:system,...hit}};
    }
    function metric({state}) {
      const {depth,startVolume,added,drained,moved}=state.fluid;
      const volume=depth.reduce((a,b)=>a+b,0)*cellArea;
      return Q.ok({volume,initial:startVolume,added,drained,transferred:moved,error:volume-startVolume-added+drained});
    }
    const terrainQuery=config.obstacle;
    check(terrainQuery===undefined || typeof terrainQuery==='string','Invalid obstacle field');
    return {inputs,outputs,initial:() => ({fluid:makeSolver(true).checkpoint(),gate:gateInit,pump:pumpInit,terrain:[],manual:{}}),
      validateState(state){solver.restore(state.fluid);},
      checkAction(type,args){
        if(type==='bed')patchList([{bounds:args.bounds,value:args.height}],2);
        if(type==='gate')check(own(gates,args.gate)&&Number.isFinite(args.opening)&&args.opening>=0&&args.opening<=1,'Invalid gate command');
        if(type==='pump')check(own(pumps,args.pump)&&Number.isFinite(args.rate)&&args.rate>=0&&args.rate<=1e9,'Invalid pump command');
        if(type==='release')check(own(inputs,args.port),'Unknown water control');
      },
      fields:{
        water:{type:'record',units:'world',read:column},
        depth:{type:'number',units:'world',read:context=>{
          const entry=column(context);
          return entry.value?Q.ok(entry.value.depth):entry;
        }},
        flow:{type:'vec2',units:'world/s',read:context=>{
          const entry=column(context);
          return entry.value?Q.ok(entry.value.velocity):entry;
        }},
        bed:{type:'number',units:'world',read:context=>{
          const entry=column(context);
          return entry.value?Q.ok(entry.value.bed):entry;
        }},
        mass:{type:'record',units:'world^3',read:metric}
      },
      traces:{flow:{run:({state,target,args})=>{
        if (!target.point) return Q.missing('point required');
        const steps=args.steps??80, stride=args.stride??Math.min(dx,dz)*.45;
        check(Number.isSafeInteger(steps)&&steps>0&&steps<=10000&&Number.isFinite(stride)&&stride>0,'Invalid flow trace budget');
        const points=[], visited=new Set();
        let [x,,z]=target.point;
        for (let i=0;i<steps;i++) {
          const current=sample(state,x,z), magnitude=current?Math.hypot(...current.velocity):0;
          if (!current || current.depth<=1e-6 || magnitude<1e-8)
            return Q.ok({points,status:!current?'outside':current.depth<=1e-6?'dry':'still'});
          points.push([x,current.surface,z]);
          const next=[x+stride*current.velocity[0]/magnitude,z+stride*current.velocity[1]/magnitude];
          const cell=index(...next);
          if (cell!==index(x,z) && visited.has(cell)) return Q.ok({points,status:'loop'});
          visited.add(index(x,z));
          [x,z]=next;
        }
        return Q.ok({points,status:'budget'});
      }}},
      actions:{
        bed(state,{bounds:area,height:value},ctx) {
          check(state.terrain.length<4096,'Water terrain edit budget exceeded');
          ctx.emit('bed-edit',{bounds:area,height:value});
          return {...state,terrain:[...state.terrain,{bounds:area,value}]};
        },
        gate(state,{gate,opening},ctx) {
          ctx.emit('gate-set',{gate,opening});
          return {...state,manual:{...state.manual,['gate.'+gate]:opening}};
        },
        pump(state,{pump,rate},ctx) {
          ctx.emit('pump-set',{pump,rate});
          return {...state,manual:{...state.manual,['pump.'+pump]:rate}};
        },
        release(state,{port}) {
          const manual={...state.manual};
          delete manual[port];
          return {...state,manual};
        }
      },
      step(state,ctx) {
        solver.restore(state.fluid);
        if (state.terrain.length) solver.setTerrain((x,z,i,old)=>regions(state.terrain,[x,z],old));
        const gate={}, pump={};
        for (const key of Object.keys(gates)) gate[key]=clamp(state.manual['gate.'+key]??ctx.input['gate.'+key],0,1);
        for (const key of Object.keys(pumps)) pump[key]=clamp(state.manual['pump.'+key]??ctx.input['pump.'+key],0,1e9);
        const obstruction=new Map();
        const opening=(x,z,axis,left,right,{bed,level:levels})=>{
          let value=1;
          for (const key of matchFaces(x,z,axis,left)) value=Math.min(value,gate[key]);
          if (terrainQuery) {
            const key=left*2+axis;
            if (!obstruction.has(key)) {
              const floor=Math.max(...bed);
              const surface=Math.max(...levels), depth=surface-floor;
              const at=ctx.query.probe(terrainQuery,[x,Math.max(floor,(floor+surface)/2),z]);
              obstruction.set(key,!(depth>1e-6 && at.status==='ok' && at.value<0));
            }
            if (!obstruction.get(key)) value=0;
          }
          return value;
        };
        solver.step(ctx.dt,{rain:config.rain,drain:config.drain,friction:config.friction,
          ...(Object.keys(gates).length||terrainQuery?{opening}:{}),
          transfers:Object.entries(pumps).map(([key,spec])=>({from:index(...spec.from),to:index(...spec.to),rate:pump[key]}))});
        return {...state,gate,pump,fluid:solver.checkpoint(),terrain:[]};
      },
      output(state) {
        const out={volume:metric({state}).value.volume};
        for (const [key,p] of Object.entries(sensors)) {
          const value=sample(state,...p);
          out['depth.'+key]=value.depth;
          out['flow.'+key]=value.depth*Math.hypot(...value.velocity);
        }
        for (const [key,value] of Object.entries(state.gate)) out['gate.'+key]=value;
        for (const [key,value] of Object.entries(state.pump)) out['pump.'+key]=value;
        return out;
      }
    };
  }
  W.runtime.register('control',control);
  W.runtime.register('fields',scalarFields);
  W.runtime.register('water',water);
  W.fields = Object.freeze({zone,bounds,regions,patchList,clamp});
})(KIT);
