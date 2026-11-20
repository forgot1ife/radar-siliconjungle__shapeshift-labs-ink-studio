/* Headless editing over the diorama JSON used by the CLI. */
(function (K) {
  const A = K.authoring, DIO = K.diorama;
  const { clone, freeze } = K.procedural.data;
  const modes = ['replace', 'add', 'toggle', 'remove'];
  const childrenOf = solid => Object.entries(DIO.kinds[solid.kind].need)
    .filter(([, type]) => type === 'solid').map(([key]) => key);

  function sceneIndex(scene) {
    const nodes = new Map(), byEntity = new Map(), roots = [], parts = new Map(), groups = new Map();
    function parent(kind, name) {
      const node = { key: kind + ':' + name, kind, name, children: [] };
      nodes.set(node.key, node);
      return node;
    }

    for (const name of new Set([...Object.keys(scene.parts ?? {}), ...scene.solids.map(solid => solid.part).filter(Boolean)]))
      parts.set(name, parent('part', name));
    for (const [name, node] of parts) {
      const container = parts.get(scene.parts?.[name]?.parent);
      (container?.children ?? roots).push(node);
    }
    for (const name of Object.keys(scene.groups ?? {})) {
      const node = parent('group', name);
      groups.set(name, node);
      roots.push(node);
    }

    function solidNode(solid, path, operand) {
      const key = solid.id === undefined ? 'slot:' + path.join('/') : 'solid:' + solid.id;
      const node = { key, kind: 'solid', shape: solid.kind, ...(operand && { operand }),
        name: solid.id ?? solid.kind, solid,
        children: childrenOf(solid).map(child => solidNode(solid[child], [...path, child], child)) };
      nodes.set(key, node);
      if (solid.id !== undefined) byEntity.set(solid.id, key);
      return node;
    }
    const indexedNodes = scene.solids.map((solid, i) => {
      const node = solidNode(solid, [i]);
      const owner = parts.get(solid.part) ?? groups.get(solid.group);
      (owner?.children ?? roots).push(node);
      return node;
    });
    const tree = freeze({ key: 'scene:' + scene.id, kind: 'scene', name: scene.name ?? scene.id, children: roots });
    nodes.set(tree.key, tree);

    // A preview tag identifies anonymous geometry without replacing its render ownership.
    const usedTags = new Set([...nodes.values()].flatMap(node => node.solid?.tags ?? []));
    const byTag = new Map(), preview = { ...scene, solids: scene.solids.map((solid, i) => {
      if (solid.id !== undefined) return solid;
      let tag = '@editor/' + i;
      while (usedTags.has(tag)) tag += '_';
      usedTags.add(tag);
      byTag.set(tag, indexedNodes[i].key);
      return { ...solid, tags: [...(solid.tags ?? []), tag] };
    }) };
    return { tree, nodes, byEntity, byTag, preview: freeze(preview) };
  }

  function create(source, { env, historyLimit } = {}) {
    const scene = clone(typeof source === 'string' ? JSON.parse(source) : source);
    function validate(candidate) {
      const problems = DIO.check(candidate, env);
      if (problems.some(problem => problem.level === 'error')) {
        const error = new Error(DIO.report(problems));
        error.problems = problems;
        throw error;
      }
    }
    validate(scene);
    const document = A.document({ format: A.data.format, version: A.data.version, id: scene.id,
      seed: 1, nextId: 1, entities: {}, styles: {}, environment: scene }, { historyLimit });
    const snapshot = () => document.snapshot().environment;
    document.beforeCommit(() => validate(snapshot()));

    let selection = freeze([]), indexScene, index, previewWorld, cachedPick;
    function current() {
      const scene = snapshot();
      if (scene !== indexScene || !index) {
        indexScene = scene;
        index = sceneIndex(scene);
        previewWorld = cachedPick = undefined;
      }
      return index;
    }
    function keys(value) {
      const requested = typeof value === 'string' ? [value] : value;
      if (!Array.isArray(requested) || Array.from(requested).some(key => current().nodes.get(key)?.kind !== 'solid'))
        throw new RangeError('Selection needs keys of solids in the scene tree');
      return [...new Set(requested)];
    }

    function select(requested, { mode = 'replace' } = {}) {
      if (!modes.includes(mode)) throw new RangeError('Selection mode must be replace, add, toggle or remove');
      const next = new Set(mode === 'replace' ? [] : selection);
      for (const key of keys(requested)) {
        if (mode === 'remove' || mode === 'toggle' && next.has(key)) next.delete(key);
        else next.add(key);
      }
      selection = freeze([...next]);
      return selection;
    }

    function edit(label, targets, update) {
      const selected = new Set(keys(targets).map(key => current().nodes.get(key).solid));
      if (!selected.size) return false;
      function rewrite(solid) {
        let next = selected.has(solid) ? update(solid) : solid;
        for (const field of childrenOf(solid)) {
          const child = rewrite(solid[field]);
          if (child !== solid[field]) next = { ...next, [field]: child };
        }
        return next;
      }
      const write = () => document.setEnvironment({ solids: snapshot().solids.map(rewrite) });
      if (document.pending()) write();
      else document.transact(label, write);
      return true;
    }

    function setTransform(patch, targets = selection) {
      const values = clone(patch);
      if (!values || typeof values !== 'object' || Array.isArray(values))
        throw new TypeError('A transform edit needs an object');
      if (!Object.keys(values).length) return false;
      return edit('Transform solids', targets, solid => ({ ...solid, transform: { ...solid.transform, ...values } }));
    }
    function setMaterial(material, targets = selection) {
      const value = clone(material);
      return edit('Set solid material', targets, solid => ({ ...solid, mat: value }));
    }
    function setRole(name, ramp) {
      if (!TargetSelectors.name(name)) throw new TypeError('A material role needs a name');
      const indices = clone(ramp);
      if (!Array.isArray(indices) || !indices.length) throw new TypeError('A material role needs a nonempty palette ramp');
      const write = () => document.setEnvironment({ roles: { [name]: indices } });
      if (document.pending()) write();
      else document.transact('Edit material role ' + name, write);
    }

    const build = () => DIO.build(current().preview, env);
    function pick(ray, { world, time, reconstruction, sampleWithdrawal } = {}) {
      const { byEntity, byTag } = current();
      const rendered = world ?? (previewWorld ??= build());
      const at = time ?? rendered.lookSnapshot?.time ?? 0;
      // A caller-owned world can be animated or edited in place between picks.
      if (world || !cachedPick || cachedPick.time !== at || cachedPick.reconstruction !== reconstruction ||
          cachedPick.sampleWithdrawal !== sampleWithdrawal) {
        const posed = K.reconstruction.frame(rendered, at, reconstruction ?? rendered.look?.reconstruction);
        const query = K.procedural.contributions.create(posed, { time: at, sampleWithdrawal });
        cachedPick = { time: at, reconstruction, sampleWithdrawal, query };
      }
      const result = cachedPick.query.ray(ray);
      if (world) cachedPick = undefined;
      for (const hit of [result.dominant, ...result.contributions]) {
        const target = hit?.target;
        const tag = target?.tags?.find(tag => byTag.has(tag));
        const key = tag ? byTag.get(tag) : byEntity.get(target?.entity);
        if (key) return { key, hit };
      }
      return null;
    }

    return Object.freeze({
      snapshot,
      serialize: (space = 2) => JSON.stringify(snapshot(), null, space),
      tree: () => current().tree,
      node: key => current().nodes.get(key),
      selection: () => selection,
      select,
      pick,
      selectRay(ray, { mode = 'replace', ...options } = {}) {
        const result = pick(ray, options);
        select(result ? [result.key] : [], { mode });
        return result;
      },
      setTransform,
      setMaterial,
      setRole,
      materials: () => freeze(clone(DIO.sceneMaterials(snapshot()))),
      build,
      begin: label => { document.begin(label); },
      preview() { document.preview(); return snapshot(); },
      commit: () => document.commit(),
      cancel: () => document.cancel(),
      undo: () => document.undo(),
      redo: () => document.redo(),
      history: () => document.history(),
      revision: () => document.revision(),
      onChange(listener) {
        if (typeof listener !== 'function') throw new TypeError('Scene change listener must be a function');
        return document.onChange(({ type, label, revision }) => listener({ type, label, revision, snapshot: snapshot() }));
      }
    });
  }

  A.sceneEditor = Object.freeze({ create });
})(KIT);
