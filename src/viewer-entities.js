const fs = require('node:fs');
const marker = '/* mineblind-entity-support-v2 */';
const legacy = '/* mineblind-entity-support-v1 */static supports(name){return Object.prototype.hasOwnProperty.call(n,name)}';

function supportsEntity(models, name) {
  if (!Object.prototype.hasOwnProperty.call(models, name)) return false;
  const model = models[name];
  if (!model.geometry || !model.textures) return false;
  return Object.entries(model.geometry).every(([key, geometry]) => {
    if (!model.textures[key]) return true;
    if (!Array.isArray(geometry.bones)) return false;
    const bones = new Map(geometry.bones.map(bone => [bone.name, bone]));
    if (bones.size !== geometry.bones.length) return false;
    return geometry.bones.every(bone => {
      const visited = new Set([bone.name]);
      while (bone.parent) {
        if (!bones.has(bone.parent) || visited.has(bone.parent)) return false;
        visited.add(bone.parent);
        bone = bones.get(bone.parent);
      }
      return true;
    });
  });
}

// Keep upstream's bounding-box fallback for unsupported models. Do not suppress
// errors from supported models: those still indicate real rendering failures.
function patchEntityBundle(source) {
  if (source.includes(marker)) return source;
  const support = `${marker}static supports(name){return (${supportsEntity.toString()})(n,name)}`;
  if (source.includes(legacy)) return source.replace(legacy, support);
  const constructor = 't.exports=class{constructor(t,e,i){const r=n[e];if(!r)throw new Error(`Unknown entity ${e}`);';
  const factory = 'if(t.name)try{const i=new a("1.16.4",t.name,e);';
  if (source.split(constructor).length !== 2 || source.split(factory).length !== 2) {
    throw new Error('Unsupported Prismarine Viewer bundle: entity patch signature changed');
  }
  return source.replace(constructor,
    't.exports=class{' + support + 'constructor(t,e,i){const r=n[e];if(!r)throw new Error(`Unknown entity ${e}`);')
    .replace(factory, 'if(t.name&&a.supports(t.name))try{const i=new a("1.16.4",t.name,e);');
}
function installViewerEntities() {
  const file = require.resolve('prismarine-viewer/public/index.js');
  const source = fs.readFileSync(file, 'utf8');
  const patched = patchEntityBundle(source);
  if (patched !== source) fs.writeFileSync(file, patched);
}
module.exports = { patchEntityBundle, installViewerEntities, supportsEntity };
