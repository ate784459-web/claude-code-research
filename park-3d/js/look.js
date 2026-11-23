import * as THREE from 'three';

// ==================================================================
// 色調：光線、材質顏色與最後的調色（color grading），
// 數值是以參考照片的區域色彩統計（草坪亮部 / 暗部、天空、樹冠、紅土）比對後調出來的。
// ==================================================================
export const LOOK = {
  exposure: 1.28,
  sunAzim: 180, // 太陽方位角（度，從 +X 往 +Z 量）。照片中人影往右延伸 → 太陽在左方（西）
  sunElev: 18,
  sunPower: 1.7,
  sunWarm: [1.0, 0.7, 0.28], // 太陽仰角 17° 時的陽光色（金黃）
  hemiPower: 0.7, // 天空環境貼圖之外補一點均勻的天光（照片是手機 HDR，暗部被拉亮）
  // ---- 第一輪擬真：光線 ----
  envPower: 0.2, // 天空環境貼圖（IBL）的強度
  ao: 0.8, // 環境光遮蔽的強度（0 = 關閉）
  bloom: [0.16, 0.45, 1.25], // 光暈：強度、半徑、亮度門檻（HDR）
  leafTransl: [0.45, 0.8, 4.0], // 葉片透光：背面穿透、前向散射、集中程度
  grassTransl: [0.0, 0.9, 3.0],
  atmGlow: 1.0, // 遠景朝太陽方向的金黃散射
  atm: [1 / 70, 0, 1], // 霧的高度衰減（1/m）、基準高度（m）、依波長散射強度
  hemiSky: [0.66, 0.86, 1.3],
  hemiGround: [0.5, 0.45, 0.22],
  fog: [0.62, 0.74, 0.88],
  fogDensity: 0.0007,
  zenith: [0.04, 0.36, 0.86],
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
    sat: 1.18, contrast: 0.25, vignette: 0.0, // 照片沒有暗角
    shadowTint: [0, 0, 0.015], highTint: [0, 0, 0],
  },
  // 逐通道色調曲線（輸入 → 輸出，0–255），以 16×9 方格的 RGB 分佈與照片逐格比對擬合；
  // 每段斜率至少 0.45，避免中間調被壓平
  curve: {
    knots: [0.0, 15.0, 30.0, 45.0, 60.0, 75.0, 90.0, 105.0, 120.0, 135.0, 150.0, 165.0, 180.0, 195.0, 210.0, 225.0, 240.0, 255.0],
    r: [37.6, 62.6, 80.5, 101.7, 108.4, 115.1, 121.8, 128.6, 135.3, 142.0, 148.7, 155.5, 162.2, 171.9, 187.6, 200.9, 213.0, 227.1],
    g: [37.1, 51.9, 69.2, 77.6, 86.0, 101.2, 119.2, 131.5, 138.3, 145.0, 151.8, 158.5, 165.3, 185.2, 201.7, 213.5, 222.3, 231.2],
    b: [0.0, 30.1, 56.0, 67.1, 76.9, 91.5, 105.5, 114.5, 121.2, 128.0, 134.7, 141.5, 148.2, 155.0, 161.7, 180.6, 226.0, 255.0],
  },
};

export function curveTexture(curve) {
  const data = new Uint8Array(256 * 4);
  const interp = (ys, x) => {
    const k = curve.knots;
    let i = 0;
    while (i < k.length - 2 && x > k[i + 1]) i++;
    const t = Math.min(1, Math.max(0, (x - k[i]) / (k[i + 1] - k[i])));
    return ys[i] + (ys[i + 1] - ys[i]) * t;
  };
  for (let x = 0; x < 256; x++) {
    data[x * 4] = Math.round(interp(curve.r, x));
    data[x * 4 + 1] = Math.round(interp(curve.g, x));
    data[x * 4 + 2] = Math.round(interp(curve.b, x));
    data[x * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

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
    uCurve: { value: null },
    uCurveOn: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec3 uLift; uniform vec3 uGamma; uniform vec3 uGain;
    uniform float uSat; uniform float uContrast; uniform float uVignette; uniform float uAspect;
    uniform vec3 uShadowTint; uniform vec3 uHighTint;
    uniform sampler2D uCurve; uniform float uCurveOn;
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
      c = clamp(c, 0.0, 1.0);
      // 擬合出的色調曲線（最後一步）
      vec3 cc = c * (255.0 / 256.0) + 0.5 / 256.0;
      vec3 curved = vec3(texture2D(uCurve, vec2(cc.r, 0.5)).r, texture2D(uCurve, vec2(cc.g, 0.5)).g, texture2D(uCurve, vec2(cc.b, 0.5)).b);
      c = mix(c, curved, uCurveOn);
      gl_FragColor = vec4(c, 1.0);
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
    if (look.curve) { if (U.uCurve.value) U.uCurve.value.dispose(); U.uCurve.value = curveTexture(look.curve); }
    U.uCurveOn.value = look.curve && look.curveOn !== false ? 1 : 0;
  }
  if (ctx.onApply) ctx.onApply(look);
  ctx.updateSun();
}
