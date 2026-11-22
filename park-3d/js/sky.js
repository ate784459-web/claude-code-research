import * as THREE from 'three';
import { makeNoise2D, fbm } from './noise.js';
import { CLOUD_MASK } from './cloudmask.js';

function maskTexture() {
  const bin = atob(CLOUD_MASK.data);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const t = new THREE.DataTexture(arr, CLOUD_MASK.w, CLOUD_MASK.h, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

// 天空穹頂：藍天漸層 + 程序化雲層 + 太陽光暈
export function createSky(sunDir) {
  const uniforms = {
    uSunDir: { value: sunDir.clone() },
    uTime: { value: 0 },
    uZenith: { value: new THREE.Color(0.02, 0.2, 0.68) },
    uHorizon: { value: new THREE.Color(0.40, 0.60, 0.84) },
    uCloudShift: { value: new THREE.Vector2(0, 0) },
    uCloud: { value: new THREE.Vector2(0.64, 0.86) },
    uCloudLit: { value: new THREE.Color(1.0, 0.98, 0.95) },
    uCloudShade: { value: new THREE.Color(0.70, 0.76, 0.86) },
    // 照片視角的雲量分佈：方向 → 照片畫面座標 → 雲量
    uMask: { value: maskTexture() },
    uPhotoVP: { value: new THREE.Matrix4() },
    uMaskOn: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main(){
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir; uniform float uTime; uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec2 uCloudShift;
      uniform vec2 uCloud; uniform vec3 uCloudLit; uniform vec3 uCloudShade;
      uniform sampler2D uMask; uniform mat4 uPhotoVP; uniform float uMaskOn;
      varying vec3 vDir;
      float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      float vn(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
        return mix(mix(h21(i),h21(i+vec2(1,0)),u.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),u.x), u.y); }
      float fbm(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<6;i++){ s+=a*vn(p); p=p*2.02+vec2(3.1,1.7); a*=0.5;} return s; }
      void main(){
        vec3 d = normalize(vDir);
        float h = clamp(d.y, 0.0, 1.0);
        vec3 sky = mix(uHorizon, uZenith, pow(h, 0.28));
        // 靠近地平線的霧白
        sky = mix(sky, uHorizon * 1.12 + vec3(0.04), (1.0 - smoothstep(0.0, 0.045, d.y)) * 0.45);
        if (d.y < 0.0) sky = uHorizon * 0.92;
        float sd = max(dot(d, normalize(uSunDir)), 0.0);
        sky += vec3(1.0, 0.75, 0.45) * (pow(sd, 6.0) * 0.18 + pow(sd, 60.0) * 0.4);
        if (d.y > 0.0) {
          vec2 uv = d.xz / (d.y + 0.12);
          vec2 q = uv * 0.55 + uCloudShift;
          // 層積雲：大片帶狀 + 細節
          float band = fbm(vec2(q.x * 0.35, q.y * 0.9));
          float detail = fbm(q * 2.3 + vec2(uTime * 0.01, 0.0));
          float c = band * 0.75 + detail * 0.45;
          float cov = smoothstep(uCloud.x, uCloud.y, c) * smoothstep(0.02, 0.35, d.y + band * 0.2);
          // 照片視角內：依照片的雲量分佈放置雲（細節仍來自噪聲）
          vec4 cp = uPhotoVP * vec4(d, 0.0);
          if (cp.w > 0.0 && uMaskOn > 0.5) {
            vec2 puv = cp.xy / cp.w * 0.5 + 0.5;
            float edge = smoothstep(-0.02, 0.01, min(min(puv.x, 1.0 - puv.x), min(puv.y, 1.0 - puv.y)));
            float m = texture2D(uMask, clamp(puv, 0.0, 1.0)).r;
            float mc = smoothstep(0.25, 0.75, m + (detail - 0.5) * 0.45);
            cov = mix(cov, mc, edge);
            c = mix(c, 0.6 + m * 0.35, edge);
          }
          // 高空卷雲：細長絲狀
          float cir = fbm(vec2(q.x * 0.8, q.y * 4.0) + 7.3);
          cov = max(cov, smoothstep(0.66, 0.88, cir) * 0.4);
          // 雲的亮暗：朝太陽側較亮、底部略灰
          float thick = smoothstep(0.55, 0.95, c);
          vec3 lit = uCloudLit * 1.25;
          vec3 shade = uCloudShade;
          vec3 cloudCol = mix(lit, shade, thick * 0.55);
          cloudCol += vec3(1.0, 0.8, 0.55) * pow(sd, 4.0) * 0.35;
          float fade = smoothstep(0.0, 0.10, d.y);
          sky = mix(sky, cloudCol, cov * fade * 0.92);
        }
        gl_FragColor = vec4(sky, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const geo = new THREE.SphereGeometry(4500, 48, 24);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  mesh.name = 'sky';
  return { mesh, uniforms };
}

// 遠山：兩層環形山脊，藍灰色帶大氣透視
export function createDistantHills(center = new THREE.Vector3(0, 0, -120)) {
  const group = new THREE.Group();
  const noise = makeNoise2D(99);
  const layers = [
    { R: 1150, base: 18, amp: 42, color: new THREE.Color(0.26, 0.34, 0.4), haze: 0.5, seed: 0 },
    { R: 2100, base: 32, amp: 75, color: new THREE.Color(0.36, 0.45, 0.56), haze: 0.66, seed: 5 },
  ];
  const hazeCol = new THREE.Color(0.62, 0.74, 0.86);
  for (const L of layers) {
    const seg = 360;
    const pos = [], col = [], idx = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const n = fbm(noise, Math.cos(a) * 3 + L.seed, Math.sin(a) * 3 + L.seed, 5);
      const ridge = L.base + L.amp * Math.max(0, n * 0.9 + 0.35);
      const x = center.x + Math.cos(a) * L.R, z = center.z + Math.sin(a) * L.R;
      pos.push(x, -60, z, x, ridge, z);
      const bottom = L.color.clone().lerp(hazeCol, Math.min(1, L.haze + 0.3));
      const top = L.color.clone().lerp(hazeCol, L.haze);
      col.push(bottom.r, bottom.g, bottom.b, top.r, top.g, top.b);
      if (i < seg) {
        const b = i * 2;
        idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = -5;
    group.add(m);
  }
  group.name = 'hills';
  return group;
}
