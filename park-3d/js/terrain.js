import * as THREE from 'three';
import { makeNoise2D, fbm, clamp, lerp, smoothstep } from './noise.js';

// 世界座標：公尺。相機在 +Z 端的高處，往 -Z 方向看整條草坪（與照片相同的構圖）。
export const WORLD = { minX: -260, maxX: 260, minZ: -520, maxZ: 170 };

// 步道中心線控制點 (x, z)：左下進入畫面，中段向右彎，再沿草坪左緣往遠方延伸進入樹林。
const PATH_POINTS = [
  [-10, 175], [-15, 135], [-20, 100], [-24, 66], [-27, 36], [-29, 10], [-30, -12],
  [-27, -30], [-21, -44], [-16, -58], [-15, -75], [-17, -95], [-19, -120], [-20, -150],
  [-22, -180], [-27, -210], [-35, -238], [-48, -262], [-64, -282], [-80, -300],
];

// 沙坑（橢圓 + 噪聲邊緣）
export const BUNKERS = [
  { x: -6, z: -72, rx: 8.5, rz: 2.4, rot: 0.12, depth: 0.35 },
  { x: 25.5, z: -50, rx: 7.5, rz: 2.2, rot: -0.18, depth: 0.3 },
  { x: 6, z: -175, rx: 5.5, rz: 1.8, rot: 0.3, depth: 0.3 },
];

export const PATH_WIDTH = 2.6;

// 共用 GLSL：程序化地面顏色（草坪、割草條紋、紅土落葉、沙坑）
export const GROUND_GLSL = /* glsl */ `
float gHash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float gNoise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(gHash(i), gHash(i+vec2(1.0,0.0)), u.x), mix(gHash(i+vec2(0.0,1.0)), gHash(i+vec2(1.0,1.0)), u.x), u.y);
}
float gFbm(vec2 p){ float s=0.0, a=0.5; for(int i=0;i<4;i++){ s+=a*gNoise(p); p=p*2.03+vec2(17.1,5.3); a*=0.5; } return s; }

// m.r = 修剪草坪, m.g = 紅土, m.b = 沙, m.a = 步道/磨損
vec3 groundColor(vec2 wp, vec4 m, float detail){
  float n1 = gFbm(wp*0.025);
  float n2 = gNoise(wp*0.31);
  float n3 = gNoise(wp*2.7);
  float n4 = gNoise(wp*11.0);
  // 草坪：黃綠色，夕陽下偏暖
  vec3 lawnA = vec3(0.175, 0.300, 0.028);
  vec3 lawnB = vec3(0.300, 0.360, 0.045);
  vec3 lawn = mix(lawnA, lawnB, smoothstep(0.30, 0.75, n1));
  // 割草機條紋（沿著球道方向）
  float s = fract(wp.x / 7.5 + wp.y * 0.006 + n2*0.08);
  float stripe = smoothstep(0.42, 0.5, s) - smoothstep(0.92, 1.0, s);
  lawn *= mix(1.0, 0.93 + 0.14*stripe, m.r);
  lawn *= 0.88 + 0.22*n2;
  lawn *= mix(1.0, 0.9 + 0.2*n3, detail);
  lawn *= mix(1.0, 0.9 + 0.2*n4, detail);
  // 長草區：較暗較黃
  vec3 rough = mix(vec3(0.13,0.20,0.035), vec3(0.24,0.25,0.06), smoothstep(0.2,0.8,n2*0.6+n1*0.6));
  rough *= mix(1.0, 0.8 + 0.4*n3, detail);
  float lawnW = smoothstep(0.35, 0.65, m.r + (n3-0.5)*0.25);
  vec3 grass = mix(rough, lawn, lawnW);
  // 紅土 + 落葉
  vec3 dirt = mix(vec3(0.30,0.115,0.040), vec3(0.42,0.20,0.075), smoothstep(0.2,0.8,n2));
  dirt = mix(dirt, vec3(0.36,0.25,0.10), smoothstep(0.55,0.9,n3)*0.6);
  dirt *= mix(1.0, 0.75 + 0.45*n4, detail);
  float dirtW = smoothstep(0.3, 0.7, m.g + (n2-0.5)*0.5 + (n4-0.5)*0.15*detail);
  // 草地與紅土交界有稀疏草
  vec3 c = mix(grass, dirt, dirtW);
  // 沙坑
  vec3 sand = vec3(0.62,0.55,0.43) * (0.93 + 0.1*n3) * mix(1.0, 0.92 + 0.12*n4, detail);
  float sandW = smoothstep(0.42, 0.58, m.b + (n3-0.5)*0.18);
  c = mix(c, sand, sandW);
  // 步道邊緣磨損
  c = mix(c, vec3(0.24,0.21,0.13)*(0.8+0.3*n3), clamp(m.a,0.0,1.0)*0.55);
  return c;
}
`;

export class Terrain {
  constructor(seed = 7) {
    this.noise = makeNoise2D(seed);
    this.noise2 = makeNoise2D(seed * 3 + 11);
    this.res = 1;
    this.nx = Math.round((WORLD.maxX - WORLD.minX) / this.res) + 1;
    this.nz = Math.round((WORLD.maxZ - WORLD.minZ) / this.res) + 1;
    this._buildPath();
    this._buildGrids();
  }

  // ---- 草坪邊界 ----
  pathXAt(z) {
    // 由取樣表內插出步道在 z 處的 x（步道大致單調沿 z 前進）
    const s = this.pathLUT;
    if (z >= s[0].z) return s[0].x;
    for (let i = 1; i < s.length; i++) {
      if (z >= s[i].z) {
        const t = (z - s[i - 1].z) / (s[i].z - s[i - 1].z);
        return lerp(s[i - 1].x, s[i].x, t);
      }
    }
    return s[s.length - 1].x;
  }
  lawnLeft(z) {
    const n = this.noise(z * 0.05, 3.3) * 0.8;
    if (z > -200) return this.pathXAt(z) + 2.2 + n;
    return lerp(this.pathXAt(-200) + 2.2, -6, smoothstep(-200, -300, z)) + n;
  }
  lawnRight(z) {
    const far = clamp(-z - 40, 0, 260);
    return 29 + 3 * Math.sin(z * 0.021) - far * 0.05 + this.noise(z * 0.04, 9.1) * 1.6;
  }

  baseHeight(x, z) {
    // 縱向剖面：中段最低，往遠方坡頂升高，往相機方向升高
    let P;
    if (z < -30) {
      const zc = Math.max(z, -318);
      P = 0.000112 * (zc + 30) * (zc + 30);
      if (z < -318) P -= 0.0005 * (-318 - z) * (-318 - z);
    } else {
      P = 0.00068 * (z + 30) * (z + 30);
    }
    const L = this.lawnLeft(z), R = this.lawnRight(z);
    const cv = (L + R) / 2 + 4;
    const hw = (R - L) / 2;
    const u = clamp((x - cv) / hw, -1.25, 1.25);
    let lat;
    if (u < 0) lat = 2.8 * u * u;
    else lat = 1.1 * u * u;
    // 草坪外：左側緩坡上林地、右側紅土區幾乎平坦
    if (x < L) lat += Math.min(L - x, 30) * 0.12 + Math.max(0, L - 30 - x) * 0.03;
    if (x > R) lat += Math.min(x - R, 40) * 0.035 + Math.max(0, x - R - 40) * 0.02;
    // 噪聲：草坪上平滑，林地起伏較大
    const onLawn = x > L - 4 && x < R + 2 ? 1 : 0;
    const big = fbm(this.noise, x * 0.011, z * 0.011, 3) * (onLawn ? 1.0 : 2.4);
    const small = fbm(this.noise2, x * 0.06, z * 0.06, 2) * (onLawn ? 0.18 : 0.45);
    return P + lat + big + small;
  }

  _buildPath() {
    const pts = PATH_POINTS.map(([x, z]) => new THREE.Vector3(x, 0, z));
    this.pathCurve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const len = this.pathCurve.getLength();
    const n = Math.ceil(len / 0.5);
    this.pathSamples = this.pathCurve.getSpacedPoints(n);
    this.pathLength = len;
    // z 遞減的查找表
    const lut = [];
    for (const p of this.pathSamples) {
      if (!lut.length || p.z < lut[lut.length - 1].z - 0.2) lut.push({ x: p.x, z: p.z });
    }
    this.pathLUT = lut;
  }

  _buildGrids() {
    const { nx, nz, res } = this;
    const N = nx * nz;
    const H0 = new Float32Array(N);
    for (let j = 0; j < nz; j++) {
      const z = WORLD.minZ + j * res;
      for (let i = 0; i < nx; i++) {
        const x = WORLD.minX + i * res;
        H0[j * nx + i] = this.baseHeight(x, z);
      }
    }
    this.H0 = H0;
    // 步道中心高度（沿步道平滑）
    const ps = this.pathSamples;
    const raw = ps.map((p) => this._sampleGrid(H0, p.x, p.z));
    const smooth = raw.map((_, i) => {
      let s = 0, c = 0;
      for (let k = -24; k <= 24; k++) {
        const v = raw[clamp(i + k, 0, raw.length - 1)];
        s += v; c++;
      }
      return s / c;
    });
    this.pathHeights = smooth;
    // 步道距離場
    const pathDist = new Float32Array(N).fill(99);
    const pathH = new Float32Array(N);
    const R = 7;
    for (let k = 0; k < ps.length; k++) {
      const p = ps[k];
      const ci = Math.round((p.x - WORLD.minX) / res), cj = Math.round((p.z - WORLD.minZ) / res);
      for (let dj = -R; dj <= R; dj++) {
        const j = cj + dj; if (j < 0 || j >= nz) continue;
        for (let di = -R; di <= R; di++) {
          const i = ci + di; if (i < 0 || i >= nx) continue;
          const x = WORLD.minX + i * res, z = WORLD.minZ + j * res;
          const d = Math.hypot(x - p.x, z - p.z);
          const idx = j * nx + i;
          if (d < pathDist[idx]) { pathDist[idx] = d; pathH[idx] = smooth[k]; }
        }
      }
    }
    this.pathDist = pathDist;
    // 最終高度 + 遮罩
    const H = new Float32Array(N);
    const mask = new Uint8Array(N * 4);
    for (let j = 0; j < nz; j++) {
      const z = WORLD.minZ + j * res;
      const L = this.lawnLeft(z), Rr = this.lawnRight(z);
      for (let i = 0; i < nx; i++) {
        const x = WORLD.minX + i * res;
        const idx = j * nx + i;
        let h = H0[idx];
        const pd = pathDist[idx];
        const w = 1 - smoothstep(PATH_WIDTH * 0.5 + 0.4, PATH_WIDTH * 0.5 + 4.5, pd);
        h = lerp(h, pathH[idx], w);
        const sand = this.bunkerWeight(x, z);
        h -= sand * 0.35;
        H[idx] = h;
        // 遮罩
        const n = this.noise(x * 0.08, z * 0.08);
        let lawn = smoothstep(L - 1.5, L + 1.0, x) * (1 - smoothstep(Rr - 1.0, Rr + 2.0, x + n * 1.5));
        lawn *= 1 - smoothstep(118, 135, z);
        if (z < -290) lawn *= 1 - smoothstep(-290, -330, z);
        let dirt = smoothstep(Rr - 0.5, Rr + 3.0, x + n * 2.5);
        // 左側遠處林地的林床
        dirt = Math.max(dirt, smoothstep(L - 22, L - 45, x + n * 6) * 0.45);
        // 遠方坡頂後方的樹林
        if (z < -300) dirt = Math.max(dirt, smoothstep(-300, -340, z) * 0.6);
        const worn = 1 - smoothstep(PATH_WIDTH * 0.5 + 0.1, PATH_WIDTH * 0.5 + 1.0, pd);
        mask[idx * 4 + 0] = Math.round(clamp(lawn, 0, 1) * 255);
        mask[idx * 4 + 1] = Math.round(clamp(dirt, 0, 1) * 255);
        mask[idx * 4 + 2] = Math.round(clamp(sand, 0, 1) * 255);
        mask[idx * 4 + 3] = Math.round(clamp(worn, 0, 1) * 255);
      }
    }
    this.H = H;
    this.mask = mask;
  }

  bunkerWeight(x, z) {
    let w = 0;
    for (const b of BUNKERS) {
      const dx = x - b.x, dz = z - b.z;
      const c = Math.cos(b.rot), s = Math.sin(b.rot);
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      const ang = Math.atan2(lz, lx);
      const wob = 1 + 0.16 * this.noise2(Math.cos(ang) * 1.3 + b.x, Math.sin(ang) * 1.3 + b.z);
      const r = Math.hypot(lx / b.rx, lz / b.rz) / wob;
      w = Math.max(w, 1 - smoothstep(0.82, 1.05, r));
    }
    return w;
  }

  _sampleGrid(G, x, z) {
    const fx = clamp((x - WORLD.minX) / this.res, 0, this.nx - 1.001);
    const fz = clamp((z - WORLD.minZ) / this.res, 0, this.nz - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const nx = this.nx;
    const a = G[j * nx + i], b = G[j * nx + i + 1];
    const c = G[(j + 1) * nx + i], d = G[(j + 1) * nx + i + 1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  }

  height(x, z) { return this._sampleGrid(this.H, x, z); }

  normal(x, z, out = new THREE.Vector3()) {
    const e = 0.75;
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  maskAt(x, z) {
    const i = clamp(Math.round((x - WORLD.minX) / this.res), 0, this.nx - 1);
    const j = clamp(Math.round((z - WORLD.minZ) / this.res), 0, this.nz - 1);
    const k = (j * this.nx + i) * 4;
    const m = this.mask;
    return { lawn: m[k] / 255, dirt: m[k + 1] / 255, sand: m[k + 2] / 255, path: m[k + 3] / 255 };
  }

  distToPath(x, z) { return this._sampleGrid(this.pathDist, x, z); }

  isLawn(x, z, margin = 0) {
    const L = this.lawnLeft(z), R = this.lawnRight(z);
    return x > L + margin && x < R - margin && z < 118 && z > -300;
  }

  // ---- GPU 資源 ----
  createTextures() {
    const maskTex = new THREE.DataTexture(this.mask, this.nx, this.nz, THREE.RGBAFormat, THREE.UnsignedByteType);
    maskTex.magFilter = THREE.LinearFilter;
    maskTex.minFilter = THREE.LinearFilter;
    maskTex.wrapS = maskTex.wrapT = THREE.ClampToEdgeWrapping;
    maskTex.needsUpdate = true;
    const hTex = new THREE.DataTexture(this.H, this.nx, this.nz, THREE.RedFormat, THREE.FloatType);
    hTex.magFilter = hTex.minFilter = THREE.NearestFilter;
    hTex.needsUpdate = true;
    this.maskTex = maskTex;
    this.heightTex = hTex;
    this.uniforms = {
      uMask: { value: maskTex },
      uHeight: { value: hTex },
      uWorldMin: { value: new THREE.Vector2(WORLD.minX, WORLD.minZ) },
      uWorldSize: { value: new THREE.Vector2(WORLD.maxX - WORLD.minX, WORLD.maxZ - WORLD.minZ) },
      uGridSize: { value: new THREE.Vector2(this.nx, this.nz) },
    };
    return this.uniforms;
  }

  createMesh() {
    if (!this.uniforms) this.createTextures();
    const W = WORLD.maxX - WORLD.minX, D = WORLD.maxZ - WORLD.minZ;
    const segX = 260, segZ = 345;
    const geo = new THREE.PlaneGeometry(W, D, segX, segZ);
    geo.rotateX(-Math.PI / 2);
    geo.translate((WORLD.minX + WORLD.maxX) / 2, 0, (WORLD.minZ + WORLD.maxZ) / 2);
    const pos = geo.attributes.position;
    const nrm = geo.attributes.normal;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      pos.setY(i, this.height(x, z));
      this.normal(x, z, v);
      nrm.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeBoundingSphere();
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.96, metalness: 0 });
    const U = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, U);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vWPos;
uniform sampler2D uMask; uniform vec2 uWorldMin; uniform vec2 uWorldSize;
${GROUND_GLSL}`)
        .replace('#include <map_fragment>', `
vec2 muv = (vWPos.xz - uWorldMin) / uWorldSize;
vec4 gm = texture2D(uMask, muv);
float camD = length(vWPos - cameraPosition);
float detail = 1.0 - smoothstep(25.0, 120.0, camD);
diffuseColor.rgb = groundColor(vWPos.xz, gm, detail);
`);
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'terrain';
    return mesh;
  }

  createPathMesh() {
    const ps = this.pathSamples;
    const n = ps.length;
    const positions = new Float32Array(n * 3 * 3);
    const uvs = new Float32Array(n * 3 * 2);
    const indices = [];
    const half = PATH_WIDTH / 2;
    let along = 0;
    for (let k = 0; k < n; k++) {
      const p = ps[k];
      const a = ps[Math.max(0, k - 1)], b = ps[Math.min(n - 1, k + 1)];
      let tx = b.x - a.x, tz = b.z - a.z;
      const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const nx = -tz, nz = tx;
      if (k > 0) along += Math.hypot(p.x - ps[k - 1].x, p.z - ps[k - 1].z);
      const hc = this.height(p.x, p.z);
      for (let s = 0; s < 3; s++) {
        const o = (s - 1) * half;
        const x = p.x + nx * o, z = p.z + nz * o;
        const y = Math.max(this.height(x, z), hc - 0.05) + 0.045;
        const vi = k * 3 + s;
        positions[vi * 3] = x; positions[vi * 3 + 1] = y; positions[vi * 3 + 2] = z;
        uvs[vi * 2] = s / 2; uvs[vi * 2 + 1] = along / PATH_WIDTH;
      }
      if (k < n - 1) {
        for (let s = 0; s < 2; s++) {
          const a0 = k * 3 + s, a1 = a0 + 1, b0 = a0 + 3, b1 = b0 + 1;
          indices.push(a0, b0, a1, a1, b0, b1);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    // 程序化水泥紋理
    const c = document.createElement('canvas');
    c.width = 128; c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = '#9d988d'; g.fillRect(0, 0, 128, 512);
    const img = g.getImageData(0, 0, 128, 512);
    for (let i = 0; i < img.data.length; i += 4) {
      const px = (i / 4) % 128;
      const edge = Math.min(px, 127 - px) < 6 ? 0.82 : 1;
      const v = (0.86 + Math.random() * 0.22) * edge;
      img.data[i] *= v; img.data[i + 1] *= v; img.data[i + 2] *= v * 0.98;
    }
    g.putImageData(img, 0, 0);
    // 伸縮縫與汙漬
    g.strokeStyle = 'rgba(60,55,45,0.35)'; g.lineWidth = 2;
    for (let y = 0; y < 512; y += 128) { g.beginPath(); g.moveTo(0, y); g.lineTo(128, y); g.stroke(); }
    for (let k = 0; k < 40; k++) {
      g.fillStyle = `rgba(70,65,50,${0.04 + Math.random() * 0.06})`;
      g.beginPath(); g.ellipse(Math.random() * 128, Math.random() * 512, 6 + Math.random() * 20, 6 + Math.random() * 30, 0, 0, Math.PI * 2); g.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.ClampToEdgeWrapping; tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 0.25);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, color: 0xd9d3c6 });
    mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -2;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'path';
    return mesh;
  }

  // 在步道上取一點：t ∈ [0,1]，回傳位置與切線
  pathPoint(t, out = { x: 0, z: 0, tx: 0, tz: 0 }) {
    const ps = this.pathSamples;
    const f = clamp(t, 0, 1) * (ps.length - 1);
    const i = Math.min(Math.floor(f), ps.length - 2);
    const u = f - i;
    const a = ps[i], b = ps[i + 1];
    out.x = lerp(a.x, b.x, u); out.z = lerp(a.z, b.z, u);
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    out.tx = (b.x - a.x) / l; out.tz = (b.z - a.z) / l;
    return out;
  }
}
