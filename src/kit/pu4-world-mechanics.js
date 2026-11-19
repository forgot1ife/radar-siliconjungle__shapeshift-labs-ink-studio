/* Rigid assemblies, authored joints and shared obstacle queries. */
(function (K) {
  const W=K.world, Q=W.query, V=K.V, M=K.M;
  const {check,record,own,id,vector}=W.data, {clamp}=W.fields;
  const zero=[0,0,0], up=[0,1,0];
  const spin=(rotation,omega,dt) => V.len(omega)>1e-9 ? M.mul(M.rot(V.norm(omega),V.len(omega)*dt),rotation) : rotation;
  function distance(body,point) {
    const local=M.app(M.tr(body.rotation),V.sub(point,body.position));
    const q=local.map((n,i)=>Math.abs(n)-body.half[i]);
    return Math.hypot(...q.map(n=>Math.max(n,0)))+Math.min(Math.max(...q),0);
  }
  function column(body,x,z,low,high) {
    const inv=M.tr(body.rotation), from=M.app(inv,V.sub([x,high,z],body.position)), dir=M.app(inv,[0,-1,0]);
    let start=0, end=high-low, face=-1, sign=1;
    for(let k=0;k<3;k++){
      if(Math.abs(dir[k])<1e-10){
        if(Math.abs(from[k])>body.half[k]) return null;
        continue;
      }
      const a=(-body.half[k]-from[k])/dir[k], b=(body.half[k]-from[k])/dir[k], near=Math.min(a,b);
      if(near>=start){ start=near;face=k;sign=dir[k]>0?-1:1; }
      end=Math.min(end,Math.max(a,b));
      if(end<start) return null;
    }
    if(face<0) return null;
    const normal=zero.slice();
    normal[face]=sign;
    return {y:high-start,normal:M.app(body.rotation,normal),id:body.id,material:body.material};
  }
  function extents(body) {
    return [0,1,2].map(i=>body.half.reduce((sum,n,j)=>sum+Math.abs(body.rotation[i*3+j])*n,0));
  }
  function mechanics(config) {
    const start=config.bodies??{}, jointSpecs=config.joints??{}, forceSpecs=config.forces??{};
    check([start,jointSpecs,forceSpecs].every(group=>record(group)&&Object.keys(group).length<=512&&Object.keys(group).every(id)),
      'Mechanics needs bounded body, joint and force tables');
    const initialBodies={}, initials={}, inputs={}, outputs={}, claimed=new Map(), driveOrder=[], mountOrder=[];
    for (const [key,item] of Object.entries(start)) {
      check(record(item)&&vector(item.half)&&item.half.every(n=>n>=.01)&&vector(item.position??zero)&&
        vector(item.velocity??zero)&&vector(item.angular??zero)&&Number.isFinite(item.mass??1)&&(item.mass??1)>0,
        'Invalid body ' + key);
      check(item.entity===undefined||id(item.entity),'Invalid body entity reference');
      const rotation=item.turn===undefined?M.id():M.rot(up,item.turn);
      check(rotation.every(Number.isFinite),'Invalid body rotation');
      initialBodies[key]={id:key,entity:item.entity??key,half:item.half,position:item.position??zero,
        velocity:item.velocity??zero,angular:item.angular??zero,rotation,mass:item.mass??1,fixed:!!item.fixed,
        material:item.material??'stone',look:item.look??[1,2,3,4,5,6],origin:key};
    }
    for (const [key,spec] of Object.entries(jointSpecs)) {
      check(record(spec)&&['fixed','hinge','slider','shaft'].includes(spec.kind)&&own(start,spec.child)&&
        (spec.parent===null||spec.parent===undefined||own(start,spec.parent))&&spec.parent!==spec.child&&!claimed.has(spec.child),
        'Invalid or duplicate mount ' + key);
      const {axis=up,anchor=zero,offset=zero,range=[-1000000,1000000]}=spec;
      check(vector(axis)&&V.len(axis)>1e-8&&vector(anchor)&&vector(offset)&&vector(range,2)&&range[0]<=range[1]&&
        [spec.ratio??1,spec.speed??0,spec.capacity??1e9,spec.load??0,spec.at??0].every(Number.isFinite)&&
        (spec.capacity??1)>=0&&(spec.load??0)>=0&&(spec.ratio??1)!==0&&
        (!spec.drive||own(jointSpecs,spec.drive))&&['speed','position'].includes(spec.mode??'speed'),
        'Invalid joint settings for ' + key);
      claimed.set(spec.child,key);
      initials[key]={active:true,value:clamp(spec.at??0,...range),speed:0,load:0,stalled:false};
      inputs['drive.'+key]={type:'number',default:spec.mode==='position'?spec.at??0:spec.speed??0};
      outputs['speed.'+key]='number';
      outputs['stalled.'+key]='bool';
    }
    function orderedJoints(order,dependency) {
      const done=new Set(), visiting=new Set();
      function visit(key) {
        if(done.has(key)) return;
        check(!visiting.has(key),'Mechanical connection cycle at '+key);
        visiting.add(key);
        const prior=dependency(jointSpecs[key]);
        if(prior) visit(prior);
        visiting.delete(key);
        done.add(key);
        order.push(key);
      }
      for(const key of Object.keys(jointSpecs).sort()) visit(key);
    }
    orderedJoints(driveOrder,spec=>spec.drive);
    orderedJoints(mountOrder,spec=>claimed.get(spec.parent));
    for (const [key,spec] of Object.entries(forceSpecs)) {
      check(record(spec)&&['thrust','buoyancy','wheel'].includes(spec.kind)&&own(start,spec.body)&&
        vector(spec.axis??up)&&V.len(spec.axis??up)>1e-8&&vector(spec.at??zero)&&
        Number.isFinite(spec.magnitude??1)&&(spec.magnitude??1)>=0&&
        Number.isFinite(spec.radius??.3)&&(spec.radius??.3)>0&&
        (spec.kind!=='buoyancy'||typeof spec.field==='string'),'Invalid force module '+key);
      inputs['force.'+key]={type:'number',default:spec.input??0};
    }
    check(vector(config.gravity??[0,-9.81,0])&&Number.isFinite(config.ground??0)&&
      (config.terrain===undefined||typeof config.terrain==='string')&&
      Number.isFinite(config.drag??.08)&&(config.drag??.08)>=0,'Invalid mechanical world');
    function ground(context,point) {
      const sampled=config.terrain&&context.query.probe(config.terrain,point);
      return sampled?.status==='ok'&&Number.isFinite(sampled.value)?sampled.value:config.ground??0;
    }
    function placeMounted(bodies,joints,dt,previous=bodies) {
      for (const key of mountOrder) {
        const spec=jointSpecs[key], joint=joints[key], child=bodies[spec.child], parent=bodies[spec.parent];
        if (!joint.active||!child||spec.parent&&!parent) continue;
        const axis=V.norm(spec.axis??up), parentRotation=parent?.rotation??M.id();
        const turn=['hinge','shaft'].includes(spec.kind)?M.rot(axis,joint.value):M.id();
        const offset=M.app(turn,spec.offset??zero);
        const local=V.add(spec.anchor??zero,spec.kind==='slider'?V.mad(offset,axis,joint.value):offset);
        const position=V.add(parent?.position??zero,M.app(parentRotation,local));
        const velocity=dt?V.mul(V.sub(position,previous[spec.child]?.position??child.position),1/dt):parent?.velocity??zero;
        bodies[spec.child]={...child,position,velocity,rotation:M.mul(M.mul(parentRotation,turn),initialBodies[spec.child].rotation),
          angular:V.mad(parent?.angular??zero,M.app(parentRotation,axis),['hinge','shaft'].includes(spec.kind)?joint.speed:0)};
      }
    }
    function advanceJoints(state,ctx) {
      const next={}, ratios={}, roots={}, demand={};
      for(const key of driveOrder){
        const spec=jointSpecs[key], s=state.joints[key];
        const coupled=s.active&&spec.drive&&next[spec.drive]?.active;
        const root=coupled?roots[spec.drive]:key, ratio=coupled?ratios[spec.drive]*(spec.ratio??1):1;
        check(Number.isFinite(ratio)&&Math.abs(ratio)<=1e6,'Transmission ratio exceeds its budget');
        roots[key]=root;ratios[key]=ratio;
        const staticLoad=spec.load??0, linked=spec.loadField?ctx.query.probe(spec.loadField,{entity:state.bodies[spec.child]?.entity}):null;
        const load=staticLoad+(linked?.status==='ok'&&Number.isFinite(linked.value)?Math.max(0,linked.value):0);
        demand[root]=(demand[root]??0)+(s.active?load*Math.abs(ratio):0);
        next[key]={...s,load};
      }
      for(const key of driveOrder){
        const spec=jointSpecs[key], s=next[key], root=roots[key], motor=jointSpecs[root],
          stalled=s.active&&demand[root]>(motor.capacity??1e9), [min,max]=spec.range??[-1e6,1e6];
        let speed=0;
        if(s.active&&!stalled&&spec.kind!=='fixed'){
          if(root!==key) speed=next[spec.drive].speed*(spec.ratio??1);
          else if(spec.mode==='position'){
            const limit=Math.abs(spec.speed??1);
            speed=clamp((ctx.input['drive.'+key]-s.value)/ctx.dt,-limit,limit);
          }else speed=ctx.input['drive.'+key];
        }
        const value=clamp(s.value+speed*ctx.dt,min,max);
        if(stalled&&!s.stalled) ctx.emit('machine-stall',{joint:key,load:demand[root],capacity:motor.capacity??1e9});
        next[key]={...s,value,speed:(value-s.value)/ctx.dt,stalled,networkLoad:demand[root]};
      }
      return next;
    }
    function rootsOf(bodies,joints) {
      const parents={};
      for(const key of mountOrder) {
        const joint=jointSpecs[key];
        if(joints[key].active&&own(bodies,joint.child))
          parents[joint.child]=joint.parent&&own(bodies,joint.parent)?joint.parent:null;
      }
      function root(key){
        if(!own(parents,key))return key;
        return parents[key]===null?null:root(parents[key]);
      }
      return Object.fromEntries(Object.keys(bodies).map(key=>[key,root(key)]));
    }
    const follows=Object.keys(start).filter(key=>start[key].fixed&&(start[key].follow===true||
      start[key].position===undefined&&start[key].entity!==undefined)&&!claimed.has(key));
    function follow(bodies,scene) {
      if(!follows.length)return;
      const query=Q.create({world:scene});
      for(const key of follows){
        const old=bodies[key];
        if(!old)continue;
        const pose=query.target({entity:old.entity});
        if(pose)bodies[key]={...old,position:pose.point};
        else delete bodies[key];
      }
    }
    function step(state,ctx) {
      const joints=advanceJoints(state,ctx), bodies={...state.bodies};
      follow(bodies,ctx.world);
      for(const key of mountOrder){
        const joint=jointSpecs[key];
        if(joint.parent&&!bodies[joint.parent]&&joints[key].active){
          joints[key]={...joints[key],active:false,speed:0};
          ctx.emit('support-lost',{joint:key,body:joint.child});
        }
      }
      const roots=rootsOf(bodies,joints), masses={}, force={}, torque={};
      placeMounted(bodies,joints,ctx.dt,state.bodies);
      for(const [key,body] of Object.entries(bodies)){
        const root=roots[key];
        if(root) masses[root]=(masses[root]??0)+body.mass;
      }
      for(const [key,spec] of Object.entries(forceSpecs)){
        const body=bodies[spec.body], root=roots[spec.body];
        if(!body||!root||bodies[root].fixed)continue;
        const point=V.add(body.position,M.app(body.rotation,spec.at??zero));
        let direction=M.app(body.rotation,V.norm(spec.axis??up)), input=clamp(ctx.input['force.'+key],-1,1);
        if(spec.kind==='wheel'){
          const radius=spec.radius??.3;
          if(point[1]-ground(ctx,point)>radius+.08)continue;
          direction=V.norm([direction[0],0,direction[2]],[1,0,0]);
        }
        if(spec.kind==='buoyancy'){
          const read=ctx.query.probe(spec.field,point);
          if(read.status!=='ok')continue;
          direction=up;
          input=clamp((read.value.surface-point[1])/(spec.radius??.3),0,1);
        }
        const load=V.mul(direction,(spec.magnitude??1)*input);
        force[root]=V.add(force[root]??zero,load);
        const moment=V.cross(V.sub(point,bodies[root].position),load);
        torque[root]=V.add(torque[root]??zero,spec.kind==='wheel'?[0,moment[1],0]:moment);
      }
      const drag=Math.exp(-(config.drag??.08)*ctx.dt), rootKeys=Object.keys(masses).sort();
      for(const key of rootKeys){
        const body=bodies[key];
        if(body.fixed)continue;
        const mass=masses[key], a=V.mad(config.gravity??[0,-9.81,0],force[key]??zero,1/mass);
        const inertia=mass*(body.half.reduce((sum,n)=>sum+n*n,0))*.3;
        const velocity=V.mul(V.mad(body.velocity,a,ctx.dt),drag);
        const angular=V.mul(V.mad(body.angular,torque[key]??zero,ctx.dt/Math.max(inertia,.01)),drag);
        bodies[key]={...body,velocity,angular,position:V.mad(body.position,velocity,ctx.dt),rotation:spin(body.rotation,angular,ctx.dt)};
      }
      placeMounted(bodies,joints,ctx.dt,state.bodies);
      function translateRoot(key,axis,amount,collision) {
        const body=bodies[key];
        const position=body.position.slice(), velocity=body.velocity.slice();
        position[axis]+=amount;
        if(velocity[axis]*amount<0) velocity[axis]*=collision;
        bodies[key]={...body,position,velocity};
      }
      for(const key of rootKeys){
        if(bodies[key].fixed)continue;
        let lift=0;
        for(const [child,body] of Object.entries(bodies)){
          if(roots[child]!==key)continue;
          const half=extents(body);
          const bottom=body.position[1]-half[1];
          for(const x of [-1,0,1])for(const z of [-1,0,1]){
            const point=[body.position[0]+x*half[0],bottom,body.position[2]+z*half[2]];
            lift=Math.max(lift,ground(ctx,point)-bottom);
          }
        }
        if(lift>0){
          translateRoot(key,1,lift,-.12);
          const body=bodies[key];
          bodies[key]={...body,angular:V.mul(body.angular,.86)};
        }
      }
      placeMounted(bodies,joints,ctx.dt,state.bodies);
      const keys=Object.keys(bodies).sort();
      for(let i=0;i<keys.length;i++)for(let j=i+1;j<keys.length;j++){
        const a=bodies[keys[i]], b=bodies[keys[j]], ra=roots[a.id], rb=roots[b.id];
        if(ra===rb)continue;
        const wa=ra&&!bodies[ra].fixed?1/masses[ra]:0, wb=rb&&!bodies[rb].fixed?1/masses[rb]:0;
        if(!wa&&!wb)continue;
        const ea=extents(a),eb=extents(b),delta=V.sub(b.position,a.position),
          overlap=delta.map((d,k)=>ea[k]+eb[k]-Math.abs(d));
        if(overlap.some(n=>n<=1e-6))continue;
        const axis=overlap.indexOf(Math.min(...overlap)), separation=Math.sign(delta[axis]||1)*overlap[axis]/(wa+wb);
        if(wa)translateRoot(ra,axis,-separation*wa,-.15);
        if(wb)translateRoot(rb,axis,separation*wb,-.15);
        placeMounted(bodies,joints,ctx.dt,state.bodies);
      }
      const contacts=[];
      for(const [key,spec] of Object.entries(forceSpecs)){
        if(spec.kind!=='wheel')continue;
        const body=bodies[spec.body], old=state.bodies[spec.body];
        if(!body||!old)continue;
        const at=spec.at??zero, point=V.add(body.position,M.app(body.rotation,at));
        const prev=V.add(old.position,M.app(old.rotation,at)), floor=ground(ctx,point);
        const traveled=Math.hypot(point[0]-prev[0],point[2]-prev[2]);
        if(point[1]-floor<=(spec.radius??.3)+.09&&traveled>1e-5)
          contacts.push({entity:body.entity,point:[point[0],floor,point[2]],support:'ground',material:'ground',weight:traveled,
            wheel:key});
      }
      return {bodies,joints,contacts};
    }
    function detach(state,key,ctx) {
      check(own(state.joints,key)&&state.joints[key].active,'Unknown or detached joint ' + key);
      ctx.emit('detached',{joint:key,body:jointSpecs[key].child});
      return {...state,joints:{...state.joints,[key]:{...state.joints[key],active:false,speed:0}}};
    }
    function fracture(state,{body:key,axis=0,parts=3,omit=[],impulse=zero},ctx) {
      const body=state.bodies[key];
      check(own(state.bodies,key)&&[0,1,2].includes(axis)&&Number.isSafeInteger(parts)&&parts>=2&&parts<=32&&
        body.half[axis]/parts>=.005&&Array.isArray(omit)&&omit.every(i=>Number.isSafeInteger(i)&&i>=0&&i<parts)&&
        vector(impulse)&&Object.keys(state.bodies).length+parts<=1024,'Invalid fracture command');
      const bodies={...state.bodies}, joints={...state.joints}, fragments=[];
      delete bodies[key];
      for(const [id,spec] of Object.entries(jointSpecs))if(spec.parent===key||spec.child===key)
        joints[id]={...joints[id],active:false,speed:0};
      const half=body.half.slice();
      half[axis]/=parts;
      for(let i=0;i<parts;i++){
        if(omit.includes(i))continue;
        const name=key+'.'+i, local=zero.slice();
        check(!own(bodies,name),'Fragment already exists: '+name);
        local[axis]=(2*i+1-parts)*half[axis];
        const offset=M.app(body.rotation,local);
        bodies[name]={...body,id:name,entity:name,fixed:false,half,position:V.add(body.position,offset),
          velocity:V.add(V.add(body.velocity,V.cross(body.angular,offset)),impulse),mass:body.mass/parts};
        fragments.push(name);
      }
      ctx.emit('fracture',{body:key,at:body.position,material:body.material,fragments});
      return {...state,bodies,joints};
    }
    function support(context) {
      const {state,target,args}=context;
      if(!target.point) return Q.missing('point required');
      const [x,y,z]=target.point, high=args.high??y+.5, low=args.low??y-4;
      check(Number.isFinite(low)&&Number.isFinite(high)&&low<=high,'Invalid support interval');
      const rows=Object.values(state.bodies).map(body=>column(body,x,z,low,high)).filter(row=>row&&row.normal[1]>.25);
      const floor=ground(context,target.point);
      if(floor>=low&&floor<=high)rows.push({y:floor,normal:up,id:'ground',material:'ground'});
      return Q.ok(rows.sort((a,b)=>b.y-a.y||a.id.localeCompare(b.id)));
    }
    function obstruction({state,target},excluded) {
      if(!target.point)return Q.missing('point required');
      const hits=Object.values(state.bodies).filter(body=>body.id!==excluded&&body.entity!==excluded);
      if(!hits.length)return Q.missing('no bodies','empty');
      let nearest, value=Infinity;
      for(const body of hits){
        const d=distance(body,target.point);
        if(d<value){value=d;nearest=body.id;}
      }
      return {status:'ok',value,body:nearest};
    }
    return {inputs,outputs,initial(ctx) {
      const bodies={...initialBodies}, joints={...initials};
      follow(bodies,ctx.world);
      placeMounted(bodies,joints,0);
      return {bodies,joints,contacts:[]};
    },step,validateState(state){
      check(record(state?.bodies)&&record(state.joints)&&Object.keys(state.bodies).length<=1024&&
        Object.keys(state.joints).sort().join(',')===Object.keys(jointSpecs).sort().join(',')&&
        Object.entries(state.bodies).every(([key,body])=>id(key)&&body.id===key&&vector(body.half)&&body.half.every(n=>n>0)&&
          vector(body.position)&&vector(body.velocity)&&vector(body.angular)&&vector(body.rotation,9)&&
          Number.isFinite(body.mass)&&body.mass>0)&&Object.values(state.joints).every(joint=>typeof joint.active==='boolean'&&
          Number.isFinite(joint.value)&&Number.isFinite(joint.speed)),'Invalid mechanical checkpoint');
    },checkAction(type,args){
      if(type==='detach')check(own(jointSpecs,args.joint),'Unknown joint '+args.joint);
      if(type==='impulse')check(id(args.body)&&vector(args.linear??zero)&&vector(args.angular??zero),'Invalid body impulse');
      if(type==='fracture'){
        const parts=args.parts??3, omit=args.omit??[];
        check(id(args.body)&&[0,1,2].includes(args.axis??0)&&Number.isSafeInteger(parts)&&parts>=2&&parts<=32&&
          Array.isArray(omit)&&omit.every(i=>Number.isSafeInteger(i)&&i>=0&&i<parts)&&vector(args.impulse??zero),
          'Invalid fracture command');
      }
    },pose(state,entity) {
      if(!state)return null;
      const named=state.bodies[entity];
      return (named?.entity===entity?named:Object.values(state.bodies).find(body=>body.entity===entity)) ??
        (Object.values(initialBodies).some(body=>body.entity===entity)?false:null);
    },output(state){
      const out={};
      for(const [key,joint] of Object.entries(state.joints)){
        out['speed.'+key]=joint.speed;
        out['stalled.'+key]=joint.stalled;
      }
      return out;
    },
    fields:{
      bodies:{type:'record',read:({state})=>Q.ok(state.bodies)},
      joints:{type:'record',read:({state})=>Q.ok(state.joints)},
      contacts:{type:'records',read:({state})=>Q.ok(state.contacts??[])},
      clearance:{type:'number',units:'world',read:context=>obstruction(context,context.args.exclude)},
      support:{type:'records',units:'world',read:support}
    },
    traces:{support:{run(context){
      const first=support(context);
      if(first.status!=='ok'||!first.value.length)return first;
      let body=first.value[0].id;
      const points=[first.value[0]];
      for(let i=0;i<mountOrder.length;i++){
        const joint=claimed.get(body);
        if(!joint||!context.state.joints[joint].active)break;
        const parent=jointSpecs[joint].parent;
        points.push({joint,id:parent??'world'});
        if(!parent)break;
        body=parent;
      }
      return Q.ok({status:'ok',points});
    }}},
    actions:{detach(state,{joint},ctx){return detach(state,joint,ctx);},fracture,
      impulse(state,{body,linear=zero,angular=zero},ctx){
        const target=state.bodies[body];
        check(own(state.bodies,body)&&!target.fixed&&vector(linear)&&vector(angular),'Invalid body impulse');
        ctx.emit('impulse',{body});
        return {...state,bodies:{...state.bodies,[body]:{...target,velocity:V.mad(target.velocity,linear,1/target.mass),
          angular:V.mad(target.angular,angular,1/target.mass)}}};
      }
    }};
  }
  W.runtime.register('mechanics',mechanics);
  W.mechanics=Object.freeze({distance,column});
})(KIT);
