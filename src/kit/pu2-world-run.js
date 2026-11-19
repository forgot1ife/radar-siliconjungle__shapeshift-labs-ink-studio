/* A fixed-tick simulation host with registered systems and portable run state. */
(function (K) {
  const W = K.world, P = K.procedural, Q = W.query, freeze = P.data.freeze;
  const {check,record,id,vector,own,copy,equal,endpoint,portOf} = W.data;
  const factories = new Map();
  const clock = () => typeof performance === 'undefined' ? Date.now() : performance.now();
  const tickOK = value => Number.isSafeInteger(value) && value >= 0 && value <= 10000000;
  const ordered = value => Object.keys(value).sort();
  const checkpointFormat = 'ink-studio/checkpoint', runFormat = 'ink-studio/run';

  function register(kind, factory) {
    check(id(kind) && typeof factory === 'function' && !factories.has(kind), 'Invalid or duplicate system kind ' + kind);
    factories.set(kind,factory);
  }
  const types = {
    bool:value => typeof value === 'boolean',
    number:Number.isFinite,
    event:Array.isArray,
    vec3:value => vector(value),
    record
  };
  const defaults = {bool:false,number:0,event:[],vec3:[0,0,0],record:{}};
  function portValue(descriptor,value,name) {
    check(descriptor && types[descriptor.type]?.(value), 'Invalid value for ' + name);
    return freeze(copy(value));
  }
  function compile(world, implementations = {}) {
    const systems = {};
    const ports = {inputs:{},outputs:{}};
    for (const name of ordered(world.systems)) {
      const spec = world.systems[name], factory = own(implementations,spec.kind) ? implementations[spec.kind] : factories.get(spec.kind);
      check(name !== 'world' && id(spec.kind) && typeof factory === 'function', 'Unknown or reserved system ' + name + ' (' + spec.kind + ')');
      check(record(spec.config??{}),'Invalid config for '+name);
      const system = factory(spec.config ?? {},{world,id:name});
      check(record(system) && typeof system.initial === 'function', 'System needs an initial state: ' + name);
      for (const direction of ['inputs','outputs']) {
        for (const [key,raw] of Object.entries(system[direction] ?? {})) {
          const path = name + '/' + key;
          const descriptor = typeof raw === 'string' ? {type:raw} : raw;
          check(id(key) && record(descriptor) && own(types,descriptor.type), 'Invalid port ' + path);
          const value = portValue(descriptor,descriptor.default ?? defaults[descriptor.type],path);
          ports[direction][path] = freeze({...descriptor,default:value});
        }
      }
      for (const [key,handler] of Object.entries(system.actions ?? {}))
        check(id(key) && typeof handler === 'function', 'Invalid action ' + name + '/' + key);
      systems[name] = system;
    }
    const incoming = new Map(), edges = new Map(), indegree = new Map();
    for (const name of ordered(systems)) {
      edges.set(name,[]);
      indegree.set(name,0);
    }
    for (const raw of world.connections) {
      check(record(raw), 'Invalid connection');
      const edge={...raw,from:portOf(world,raw.from),to:portOf(world,raw.to)};
      const [from] = endpoint(edge.from), [to] = endpoint(edge.to);
      const source = ports.outputs[edge.from], target = ports.inputs[edge.to];
      check(source && target && source.type === target.type, 'Incompatible or missing ports: ' + edge.from + ' -> ' + edge.to);
      const delay = edge.delay ?? 0;
      check(Number.isSafeInteger(delay) && delay >= 0 && delay <= 3600, 'Invalid connection delay');
      check(!incoming.has(edge.to), 'More than one connection feeds ' + edge.to);
      incoming.set(edge.to,{from:edge.from,to:edge.to,delay});
      if (delay === 0 && systems[from].combinational) {
        indegree.set(to,indegree.get(to)+1);
        edges.get(from).push(to);
      }
    }
    const names = ordered(systems), ready = names.filter(name => indegree.get(name) === 0), order = [];
    for (let i=0;i<ready.length;i++) {
      const name = ready[i];
      order.push(name);
      for (const other of edges.get(name)) {
        const degree = indegree.get(other)-1;
        indegree.set(other,degree);
        if (!degree) ready.push(other);
      }
    }
    check(order.length === names.length, 'Instantaneous signal cycle; use a delay or a stateful system');
    return {world,systems,ports,incoming,order,names};
  }
  function actionCheck(raw, plan, min = 1) {
    check(record(raw) && tickOK(raw.tick) && raw.tick >= min && record(raw.args ?? {}) &&
      (raw.id === undefined || id(raw.id)), 'Invalid scheduled command or command tick');
    const [system,key] = endpoint(raw.action);
    let args = raw.args ?? {};
    if (system === 'world') {
      check(['input','patch','event'].includes(key), 'Unknown world action ' + key);
      if (key === 'input') {
        args={...args,port:portOf(plan.world,args.port)};
        check(!plan.incoming.has(args.port), 'A connected input is driven by its source: ' + args.port);
        portValue(plan.ports.inputs[args.port],args.value,args.port);
      } else if (key === 'patch') {
        check(Array.isArray(args.edits) && args.edits.length<=10000 && args.edits.every(edit =>
          record(edit)&&['set','remove','merge','test'].includes(edit.op)&&(edit.op==='remove'||own(edit,'value'))&&
          ['entities','metadata'].includes(W.data.selector(edit.path)[0])),
        'Live patches may change entities and metadata');
      } else check(id(args.kind), 'An event needs a kind');
    } else {
      check(own(plan.systems[system]?.actions,key), 'Unknown action ' + raw.action);
      plan.systems[system].checkAction?.(key,args);
    }
    return freeze(copy({...raw,args}));
  }
  function scenarioCheck(scenario,plan) {
    if (!scenario) return;
    check(record(scenario) && Array.isArray(scenario.commands ?? []) && Array.isArray(scenario.rules ?? []) &&
      (scenario.allow === undefined || Array.isArray(scenario.allow)) &&
      (scenario.start === undefined || Array.isArray(scenario.start)) &&
      (scenario.until === undefined || tickOK(scenario.until)), 'Invalid scenario specification');
    for (const name of scenario.allow ?? []) {
      const [system,action] = endpoint(name);
      check(system === 'world' ? ['input','patch','event'].includes(action) : own(plan.systems[system]?.actions,action),
        'Unknown allowed action ' + name);
    }
    const ids = new Set();
    for (const rule of scenario.rules ?? []) {
      check(record(rule) && id(rule.id) && !ids.has(rule.id) && id(rule.kind) &&
        ['score','win','fail','metric'].includes(rule.kind) &&
        (rule.kind !== 'score' || Number.isFinite(rule.value)), 'Invalid or duplicate scenario rule');
      ids.add(rule.id);
      if (rule.field !== undefined) check(typeof rule.field === 'string', 'Invalid scenario field');
      Q.condition(rule.when,{});
    }
    for (const command of scenario.commands ?? []) actionCheck(command,plan);
  }
  function prepare(source,{implementations} = {}) {
    const world = W.manifest(source), plan = compile(world,implementations);
    for (const command of world.commands) actionCheck(command,plan);
    scenarioCheck(world.scenario,plan);
    if(world.assetPacks.length)K.authoring.assetPacks.create({packs:world.assetPacks});
    check(world.history === undefined || record(world.history), 'Invalid history policy');
    if (world.history?.where !== undefined) Q.condition(world.history.where,{});
    if (world.history?.enabled !== undefined) check(typeof world.history.enabled==='boolean','History enabled must be boolean');
    if (world.history?.limit !== undefined) check(Number.isSafeInteger(world.history.limit) &&
      world.history.limit > 0 && world.history.limit <= 100000, 'History limit must be 1–100000');
    const past=world.history?.past??[];
    check(Array.isArray(past)&&past.length<=100000&&past.every(event=>record(event)&&id(event.id)&&
      id(event.kind)&&Number.isSafeInteger(event.tick)&&event.tick<0)&&new Set(past.map(row=>row.id)).size===past.length,
      'Past history needs unique IDs, event kinds and negative ticks');
    for (const [name,prefab] of Object.entries(world.prefabs)) {
      const sandbox = W.manifest({id:'prefab-check',prefabs:{[name]:prefab},assetPacks:world.assetPacks});
      const stamped = W.stamp(sandbox,name,'instance').world;
      const prefabPlan = compile(stamped,implementations);
      for (const port of Object.values(stamped.entities.instance.ports))
        check(own(prefabPlan.ports.inputs,port) || own(prefabPlan.ports.outputs,port), 'Invalid public prefab port ' + port);
    }
    return {world,plan};
  }
  const validate=(source,options)=>prepare(source,options).world;
  function create(source, {checkpoint,implementations,profile = false,validated = false} = {}) {
    let result=validated?{world:source,plan:compile(source,implementations)}:prepare(source,{implementations});
    let {world}=result;
    if (!checkpoint && world.scenario?.start?.length) {
      const edited = W.apply(world,world.scenario.start).world;
      result=prepare(edited,{implementations});
      world=result.world;
    }
    const {plan}=result;
    const {systems,ports,incoming,order,names} = plan;
    const rootInputs = Object.fromEntries(Object.entries(ports.inputs).map(([name,port]) => [name,port.default]));
    const rootOutputs = Object.fromEntries(Object.entries(ports.outputs).map(([name,port]) => [name,port.default]));
    const rootDelays = Object.fromEntries([...incoming.values()].filter(edge => edge.delay).map(edge =>
      [edge.to,Array(edge.delay).fill(rootOutputs[edge.from])]));
    const metrics = new Map();
    const scheduled = new Map();
    const added = [];
    const historyLimit = world.history?.limit ?? 10000;
    let tick = 0, states = {}, outputs = rootOutputs, manual = rootInputs, delays = rootDelays,
      history = [], dropped = 0, lastEvents = [], scenario = {status:'running',score:0,matched:{},metrics:{}};
    let currentQuery, lastSignals = {...rootInputs,...rootOutputs};

    function view(worldValue = world, statesValue = states, signals = lastSignals, tickValue = tick) {
      return Object.freeze({world:worldValue,states:statesValue,signals,tick:tickValue,time:tickValue*worldValue.dt,history,dropped});
    }
    function context(name, worldValue, statesValue, at, input, emit, query) {
      return Object.freeze({world:worldValue,query,id:name,states:statesValue,tick:at,time:at*worldValue.dt,dt:worldValue.dt,
        input,emit,random:key => P.data.hash(name+'/'+at+'/'+String(key),worldValue.seed)/4294967296});
    }
    function rootedState(value) {
      return P.data.isImmutable(value) ? value : freeze(copy(value));
    }
    function packCommands() {
      return [...scheduled.keys()].sort((a,b) => a-b).flatMap(key => scheduled.get(key));
    }
    function enqueue(commands, log) {
      check(Array.isArray(commands) && commands.length <= 100000, 'Expected a bounded command list');
      const entries = commands.map(raw => {
        const command = actionCheck(raw,plan,tick+1);
        if (log && world.scenario?.allow) check(world.scenario.allow.includes(command.action), 'Action is disabled in this scenario: ' + command.action);
        return command;
      });
      check(entries.length + packCommands().length <= 100000, 'Pending command budget exceeded');
      for (const item of entries) {
        let items = scheduled.get(item.tick);
        if (!items) scheduled.set(item.tick,items = []);
        items.push(item);
      }
      if (log) added.push(...entries);
    }
    function readOutputs(name,state,ctx,target) {
      const out = systems[name].output?.(state,ctx) ?? {};
      check(record(out) && Object.keys(out).every(key => own(ports.outputs,name+'/'+key)), 'Unknown output from ' + name);
      for (const [key,raw] of Object.entries(systems[name].outputs ?? {})) {
        const full = name+'/'+key, spec = ports.outputs[full];
        target[full] = portValue(spec,out[key] ?? spec.default,full);
      }
    }
    function currentValues(name, inputs, live, previous, delayState) {
      const values = {};
      for (const key of Object.keys(systems[name].inputs ?? {})) {
        const port = name+'/'+key, edge = incoming.get(port);
        values[key] = !edge ? inputs[port] : edge.delay ? delayState[port][0] : live[edge.from] ?? previous[edge.from];
      }
      return freeze(values);
    }
    function historyWith(events, policy) {
      if (policy?.enabled === false) return {history,dropped};
      const entries = events.filter(event => Q.condition(policy?.where,event));
      const all = [...history,...entries];
      return {history:freeze(all.slice(-historyLimit)),dropped:dropped + Math.max(0,all.length-historyLimit)};
    }
    function save() {
      return freeze({format:checkpointFormat,version:1,tick,world,states,outputs,manual,delays,history,dropped,
        signals:lastSignals,events:lastEvents,pending:packCommands(),scenario});
    }
    function restore(saved) {
      check(record(saved) && saved.format === checkpointFormat && saved.version === 1 && equal(saved.world,world) && tickOK(saved.tick),
        'Checkpoint belongs to a different world or version');
      const payload = freeze(copy(saved));
      check(record(payload.states) && equal(ordered(payload.states),names) && record(payload.scenario) &&
        Array.isArray(payload.history) && Array.isArray(payload.events) && Number.isSafeInteger(payload.dropped) && payload.dropped>=0 && Array.isArray(payload.pending),
        'Malformed checkpoint state');
      for (const [bag, schema] of [[payload.outputs,ports.outputs],[payload.manual,ports.inputs],[payload.signals,{...ports.inputs,...ports.outputs}]]) {
        check(record(bag) && equal(ordered(bag),ordered(schema)), 'Malformed checkpoint ports');
        for (const name of ordered(schema)) portValue(schema[name],bag[name],name);
      }
      check(record(payload.delays) && equal(ordered(payload.delays),ordered(rootDelays)), 'Malformed checkpoint delays');
      for (const name of ordered(rootDelays)) {
        check(Array.isArray(payload.delays[name]) && payload.delays[name].length === rootDelays[name].length,'Invalid delay buffer ' + name);
        for (const value of payload.delays[name]) portValue(ports.inputs[name],value,name);
      }
      for (const name of names) systems[name].validateState?.(payload.states[name]);
      ({tick,states,outputs,manual,delays,history,dropped,scenario,signals:lastSignals,events:lastEvents} = payload);
      enqueue(payload.pending,false);
    }
    if (checkpoint) restore(checkpoint);
    else {
      const initialQuery = Q.create(view(),systems);
      for (const name of names) states[name] = rootedState(systems[name].initial(
        context(name,world,Object.freeze({}),0,{},() => {},initialQuery)));
      states = freeze(states);
      const startQuery = Q.create(view(),systems);
      const initialOutputs = {};
      for (const name of names) readOutputs(name,states[name],context(name,world,states,0,{},() => {},startQuery),initialOutputs);
      outputs = freeze(initialOutputs);
      lastSignals = freeze({...manual,...outputs});
      const past=world.history?.enabled===false?[]:(world.history?.past??[]).filter(event=>Q.condition(world.history?.where,event));
      history=freeze(copy(past.slice(-historyLimit)));
      dropped=Math.max(0,past.length-historyLimit);
      enqueue([...world.commands,...(world.scenario?.commands ?? [])],false);
    }
    const origin = save();
    function query() {
      return currentQuery ?? (currentQuery = Q.create(view(),systems));
    }
    function evaluateScenario(nextView, events) {
      const rules = nextView.world.scenario;
      if (!rules || scenario.status !== 'running') return scenario;
      const next = {...scenario,matched:{...scenario.matched},metrics:{...scenario.metrics}};
      const now = Q.create(nextView,systems);
      for (const rule of rules.rules ?? []) {
        if (next.matched[rule.id] && rule.once !== false) continue;
        const read = rule.field === undefined ? null : now.probe(rule.field,rule.at,rule.args);
        const candidate = rule.field === undefined ? {tick:nextView.tick,time:nextView.time,events} : read.value;
        if (read && read.status !== 'ok' || !Q.condition(rule.when,candidate)) continue;
        next.matched[rule.id] = (next.matched[rule.id] ?? 0)+1;
        if (rule.kind === 'score') next.score += rule.value;
        if (rule.kind === 'metric') next.metrics[rule.id] = candidate ?? null;
        if (rule.kind === 'win' || rule.kind === 'fail') {
          next.status = rule.kind;
          next.reason = rule.id;
          break;
        }
      }
      if (next.status === 'running' && rules.until !== undefined && nextView.tick >= rules.until) {
        next.status = 'timeout';
        next.reason = 'time limit';
      }
      return freeze(next);
    }
    function step() {
      const at = tick+1, commands = scheduled.get(at) ?? [], events = [];
      check(tickOK(at),'Tick budget exceeded');
      let nextWorld = world;
      const drafts = {...states}, nextManual = {...manual};
      const makeEmit = system => (kind,detail = {}) => {
        check(id(kind) && record(detail) && events.length < 10000, 'Invalid event or per-tick event budget exceeded');
        events.push(freeze({...copy(detail),kind,system,tick:at,id:at+'.'+events.length}));
      };
      for (const item of commands) {
        const [name,key] = endpoint(item.action);
        const emit = makeEmit(name);
        if (name === 'world') {
          if (key === 'input') nextManual[item.args.port] = portValue(ports.inputs[item.args.port],item.args.value,item.args.port);
          if (key === 'patch') {
            const result = W.apply(nextWorld,item.args.edits);
            for(const edge of nextWorld.connections)
              check(portOf(nextWorld,edge.from)===portOf(result.world,edge.from)&&
                portOf(nextWorld,edge.to)===portOf(result.world,edge.to),'Live patch rebinds a connected port');
            nextWorld = result.world;
            if (result.paths.length) emit('edit',{paths:result.paths});
          }
          if (key === 'event') {
            const {kind,...detail} = item.args;
            emit(kind,detail);
          }
        } else {
          const actionQuery = Q.create(view(nextWorld,{...drafts}),systems);
          const ctx = context(name,nextWorld,Object.freeze({...drafts}),at,{},emit,actionQuery);
          drafts[name] = rootedState(systems[name].actions[key](drafts[name],item.args,ctx));
        }
      }
      const committed = freeze(drafts);
      const previousQuery = Q.create(view(nextWorld,committed),systems);
      const immediate = {}, nextStates = {}, nextOutputs = {}, observed = {}, spent = {};
      for (const name of order) {
        const system = systems[name];
        const input = currentValues(name,nextManual,immediate,outputs,delays);
        for (const [key,value] of Object.entries(input)) observed[name+'/'+key] = value;
        const ctx = context(name,nextWorld,committed,at,input,makeEmit(name),previousQuery);
        const start = profile ? clock() : 0;
        nextStates[name] = system.step ? rootedState(system.step(committed[name],ctx)) : committed[name];
        readOutputs(name,nextStates[name],ctx,nextOutputs);
        if (system.combinational) for (const key of Object.keys(system.outputs ?? {})) immediate[name+'/'+key] = nextOutputs[name+'/'+key];
        if (profile) spent[name] = clock()-start;
      }
      const nextDelays = Object.fromEntries([...incoming.values()].filter(edge => edge.delay).map(edge =>
        [edge.to,[...delays[edge.to].slice(1),nextOutputs[edge.from]]]));
      const publishedSignals = freeze({...observed,...nextOutputs});
      const memory = historyWith(events,nextWorld.history);
      const nextScenario = evaluateScenario({...view(nextWorld,freeze(nextStates),publishedSignals,at),...memory},events);
      tick = at;
      world = nextWorld;
      states = nextStates;
      outputs = freeze(nextOutputs);
      lastSignals = publishedSignals;
      manual = freeze(Object.fromEntries(Object.entries(nextManual).map(([name,value]) => [name,ports.inputs[name].type==='event'?[]:value])));
      delays = freeze(nextDelays);
      history = memory.history;
      dropped = memory.dropped;
      lastEvents = freeze(events);
      scenario = nextScenario;
      scheduled.delete(at);
      currentQuery = undefined;
      for (const [name,ms] of Object.entries(spent)) {
        const value = metrics.get(name) ?? {calls:0,ms:0,maxMs:0};
        metrics.set(name,{calls:value.calls+1,ms:value.ms+ms,maxMs:Math.max(value.maxMs,ms)});
      }
      return view();
    }
    function advance(to, {onTick,stopOnOutcome = false} = {}) {
      check(tickOK(to) && to >= tick, 'Target tick precedes current state or exceeds the run budget');
      while (tick < to && (!stopOnOutcome || scenario.status === 'running')) {
        step();
        onTick?.(view(),query());
      }
      return view();
    }
    function recording() {
      return freeze({format:runFormat,version:1,origin,commands:added.slice(),end:save()});
    }
    return Object.freeze({view,query,step,advance,
      get scenario(){return scenario;}, get history(){return history;}, get events(){return lastEvents;},
      schedule:commands => enqueue(commands,true),checkpoint:save,recording,
      commandCounts:() => {
        const all=[...origin.pending,...added];
        return {scheduled:all.length,applied:all.filter(command=>command.tick<=tick).length,pending:packCommands().length};
      },
      profile:() => Object.fromEntries(metrics),
      fork:() => create(world,{checkpoint:save(),implementations,profile,validated:true}),
      reset:() => create(origin.world,{checkpoint:origin,implementations,profile,validated:true})});
  }
  function replay(log, options) {
    check(record(log) && log.format === runFormat && log.version === 1, 'Invalid world recording');
    const run = create(log.origin.world,{...options,checkpoint:log.origin});
    run.schedule(log.commands);
    run.advance(log.end.tick);
    check(equal(run.checkpoint(),log.end),'Replay diverged at tick ' + log.end.tick);
    return run;
  }
  function diff(a,b) {
    check(a?.format === checkpointFormat && b?.format === checkpointFormat && a.tick === b.tick,
      'Simulation diff needs two checkpoints at the same tick');
    return {tick:a.tick,time:{before:a.tick*a.world.dt,after:b.tick*b.world.dt},edits:Q.keyedChanges(a,b)};
  }
  W.runtime = Object.freeze({register,validate,create,replay,diff,checkpointFormat,runFormat});
})(KIT);
