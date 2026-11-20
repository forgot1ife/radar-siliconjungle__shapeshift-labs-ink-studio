(function (K) {
  K.frameComposite = Object.freeze({
    prepare: FrameComposite.prepare,
    layers: (plan, world, time) => FrameComposite.layers(plan, world, time, K.poly2.text)
  });
})(KIT);
