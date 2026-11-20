const ArtDirection = require('../src/art-direction.js');
const SkyEnvironment = require('../src/sky-environment.js');
const SceneExposure = require('../src/scene-exposure.js');
const VolumeCutouts = require('../src/volume-cutouts.js');
const WindField = require('../src/wind-field.js');
const Airflow = require('../src/airflow.js');
const CelestialTracks = require('../src/celestial-tracks.js');
const CloudField = require('../src/cloud-field.js');
const Lightning = require('../src/lightning.js');
const LiveSun = require('./live-sun.js');
const SceneOptics = require('../src/scene-optics.js');
const weatherBinding = require('./weather.js');

function resolveEnvironment(world,o,sceneTime,direction,trace = false) {
  const source = o.skyEnvironment ?? world.skyEnvironment;
  const skyTime = ArtDirection.time(direction,o.skyTime ?? sceneTime,'environment');
  const time = ArtDirection.time(direction,sceneTime);
  let clock = source ? SkyEnvironment.compile(source) : null;
  const override = o.skyTransitions !== undefined;
  if (clock && override) clock = clock.withTransitions(o.skyTransitions);
  if (!clock && override && o.skyTransitions !== false && source !== false)
    throw new TypeError('Sky transitions need a sky environment');
  const origins = trace && (clock?.transitions ?? []).map(event=>({at:event.at,kind:override ? 'override' : 'sky-environment'}));
  let conditional;
  if (source !== false && o.weatherTracks !== false && world.weatherTracks !== undefined && world.weatherTracks !== false) {
    const { KIT } = require('../index.js').load();
    const track = KIT.weather.tracks.compile(clock,world.weatherTracks);
    const state = world.weatherTrackState ?? track.sceneState(world.animationTimeline?.cues?.());
    const cues = track.transitions(state);
    if (cues.length) clock = clock.withTransitions([...clock.transitions,...cues]);
    if (trace) {
      conditional = state.firings.filter(({at})=>at<=skyTime);
      for (const {id,at} of state.firings) {
        const rule = world.weatherTracks.rules.find(entry=>entry.id===id);
        origins.push({at,kind:'conditional',id,trigger:rule.trigger});
      }
      origins.sort((a,b)=>a.at-b.at);
    }
  }
  const environment = clock?.frame(skyTime,o.skyProfiles);
  const binding = weatherBinding(world,o,source,clock);
  const weather = binding?.frame(skyTime,environment?.parameters);
  o.shotWeather?.capture?.(binding);
  const exposure = SceneExposure.settings(world.sceneExposure,o.sceneExposure);
  const cutouts = VolumeCutouts.settings(world.volumeCutouts,o.volumeCutouts)?.frame(time);
  return { source,skyTime,time,clock,environment,binding,weather,exposure,cutouts,origins,conditional };
}

function resolveWind(world,o,{weather,exposure,skyTime}) {
  const windConfig = WindField.settings(world.windField,o.windField);
  const fallbackWind = o.wind ?? weather?.wind ?? windConfig?.fallback ?? world.anim?.wind ?? (windConfig && world.volumeWind) ?? undefined;
  const weatherWindAt = o.wind == null ? weather?.windAt : undefined;
  const weatherWindHere = o.wind == null ? weather?.windHere : undefined;
  const flow = (windConfig || exposure?.wind) && WindField.create(windConfig ?? WindField.settings(true),{
    ambient: time => weatherWindAt?.(time) ?? fallbackWind,
    local:weatherWindHere,
    gust:windConfig ? weather?.gustAt : undefined, localGust:windConfig ? weather?.gustHere : undefined, exposure
  });
  const wind = Airflow.frame(flow ? flow.open(skyTime) : fallbackWind);
  const localWind = flow && (windConfig?.cover || weatherWindHere || (windConfig && weather?.gustHere) || exposure?.wind)
    ? (time,x,z,_fallback,y=0) => flow.sample(x,y,z,time) : weatherWindHere;
  const airAt = (x,y,z) => localWind ? Airflow.frame(localWind(skyTime,x,z,wind.velocity,y)) : wind;
  const windAt = flow ? flow.open : weatherWindAt;
  return { windConfig,flow,wind,localWind,airAt,windAt };
}

function resolveLighting(world,o,climate,air,direction,inspect = false) {
  const {skyTime,time,environment,cutouts} = climate, {windConfig,flow} = air;
  const celestial = CelestialTracks.settings(world.celestialTracks,o.celestialTracks)?.frame(skyTime,inspect);
  const sun = LiveSun.prepare(world.liveSun,o.liveSun,time,celestial?.sun);
  const cloudSource = o.cloudField ?? world.cloudField;
  const cloudSettings = cloudSource === false ? null :
    CloudField.shadowSettings(world.cloudShadows,o.cloudShadows,environment?.parameters);
  if (cloudSettings && !cloudSource) throw new TypeError('Cloud shadows need a cloud field');
  const cloudDisplacement = cloudSource && windConfig && windConfig.clouds !== false
    ? flow.cloudTravel(0,skyTime).map(n => n*windConfig.clouds) : undefined;
  const flash = Lightning.settings(world.lightning,o.lightning)?.frame(time);
  const clouds = cloudSource ? CloudField.compile(cloudSource).frame(skyTime,cloudSettings,
    sun?.direction ?? celestial?.sun?.direction ?? environment?.sky?.sun ?? (o.volumeLighting ?? world.volumeLighting)?.sun?.direction,
    cloudDisplacement,o.cloudRepresentation ?? world.cloudRepresentation,flash?.light,cutouts?.cloud,direction?.cloudEdge) : null;
  return { celestial,sun,flash,clouds,cloudSettings };
}

function atmosphereSources(world,o) {
  return o.atmosphere === false ? [] : [
    ...(world.atmosphere || []), ...SceneOptics.shapedVolumes(world.shapedAtmosphere,o.shapedAtmosphere)
  ];
}

module.exports = { resolveEnvironment, resolveWind, resolveLighting, atmosphereSources };
