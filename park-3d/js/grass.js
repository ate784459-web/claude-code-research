import * as THREE from 'three';
import { GROUND_GLSL } from './terrain.js';

// 跟著相機移動的草葉區塊：草葉固定在世界座標，只在可視範圍內出現。
// 高度與地表類型由 GPU 從高度圖 / 遮罩貼圖讀取，所以不需要在 CPU 擺放。
export function createGrass(terrainUniforms, count = 160000, tile = 70) {
  const base = new THREE.BufferGeometry();
  // 一片草葉：5 個頂點（x = 寬度方向 -1..1，y = 高度 0..1）
  const pos = new Float32Array([
    -1, 0, 0, 1, 0, 0,
    -0.7, 0.45, 0, 0.7, 0.45, 0,
    0, 1, 0,
  ]);
  base.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  base.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(15).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  base.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4]);

  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.attributes.position = base.attributes.position;
  geo.attributes.normal = base.attributes.normal;
  const off = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    off[i * 4] = Math.random();
    off[i * 4 + 1] = Math.random();
    off[i * 4 + 2] = Math.random();
    off[i * 4 + 3] = Math.random();
  }
  geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 4));
  geo.instanceCount = count;

  const U = {
    ...terrainUniforms,
    uTile: { value: tile },
    uCenter: { value: new THREE.Vector2() },
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector2(0.5, 0.2) },
    uFade: { value: new THREE.Vector2(tile * 0.32, tile * 0.48) },
  };

  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aOffset;
uniform sampler2D uHeight; uniform sampler2D uMask;
uniform vec2 uWorldMin; uniform vec2 uWorldSize; uniform vec2 uGridSize;
uniform float uTile; uniform vec2 uCenter; uniform float uTime; uniform vec2 uWind; uniform vec2 uFade;
varying vec3 vGColor;
${GROUND_GLSL}
float terrainH(vec2 wp){
  vec2 g = clamp(wp - uWorldMin, vec2(0.0), uGridSize - 1.001);
  ivec2 i = ivec2(floor(g)); vec2 f = fract(g);
  float a = texelFetch(uHeight, i, 0).r;
  float b = texelFetch(uHeight, i + ivec2(1,0), 0).r;
  float c = texelFetch(uHeight, i + ivec2(0,1), 0).r;
  float d = texelFetch(uHeight, i + ivec2(1,1), 0).r;
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace('#include <begin_vertex>', `
vec2 rel = aOffset.xy * uTile;
vec2 lo = uCenter - uTile * 0.5;
vec2 wp2 = lo + mod(rel - lo, uTile);
vec4 gm = texture2D(uMask, (wp2 - uWorldMin) / uWorldSize);
float grassy = (1.0 - smoothstep(0.35, 0.65, gm.g)) * (1.0 - smoothstep(0.2, 0.45, gm.b)) * (1.0 - smoothstep(0.05, 0.3, gm.a));
float dist = distance(wp2, cameraPosition.xz);
float fade = 1.0 - smoothstep(uFade.x, uFade.y, dist);
float bladeH = mix(0.30, 0.075, gm.r) * (0.55 + 0.9 * aOffset.w) * grassy * fade;
float ang = aOffset.z * 6.2831853;
vec2 side = vec2(cos(ang), sin(ang));
float y = position.y;
float wv = position.x * 0.012 * (0.7 + aOffset.w * 0.6);
vec2 lean = vec2(sin(aOffset.w * 37.0), cos(aOffset.z * 29.0)) * 0.35;
float gust = 0.6 + 0.4 * sin(uTime * 1.9 + wp2.x * 0.35 + wp2.y * 0.21);
vec2 bend = (lean + uWind * gust * 0.9) * y * y * bladeH;
vec3 transformed = vec3(wp2.x + side.x * wv + bend.x, terrainH(wp2) + y * bladeH, wp2.y + side.y * wv + bend.y);
vGColor = groundColor(wp2, gm, 1.0) * mix(0.7, 1.35, y) * (0.85 + 0.3 * aOffset.z);
`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGColor;')
      .replace('#include <map_fragment>', 'diffuseColor.rgb = vGColor;')
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = 1.0;'));
  };
  mat.customProgramCacheKey = () => 'grass-blades';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.name = 'grass';

  const fwd = new THREE.Vector3();
  function update(camera, time, wind) {
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() > 1e-6) fwd.normalize();
    U.uCenter.value.set(camera.position.x + fwd.x * tile * 0.3, camera.position.z + fwd.z * tile * 0.3);
    U.uTime.value = time;
    U.uWind.value.set(wind.x, wind.z);
  }
  return { mesh, update, uniforms: U };
}
