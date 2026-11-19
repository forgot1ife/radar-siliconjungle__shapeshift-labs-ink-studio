/* Shared world queries for library callers, simulations and headless tools. */
(function (K) {
  const W = K.world, freeze = K.procedural.data.freeze;
  const {check,own,record,vector,copy,read,selector,equal,portOf} = W.data;
  const ok = value => ({status:'ok',value});
  const missing = (reason, status = 'unavailable') => ({status,reason});
  const sorted = object => Object.keys(object).sort();
  function condition(rule, value) {
    if (rule === undefined) return true;
    check(record(rule), 'Expected a condition');
    if (own(rule,'all') || own(rule,'any')) {
      const list = rule.all ?? rule.any;
      check(Array.isArray(list) && list.length <= 128, 'Invalid logical condition');
      const results = list.map(part => condition(part,value));
      return own(rule,'all') ? results.every(Boolean) : results.some(Boolean);
    }
    if (own(rule,'not')) return !condition(rule.not,value);
    check(Object.keys(rule).every(key => ['path','op','value'].includes(key)), 'Unknown condition property');
    const actual = rule.path === undefined ? value : read(value,selector(rule.path));
    const expected = rule.value, numeric = Number.isFinite(actual) && Number.isFinite(expected);
    switch (rule.op ?? 'eq') {
      case 'eq': return equal(actual,expected);
      case 'ne': return !equal(actual,expected);
      case 'exists': return actual !== undefined;
      case 'lt': return numeric && actual < expected;
      case 'lte': return numeric && actual <= expected;
      case 'gt': return numeric && actual > expected;
      case 'gte': return numeric && actual >= expected;
      case 'in': return Array.isArray(expected) && expected.some(item => equal(actual,item));
      default: throw Error('Unknown condition operator ' + rule.op);
    }
  }
  function create(view, systems = {}) {
    const {world, states = {}, signals = {}, tick = 0, history = [], dropped = 0} = view;
    const fields = new Map(), traces = new Map();
    const base = {world, states, signals, tick, time:view.time ?? tick * world.dt};
    const locations = new Map(), active = new Set();
    let spatialIndex;

    function location(id) {
      if (locations.has(id)) return locations.get(id);
      const entity = own(world.entities,id) && world.entities[id];
      let point = null, socketTurn = null;
      for (const system of Object.keys(systems)) {
        const pose = systems[system].pose?.(states[system],id);
        if (pose === false) { locations.set(id,null); return null; }
        if (pose) { point = pose.position ?? pose; socketTurn = pose.rotation ?? null; break; }
      }
      if (!point && entity) {
        point = entity.position ?? [0,0,0];
        const parent = entity.anchor?.entity ?? entity.parent;
        if (parent) {
          const host = location(parent);
          const origin = host&&socket(host,entity.anchor?.socket);
          if (!origin) { locations.set(id,null); return null; }
          point = K.V.add(origin,host.rotation ? K.M.app(host.rotation,point) : point);
          socketTurn = host.rotation;
        }
      }
      const pose = point ? {point,rotation:socketTurn,entity} : null;
      locations.set(id,pose);
      return pose;
    }
    function socket(pose,name) {
      if (!name) return pose.point;
      if (!own(pose.entity?.sockets,name)) return null;
      const offset = pose.entity.sockets[name];
      return K.V.add(pose.point,pose.rotation ? K.M.app(pose.rotation,offset) : offset);
    }
    function target(spec = {}) {
      if (vector(spec)) return {point:spec.slice()};
      check(record(spec), 'Expected a point or an entity selector');
      if (spec.entity !== undefined) {
        const pose = location(spec.entity);
        if (!pose) return null;
        const point = socket(pose,spec.socket);
        return point && {...spec,point};
      }
      if (spec.point !== undefined) check(vector(spec.point), 'Expected a finite XYZ point');
      return spec.point ? {...spec,point:spec.point.slice()} : spec;
    }
    function add(descriptors, system, collection, handler) {
      for (const [key,item] of Object.entries(collection ?? {})) {
        check(W.data.id(key) && record(item) && typeof item[handler] === 'function', 'Invalid query descriptor ' + key);
        const { [handler]: execute, ...description } = item;
        descriptors.set(system + '/' + key,{system,key,execute,description});
      }
    }
    add(fields,'world',{
      entity:{type:'record',read:({target:site}) => own(world.entities,site.entity) ? ok(world.entities[site.entity]) : missing('unknown entity','missing')},
      position:{type:'vec3',units:'world',read:({target:site}) => site.point ? ok(site.point) : missing('point or entity required')},
      history:{type:'records',read:({args}) => {
        const {after=-1e15,before=tick,entity,where,limit=history.length}=args;
        check(Number.isSafeInteger(after)&&Number.isSafeInteger(before)&&before>=after&&Number.isSafeInteger(limit)&&limit>=0,
          'Invalid history range or result limit');
        const events=history.filter(event=>event.tick>=after&&event.tick<=before&&
          (entity===undefined||[event.entity,event.body,event.place].includes(entity))&&condition(where,event));
        return ok({events:events.slice(0,limit),matched:events.length,dropped});
      }},
      signal:{type:'value',read:({args}) => {
        const port=typeof args.port==='string'?portOf(world,args.port):null;
        return own(signals,port)?ok(signals[port]):missing('unknown signal port');
      }}
    },'read');
    add(traces,'world',{
      signal:{run:({args}) => {
        let port = args.port;
        if (typeof port !== 'string') return missing('signal port required');
        port=portOf(world,port);
        if(!own(signals,port))return missing('unknown signal port','missing');
        const edges = new Map(world.connections.map(edge => [portOf(world,edge.to),{...edge,from:portOf(world,edge.from)}]));
        const visited = new Set(), points = [];
        while (port) {
          if (visited.has(port)) return ok({status:'cycle',port,points});
          visited.add(port);
          const edge = edges.get(port);
          points.push({port,value:signals[port] ?? null,delay:edge?.delay ?? 0});
          port = edge?.from;
        }
        return ok({status:'source',points});
      }}
    },'run');
    for (const system of sorted(systems)) {
      add(fields,system,systems[system].fields,'read');
      add(traces,system,systems[system].traces,'run');
    }
    function resolve(map,name) {
      if (map.has(name)) return map.get(name);
      const items = [...map.values()].filter(row => row.key === name);
      return items.length === 1 ? items[0] : items.length ? null : undefined;
    }
    function execute(map,name,site,args) {
      const descriptor = resolve(map,name);
      if (!descriptor) return missing(descriptor === null ? 'ambiguous name; use system/name' : 'field or trace is not exposed');
      const position = target(site);
      if (!position) return missing('unknown entity or socket','missing');
      const guard=(map===fields?'field:':'trace:')+descriptor.system+'/'+descriptor.key;
      check(active.size<32&&!active.has(guard),'Cyclic query dependency at '+guard);
      active.add(guard);
      try {
        const result=descriptor.execute({...base,query:api,system:descriptor.system,
          state:states[descriptor.system],target:position,args:args ?? {}});
        check(record(result)&&typeof result.status==='string','Invalid query result at '+guard);
        return freeze(result);
      } finally {
        active.delete(guard);
      }
    }
    function describe(map) {
      return [...map].map(([name,item]) => ({name,...item.description}));
    }
    function inspect({where} = {}) {
      const entities = sorted(world.entities).flatMap(id => {
        const row = {...world.entities[id],id};
        return condition(where,row) ? [row] : [];
      });
      return {tick,time:base.time,entities,fields:describe(fields),traces:describe(traces),systems:sorted(systems).map(id => ({
        id,...world.systems[id],inputs:systems[id].inputs ?? {},outputs:systems[id].outputs ?? {},
        actions:sorted(systems[id].actions ?? {})
      })),actions:['world/input','world/patch','world/event']};
    }
    function spatial({point,radius,where} = {}) {
      check(vector(point) && Number.isFinite(radius) && radius >= 0, 'Expected a finite spatial query');
      const size=4, at=value=>Math.floor(value/size);
      if(!spatialIndex){
        const rows=[], cells=new Map();
        for(const id of sorted(world.entities)){
          const p=location(id)?.point;
          if(!p)continue;
          const row=freeze({...world.entities[id],id,position:p});
          const key=p.map(at).join(',');
          if(!cells.has(key))cells.set(key,[]);
          cells.get(key).push(row);
          rows.push(row);
        }
        spatialIndex={rows,cells};
      }
      const low=point.map(n=>at(n-radius)), high=point.map(n=>at(n+radius));
      const count=low.reduce((n,v,i)=>n*(high[i]-v+1),1);
      let candidates=spatialIndex.rows;
      if(Number.isFinite(count)&&count<=Math.min(4096,Math.max(32,spatialIndex.rows.length))&&
        [...low,...high].every(Number.isSafeInteger)){
        candidates=[];
        for(let z=low[2];z<=high[2];z++)for(let y=low[1];y<=high[1];y++)for(let x=low[0];x<=high[0];x++)
          for(const row of spatialIndex.cells.get([x,y,z].join(','))??[])candidates.push(row);
      }
      return candidates.filter(row=>K.V.dist(point,row.position)<=radius&&condition(where,row))
        .sort((a,b)=>a.id.localeCompare(b.id));
    }
    function exportField(field, spec, args) {
      let points, grid;
      if (Array.isArray(spec.points)) points = spec.points;
      else if (spec.line) {
        const {from,to,count} = spec.line;
        check(vector(from) && vector(to) && Number.isSafeInteger(count) && count >= 2 && count <= 100000,
          'Line needs two XYZ points and 2–100000 samples');
        points = Array.from({length:count},(_,i) => from.map((value,j) => value+(to[j]-value)*i/(count-1)));
      } else {
        const {min,max,counts} = spec.grid ?? {};
        check(vector(min) && vector(max) && vector(counts) && counts.every((n,axis) => Number.isSafeInteger(n) &&
          n > 0 && min[axis] <= max[axis]) && counts.reduce((n,k) => n*k,1) <= 100000,
          'Grid needs XYZ min, max and counts within 100000 samples');
        grid = {min,max,counts,order:'x-fastest'};
        points = [];
        for (let z=0;z<counts[2];z++) for (let y=0;y<counts[1];y++) for (let x=0;x<counts[0];x++)
          points.push([x,y,z].map((index,axis) => min[axis]+(max[axis]-min[axis])*(counts[axis]===1 ? 0 : index/(counts[axis]-1))));
      }
      check(points.length <= 100000 && points.every(p => vector(p)), 'Expected a bounded list of XYZ positions');
      return {tick,time:base.time,field,units:resolve(fields,field)?.description.units ?? null,
        ...(grid ? {grid} : {}),samples:points.map(point => ({point,...api.probe(field,point,args)}))};
    }
    const api = Object.freeze({inspect,spatial,target,
      probe:(name,at,args) => execute(fields,name,at,args),
      trace:(name,at,args) => execute(traces,name,at,args),export:exportField});
    return api;
  }
  function fromScene(w, time=0) {
    if(typeof w.query==='function')return w.query(w,time);
    const descriptors={}, configs={};
    if(w.water?.mediumAt){
      configs.water={kind:'water-scene'};
      descriptors.water={fields:{water:{type:'record',units:'world',read:({target})=>{
        if(!target.point)return missing('point required');
        const medium=w.water.mediumAt(...target.point);
        return medium.kind==='water'?ok(medium):missing('point is outside the water volume','dry');
      }}}};
    }
    const graph=w.traversalGraph;
    if(graph&&typeof graph.route==='function'){
      configs.navigation={kind:'traversal-graph'};
      descriptors.navigation={traces:{route:{run:({target,args})=>{
        check((args.from||target.point)&&args.to,'Traversal graph route needs endpoints');
        const answer=graph.route(args.from??target.point,args.to,args.options);
        return ok({status:answer.ok?'ok':answer.reason,...answer});
      }}}};
    }
    const material=w.anim?.systems?.find(system=>system.sandbox&&system.sim)?.sim;
    if(material){
      configs.matter={kind:'material-sandbox'};
      descriptors.matter={fields:{material:{type:'record',read:({target})=>{
        if(!target.point)return missing('point required');
        const value=material.at(target.point);
        return value?ok(value):missing('point is outside the material grid','outside');
      }}}};
    }
    return create({world:W.manifest({id:W.data.id(w.id)?w.id:'world',systems:configs}),tick:Math.round(time*60),time},descriptors);
  }
  function keyedChanges(a,b) {
    const operations = [];
    function compare(before,after,path) {
      if (before===after) return;
      if(Array.isArray(before)&&Array.isArray(after)&&before.length===after.length){
        const budget=Math.max(1,Math.floor(after.length/4)), changed=[];
        for(let i=0;i<after.length&&changed.length<=budget;i++)
          if(!equal(before[i],after[i]))changed.push(i);
        if(changed.length<=budget){
          for(const i of changed)compare(before[i],after[i],[...path,i]);
          return;
        }
      }
      if (record(before) && record(after)) {
        for (const key of [...new Set([...Object.keys(before),...Object.keys(after)])].sort()) {
          if (!own(after,key)) operations.push({op:'remove',path:[...path,key]});
          else if (!own(before,key)) operations.push({op:'set',path:[...path,key],value:copy(after[key])});
          else compare(before[key],after[key],[...path,key]);
        }
      } else if (!equal(before,after)) operations.push({op:'set',path,value:copy(after)});
    }
    compare(a,b,[]);
    return freeze(operations);
  }
  W.query = Object.freeze({create,condition,ok,missing,fromScene,keyedChanges});
})(KIT);
