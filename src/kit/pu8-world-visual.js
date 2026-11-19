/* Headless splat view of a world revision. */
(function (K) {
  const W = K.world, V = K.V, M = K.M;
  const palette = [
    0x141b28,0x292e3a,0x424657,0x626575,0x8a8994,0xb2a9a8,0xd9c9b4,
    0x263e3f,0x355953,0x4d7360,0x6a8a68,0x98a678,0xc4bb8a,
    0x173047,0x1c475b,0x226a78,0x329393,0x64b8aa,0xa9ded2,
    0x4e302a,0x815032,0xab6e3b,0xd29f55,0xf0cb7b,0xf8edd0
  ];
  function visual({makeBuilder,makeSculpt},view,query) {
    const config=view.world.visual ?? {}, region=W.fields.bounds(config.bounds ?? {min:[-5,-1,-5],max:[5,5,5]});
    const {min,max}=region, span=Math.max(max[0]-min[0],max[2]-min[2],1), resolution=config.resolution??Math.max(.08,span/100);
    W.data.check(Number.isFinite(resolution)&&resolution>=.02&&resolution<=10&&span/resolution<=256,'Render grid exceeds its sample budget');
    const B=makeBuilder(view.world.seed,config.palette??palette), S=K.sculpt(makeSculpt(B));
    const mid=min.map((n,i)=>(n+max[i])/2);
    const fields=config.fields??{}, terrain=fields.bed, water=fields.water, wear=fields.wear;
    const earth={r:[7,8,9,10,11],rf(x,y,z,ny) {
      if (ny<.4) return [19,20,21,22];
      const result=wear&&query.probe(wear,[x,y,z]);
      return result?.status==='ok'&&result.value>.18?[19,20,21,22,23]:null;
    }};
    const height=(x,z)=>{
      const result=terrain&&query.probe(terrain,[x,0,z]);
      return result?.status==='ok'?result.value:config.ground??0;
    };
    function groundDistance(x,y,z) {
      return Math.max(y-height(x,z), min[1]-y, min[0]-x, x-max[0], min[2]-z, z-max[2]);
    }
    S.implicitForm({bounds:{min,max},sd:groundDistance},earth,{res:resolution});
    let bodies=[];
    if (fields.bodies) {
      const reading=query.probe(fields.bodies);
      if (reading.status==='ok') bodies=Object.values(reading.value);
    }
    for (const entry of bodies) {
      if (!entry.half || !entry.position) continue;
      const ramp=entry.look??[1,2,3,4,5,6];
      const rotation=entry.rotation??M.id();
      const axis=[0,1,2].map(i=>[rotation[i],rotation[i+3],rotation[i+6]]);
      S.box(entry.position,entry.half,{r:ramp},{ax:axis,res:resolution*.72,
        rd:Math.min(.055,...entry.half)*.4,tag:entry.id});
    }
    for (const [id,entity] of Object.entries(view.world.entities)) {
      if (!entity.visual?.half) continue;
      const pose=query.target({entity:id}), point=pose?.point;
      if (!point) continue;
      S.box(point,entity.visual.half,{r:entity.visual.ramp??[19,20,21,22,23]}, {res:resolution*.72,tag:id});
    }
    for (const field of fields.agents??[]) {
      const reading=query.probe(field);
      if (reading.status!=='ok') continue;
      for (const agent of Object.values(reading.value)) {
        if (!agent.position || agent.mode==='dormant') continue;
        const r=agent.radius??.16, p=agent.position, face=agent.direction??[1,0,0];
        S.ball(V.add(p,[0,r*.7,0]),[r*1.27,r*.78,r*.76],{r:agent.look??[4,5,6,24]},{res:resolution*.64});
        S.ball(V.mad(V.add(p,[0,r,0]),face,r),r*.48,{r:[19,20,23]},{res:resolution*.64});
        for(const limb of agent.limbs??[]){
          const top=V.add(limb.point,[0,r*.42,0]);
          S.tube([limb.point,top],r*.18,r*.18,{r:[19,20,21,22]},{res:resolution*.6});
        }
      }
    }
    S.bake();
    if (water) {
      const wobble=(x,z)=>((Math.sin(x*9.1+z*13.7)*43758.58)%1+1)%1;
      for (let z=min[2]+resolution/2; z<max[2]; z+=resolution) for (let x=min[0]+resolution/2; x<max[0]; x+=resolution) {
        const read=query.probe(water,[x,0,z]);
        if (read.status!=='ok' || !read.value || read.value.depth < .018) continue;
        const {surface,depth,velocity}=read.value, speed=Math.hypot(...velocity);
        const glow=wobble(x,z), tint=depth>.58?14:depth>.23?15:16, color=tint+(glow<.28?1:0);
        B.disc(x,surface+.013,z,[0,1,0],resolution*.66,resolution*.16,B.P[color],1);
        if (speed>.12 && glow<.063) B.disc(x,surface+.032,z,[0,1,0],resolution*.4,resolution*.14,B.P[18],1);
      }
    }
    return B.finish({cam:config.camera??{target:[mid[0],.05,mid[2]],dist:span*1.48,yaw:.62,pitch:.8},
      radius:span,detail:30,dither:.22});
  }
  W.visual = visual;
})(KIT);
