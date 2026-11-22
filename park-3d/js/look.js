import * as THREE from 'three';

// ==================================================================
// 色調：光線、材質顏色與最後的調色（color grading），
// 數值是以參考照片的區域色彩統計（草坪亮部 / 暗部、天空、樹冠、紅土）比對後調出來的。
// ==================================================================
export const LOOK = {
  exposure: 1.28,
  sunPower: 1.7,
  sunWarm: [1.0, 0.7, 0.28], // 太陽仰角 17° 時的陽光色（金黃）
  hemiPower: 1.4,
  hemiSky: [0.66, 0.86, 1.3],
  hemiGround: [0.5, 0.45, 0.22],
  fog: [0.62, 0.74, 0.88],
  fogDensity: 0.0007,
  zenith: [0.015, 0.22, 0.8],
  horizon: [0.24, 0.6, 0.9],
  cloud: [0.72, 0.88],
  cloudLit: [1.05, 1.04, 1.02],
  cloudShade: [0.74, 0.8, 0.9],
  lawnA: [0.34, 0.41, 0.05],
  lawnB: [0.48, 0.48, 0.05],
  roughA: [0.2, 0.26, 0.045],
  roughB: [0.32, 0.32, 0.07],
  dirtA: [0.5, 0.17, 0.04],
  dirtB: [0.68, 0.29, 0.07],
  sand: [0.66, 0.6, 0.48],
  leafTint: [0.55, 0.53, 0.4],
  coreTint: [0.6, 0.62, 0.45],
  woodTint: [1, 1, 1],
  grade: {
    lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1],
    sat: 1.18, contrast: 0.25, vignette: 0.28,
    shadowTint: [0, 0, 0.015], highTint: [0, 0, 0],
  },
};

// 在 OutputPass（色調映射 + sRGB）之後，於顯示空間調色
export const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uLift: { value: new THREE.Vector3(0, 0, 0) },
    uGamma: { value: new THREE.Vector3(1, 1, 1) },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uSat: { value: 1 },
    uContrast: { value: 0 },
    uVignette: { value: 0.28 },
    uShadowTint: { value: new THREE.Vector3() },
    uHighTint: { value: new THREE.Vector3() },
    uAspect: { value: 1.78 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec3 uLift; uniform vec3 uGamma; uniform vec3 uGain;
    uniform float uSat; uniform float uContrast; uniform float uVignette; uniform float uAspect;
    uniform vec3 uShadowTint; uniform vec3 uHighTint;
    varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      // lift / gamma / gain
      c = c * uGain + uLift * (1.0 - c);
      c = pow(max(c, vec3(0.0)), 1.0 / uGamma);
      // S 曲線對比
      c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);
      // 飽和度
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSat);
      // 分離色調：暗部 / 亮部各自偏色
      float w = smoothstep(0.05, 0.85, l);
      c += uShadowTint * (1.0 - w) + uHighTint * w;
      // 暗角
      vec2 d = vUv - 0.5; d.x *= uAspect;
      c *= 1.0 - uVignette * smoothstep(0.45, 1.15, length(d));
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

const v3 = (v, a) => v.set(a[0], a[1], a[2]);
const col = (c, a) => c.setRGB(a[0], a[1], a[2]);

function merge(dst, src) {
  for (const k of Object.keys(src)) {
    if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) merge(dst[k], src[k]);
    else dst[k] = src[k];
  }
}

// 把 LOOK 套用到場景（環境光與陽光強度另由太陽仰角決定）
export function applyLook(look, ctx, patch) {
  if (patch) merge(look, patch);
  const { renderer, scene, sky, terrainU, veg, grade } = ctx;
  renderer.toneMappingExposure = look.exposure;
  col(scene.fog.color, look.fog);
  scene.fog.density = look.fogDensity;
  col(sky.uniforms.uZenith.value, look.zenith);
  col(sky.uniforms.uHorizon.value, look.horizon);
  sky.uniforms.uCloud.value.set(look.cloud[0], look.cloud[1]);
  col(sky.uniforms.uCloudLit.value, look.cloudLit);
  col(sky.uniforms.uCloudShade.value, look.cloudShade);
  if (terrainU) {
    col(terrainU.uLawnA.value, look.lawnA); col(terrainU.uLawnB.value, look.lawnB);
    col(terrainU.uRoughA.value, look.roughA); col(terrainU.uRoughB.value, look.roughB);
    col(terrainU.uDirtA.value, look.dirtA); col(terrainU.uDirtB.value, look.dirtB);
    col(terrainU.uSandC.value, look.sand);
  }
  if (veg && veg.materials) {
    col(veg.materials.leaf.color, look.leafTint);
    col(veg.materials.frond.color, look.leafTint);
    col(veg.materials.core.color, look.coreTint);
    col(veg.materials.wood.color, look.woodTint);
  }
  if (grade) {
    const g = look.grade, U = grade.uniforms;
    v3(U.uLift.value, g.lift); v3(U.uGamma.value, g.gamma); v3(U.uGain.value, g.gain);
    U.uSat.value = g.sat; U.uContrast.value = g.contrast; U.uVignette.value = g.vignette;
    v3(U.uShadowTint.value, g.shadowTint); v3(U.uHighTint.value, g.highTint);
  }
  ctx.updateSun();
}
