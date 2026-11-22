import * as THREE from 'three';
import { RNG, makeNoise2D, clamp, lerp, smoothstep } from './noise.js';

// ------------------------------------------------------------------
// 幾何累加器：把所有樹幹、樹枝、葉片合併成少量的 BufferGeometry
// ------------------------------------------------------------------
class GeoBuilder {
  constructor() { this.pos = []; this.nrm = []; this.col = []; this.uv = []; this.sway = []; this.idx = []; }
  get vcount() { return this.pos.length / 3; }

  tube(p0, p1, r0, r1, seg, color, s0, s1, v0, v1) {
    const dir = new THREE.Vector3().subVectors(p1, p0).normalize();
    const ref = Math.abs(dir.y) < 0.98 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(dir, ref).normalize();
    const w = new THREE.Vector3().crossVectors(dir, u);
    const base = this.vcount;
    const n = new THREE.Vector3();
    for (let k = 0; k < 2; k++) {
      const p = k ? p1 : p0, r = k ? r1 : r0;
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        n.copy(u).multiplyScalar(Math.cos(a)).addScaledVector(w, Math.sin(a));
        this.pos.push(p.x + n.x * r, p.y + n.y * r, p.z + n.z * r);
        this.nrm.push(n.x, n.y, n.z);
        this.col.push(color.r, color.g, color.b);
        this.uv.push(i / seg, k ? v1 : v0);
        this.sway.push(k ? s1 : s0);
      }
    }
    for (let i = 0; i < seg; i++) {
      const a = base + i, b = a + 1, c = base + seg + 1 + i, d = c + 1;
      this.idx.push(a, b, c, b, d, c);
    }
  }

  card(center, ax, ay, normal, color, sway, uvRect = [0, 0, 1, 1]) {
    const base = this.vcount;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const [u0, v0, u1, v1] = uvRect;
    for (let k = 0; k < 4; k++) {
      const [sx, sy] = corners[k];
      this.pos.push(
        center.x + ax.x * sx + ay.x * sy,
        center.y + ax.y * sx + ay.y * sy,
        center.z + ax.z * sx + ay.z * sy,
      );
      this.nrm.push(normal.x, normal.y, normal.z);
      this.col.push(color.r, color.g, color.b);
      this.uv.push(sx < 0 ? u0 : u1, sy < 0 ? v0 : v1);
      this.sway.push(sway);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  blob(center, radius, scaleY, color, sway, rng, detail = 0) {
    const g = new THREE.IcosahedronGeometry(1, detail);
    const p = g.attributes.position;
    const base = this.vcount;
    const cache = new Map();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
      let k = cache.get(key);
      if (k === undefined) { k = 0.8 + rng.next() * 0.35; cache.set(key, k); }
      this.pos.push(center.x + x * radius * k, center.y + y * radius * k * scaleY, center.z + z * radius * k);
      this.nrm.push(x, y, z);
      const v = 0.85 + 0.3 * (y * 0.5 + 0.5);
      this.col.push(color.r * v, color.g * v, color.b * v);
      this.uv.push(0.5, 0.5);
      this.sway.push(sway);
      this.idx.push(base + i);
    }
    g.dispose();
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aSway', new THREE.Float32BufferAttribute(this.sway, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

// ------------------------------------------------------------------
// 程序化貼圖
// ------------------------------------------------------------------
function makeLeafTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  const rng = new RNG(42);
  const drawLeaf = (x, y, len, wid, ang, shade) => {
    g.save();
    g.translate(x, y); g.rotate(ang);
    g.beginPath();
    g.moveTo(-len / 2, 0);
    g.quadraticCurveTo(0, -wid, len / 2, 0);
    g.quadraticCurveTo(0, wid, -len / 2, 0);
    g.closePath();
    const v = Math.round(shade * 255);
    g.fillStyle = `rgb(${v},${v},${Math.round(v * 0.96)})`;
    g.fill();
    g.strokeStyle = `rgba(0,0,0,0.18)`; g.lineWidth = 0.8;
    g.beginPath(); g.moveTo(-len / 2, 0); g.lineTo(len / 2, 0); g.stroke();
    g.restore();
  };
  // 葉叢：中心密、邊緣疏
  for (let i = 0; i < 260; i++) {
    const r = Math.sqrt(rng.next()) * S * 0.46;
    const a = rng.next() * Math.PI * 2;
    const x = S / 2 + Math.cos(a) * r, y = S / 2 + Math.sin(a) * r;
    const shade = 0.74 + rng.next() * 0.26 - (r / (S * 0.5)) * 0.06;
    drawLeaf(x, y, 18 + rng.next() * 16, 6 + rng.next() * 5, rng.next() * Math.PI, shade);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function makeBarkTexture() {
  const W = 64, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#b8aea0'; g.fillRect(0, 0, W, H);
  const rng = new RNG(7);
  for (let i = 0; i < 180; i++) {
    const x = rng.next() * W, y = rng.next() * H;
    const v = rng.next();
    g.fillStyle = v < 0.5 ? `rgba(60,50,40,${0.15 + rng.next() * 0.25})` : `rgba(230,225,210,${0.1 + rng.next() * 0.2})`;
    g.fillRect(x, y, 1 + rng.next() * 3, 6 + rng.next() * 40);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeFrondTexture() {
  const W = 64, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  g.strokeStyle = '#ffffff';
  g.lineCap = 'round';
  for (let y = 4; y < H; y += 5) {
    const t = y / H;
    const len = (W / 2 - 2) * Math.sin(Math.PI * Math.min(1, t * 1.1)) ;
    g.lineWidth = 2.4;
    g.beginPath(); g.moveTo(W / 2, y); g.lineTo(W / 2 - len, y + 10); g.stroke();
    g.beginPath(); g.moveTo(W / 2, y); g.lineTo(W / 2 + len, y + 10); g.stroke();
  }
  g.lineWidth = 3; g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ------------------------------------------------------------------
// 風的頂點著色器注入（樹葉、樹枝共用）
// ------------------------------------------------------------------
export function injectWind(material, U, { flutter = false, noFlip = false } = {}) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, r) => {
    if (prev) prev(shader, r);
    shader.uniforms.uTime = U.uTime;
    shader.uniforms.uWind = U.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aSway; uniform float uTime; uniform vec2 uWind;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  float ph = position.x * 0.061 + position.z * 0.047;
  float ws = length(uWind);
  float gust = 0.55 + 0.45 * sin(uTime * 0.63 + ph * 0.7) * sin(uTime * 0.27 + ph * 0.31);
  float s2 = aSway * aSway;
  transformed.xz += uWind * s2 * (0.32 * gust + 0.10 * sin(uTime * 1.7 + ph * 2.0));
  transformed.xz += vec2(0.6, 0.4) * s2 * 0.04 * ws * sin(uTime * 2.3 + ph * 3.0);
  ${flutter ? 'transformed += normal * aSway * 0.07 * (0.3 + ws) * sin(uTime * 6.0 + position.x * 2.1 + position.y * 1.7 + position.z);' : ''}
}`);
    if (noFlip) {
      // 雙面葉片使用同一組（朝外的）法線，背面不翻轉；include 在此階段尚未展開，所以直接換掉整段 chunk
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        THREE.ShaderChunk.normal_fragment_begin.replace('float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = 1.0;'),
      );
    }
  };
  material.customProgramCacheKey = () => `wind-${flutter}-${noFlip}`;
}

function windDepthMaterial(U, map, flutter) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: map || null, alphaTest: map ? 0.35 : 0 });
  injectWind(m, U, { flutter });
  return m;
}

// ------------------------------------------------------------------
// 植被系統
// ------------------------------------------------------------------
export class Vegetation {
  constructor(terrain, opts = {}) {
    this.terrain = terrain;
    this.quality = opts.quality ?? 1;
    this.rng = new RNG(2024);
    this.noise = makeNoise2D(77);
    this.trees = [];
    this.colliders = [];
    this.eyeAnchors = [];
    this.uniforms = { uTime: { value: 0 }, uWind: { value: new THREE.Vector2(0.6, 0.2) } };
    this.group = new THREE.Group();
    this.group.name = 'vegetation';
  }

  // 依照片佈局生成樹木位置
  plan() {
    const T = this.terrain, rng = this.rng;
    const placed = [];
    const ok = (x, z, minD) => {
      for (const p of placed) {
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < Math.max(minD, p.minD) * 0.9) return false;
      }
      return true;
    };
    const add = (spec) => { placed.push(spec); return spec; };

    // ---- 依照片配準的樹（位置由照片中的樹幹位置反投影而來）----
    // 掛綠色眼球的樹、掛一對白色眼球（背面朝外）的樹
    add({ x: 35.4, z: -20.5, type: 'broad', size: 1.1, trunkH: 5, hs: 1.8, side: 'R', minD: 3 });
    add({ x: 35.5, z: -58.1, type: 'broad', size: 1.0, trunkH: 5.2, hs: 1.7, side: 'R', minD: 3 });
    // 眼球氣球（位置由照片反投影）：綠色虹膜那一對看向觀看者，上方那一對背對（照片中只看到白色背面）
    this.eyeSpots = [
      { x: 31.2, z: -19.5, h: 8.7, look: 'viewer' }, { x: 33.4, z: -19.5, h: 8.7, look: 'viewer' },
      { x: 32.2, z: -57, h: 11.2, look: 'away' }, { x: 34.6, z: -57, h: 11.2, look: 'away' },
    ];
    // 紅土區上清楚可見的一排樹幹
    for (const [x, z, h] of [[31.1, -61.3, 1.8], [35.5, -54.9, 1.85], [37.4, -40, 2.4], [41.3, -25.5, 2.3], [44.7, -18.1, 2.1], [45.4, -13.2, 2.1], [51.7, -19.6, 2.1]]) {
      add({ x, z, type: 'broad', size: rng.range(1.0, 1.15), trunkH: rng.range(5, 6.5), hs: h, side: 'R', minD: 3, tint: rng.chance(0.4) ? 0.35 : 0, dark: z > -27 });
    }
    // 照片右上角：靠近相機的高大樟樹與木棉
    add({ x: 43, z: 2, type: 'broad', size: 1.15, trunkH: 5, hs: 1.5, side: 'R', minD: 9, dark: true });
    add({ x: 40, z: 22, type: 'broad', size: 1.1, trunkH: 4.5, hs: 1.2, side: 'R', minD: 9, dark: true });
    add({ x: 44, z: 14, type: 'bare', size: 1.45, minD: 6 });
    // 前景右下的大樹冠
    // 照片右下角其實是相機正下方一棵樹的樹冠（頂端約離地 7 m）
    add({ x: 20, z: 50, type: 'broad', size: 1.3, trunkH: 0.5, hs: 0.85, minD: 10, tint: 0, side: 'R', hero: true });
    // 遠方坡頂：大王椰子、木棉、中央偏右的大樹
    add({ x: -1.9, z: -309, type: 'palm', size: 1.1, minD: 4 });
    add({ x: 17, z: -276, type: 'broad', size: 1.3, hs: 2.0, trunkH: 4, minD: 9 });
    add({ x: 16, z: -292, type: 'bare', size: 1.65, minD: 6 });
    add({ x: 34, z: -285, type: 'bare', size: 1.5, minD: 6 });
    add({ x: 54, z: -280, type: 'bare', size: 1.4, minD: 6 });
    add({ x: -61, z: -285, type: 'bare', size: 1.55, minD: 6 });
    add({ x: -32, z: -300, type: 'bare', size: 1.2, minD: 6 });
    add({ x: -21, z: -304, type: 'broad', size: 0.95, minD: 7 });
    add({ x: -28, z: -318, type: 'broad', size: 0.9, minD: 7 });
    add({ x: 32, z: -300, type: 'broad', size: 1.1, hs: 1.4, minD: 8 });
    add({ x: -38, z: -310, type: 'broad', size: 1.1, hs: 1.3, minD: 8 });
    add({ x: -48, z: -296, type: 'broad', size: 1.0, hs: 1.3, minD: 7 });
    add({ x: 9, z: -326, type: 'broad', size: 0.8, minD: 6 });

    const tryArea = (n, gen) => {
      let tries = 0, made = 0;
      while (made < n && tries < n * 40) {
        tries++;
        const s = gen();
        if (!s) continue;
        if (T.distToPath(s.x, s.z) < (s.pathClear ?? 3.2)) continue;
        if (!ok(s.x, s.z, s.minD)) continue;
        add(s); made++;
      }
    };
    const Q = this.quality;
    // 左側林帶（步道外側）
    tryArea(Math.round(230 * Q), () => {
      const z = rng.range(-300, 160);
      const L = T.lawnLeft(z);
      const depth = Math.pow(rng.next(), 1.3) * 70;
      // 照片左下：步道旁只有零星細高的樹，陽光會從樹間灑到野餐區
      if (z > -25 && depth < 16) return null;
      const x = L - 4.5 - depth;
      const near = depth < 22;
      // 照片中左側中遠處是一整片低垂的深色樹冠（看不到樹幹）
      return { x, z, type: rng.chance(0.02) ? 'bare' : 'broad', size: rng.range(0.95, 1.25), minD: near ? 7 : 9, far: !near, trunkH: z < -30 ? rng.range(1.0, 2.0) : rng.range(2.6, 4.4), side: 'L', hs: z > -30 ? rng.range(1.0, 1.2) : z > -200 ? rng.range(1.5, 1.75) : rng.range(1.2, 1.4) };
    });
    // 步道與草坪之間零星的樹（照片左下的細長樹幹）
    tryArea(Math.round(4 * Q), () => {
      const z = rng.range(-25, 40);
      const x = T.pathXAt(z) - rng.range(8, 15);
      return { x, z, type: 'slim', size: rng.range(0.9, 1.1), minD: 9, trunkH: rng.range(6, 8.5), hs: 1.2 };
    });
    // 右側紅土區：樹幹清楚的樹
    tryArea(Math.round(46 * Q), () => {
      const z = rng.range(-250, 120);
      const R = T.lawnRight(z);
      const x = R + rng.range(2.5, 24);
      return { x, z, type: 'broad', size: rng.range(0.9, 1.15), minD: 7.5, trunkH: rng.range(4.8, 6.5), tint: rng.chance(0.4) ? rng.range(0.2, 0.6) : 0, side: 'R', dark: z > -40, hs: z > -40 ? rng.range(1.9, 2.2) : z > -100 ? rng.range(2.3, 2.6) : z > -170 ? rng.range(1.45, 1.6) : rng.range(1.3, 1.5) };
    });
    // 右側後方密林
    tryArea(Math.round(150 * Q), () => {
      const z = rng.range(-320, 160);
      const R = T.lawnRight(z);
      const x = R + 38 + Math.pow(rng.next(), 1.4) * 50;
      return { x, z, type: rng.chance(0.02) ? 'bare' : 'broad', size: rng.range(0.9, 1.3), minD: 8.5, far: true, trunkH: rng.range(3, 5), tint: rng.chance(0.3) ? rng.range(0.2, 0.5) : 0, side: 'R', hs: z > -100 ? rng.range(2.2, 2.5) : z > -170 ? rng.range(1.7, 1.9) : rng.range(1.4, 1.6) };
    });
    // 坡頂後方樹林
    tryArea(Math.round(50 * Q), () => {
      const z = rng.range(-380, -315);
      const x = rng.range(-110, 110);
      if (Math.abs(x + 8) < 12) return null; // 中央留缺口看遠山（照片中棕櫚左側）
      return { x, z, type: rng.chance(0.04) ? 'bare' : 'broad', size: rng.range(0.9, 1.3), minD: 9, far: true, trunkH: rng.range(3, 5) };
    });
    // 相機後方（環繞時才看得到）
    tryArea(Math.round(50 * Q), () => {
      const z = rng.range(95, 165);
      const x = rng.range(-120, 120);
      if (Math.abs(x + 5) < 14) return null;
      return { x, z, type: 'broad', size: rng.range(0.9, 1.3), minD: 9, far: true, trunkH: rng.range(3, 5) };
    });
    // 灌木
    tryArea(Math.round(45 * Q), () => {
      const z = rng.range(-200, 110);
      const side = rng.chance(0.55);
      const x = side ? T.lawnLeft(z) - rng.range(4, 14) : T.lawnRight(z) + rng.range(18, 30);
      return { x, z, type: 'shrub', size: rng.range(0.7, 1.3), minD: 3.5, pathClear: 2.6 };
    });
    this.specs = placed;
    return placed;
  }

  build() {
    const specs = this.specs || this.plan();
    // 眼球氣球位置：周圍與朝照片視角方向的葉叢要挖空，眼球才會像照片那樣露出來
    this.eyeClear = [];
    for (const e of this.eyeSpots || []) {
      const gy = this.terrain.height(e.x, e.z);
      const c = new THREE.Vector3(e.x, gy + e.h, e.z);
      this.eyeClear.push(c);
      // 繩長 1.6 m + 半徑 1.15 m
      this.eyeAnchors.push({ x: e.x, y: c.y + 2.75, z: e.z, pair: 0, look: e.look });
    }
    const VIEW = new THREE.Vector3(7, 17.5, 80);
    this._blocksEye = (p, r) => {
      for (const e of this.eyeClear) {
        if (p.distanceTo(e) < r + 1.5) return true;
        // 眼球往相機方向 30 m 的視線
        const d = VIEW.clone().sub(e).normalize();
        const t = clamp(p.clone().sub(e).dot(d), 0, 30);
        if (p.distanceTo(e.clone().addScaledVector(d, t)) < r * 0.8 + 1.2) return true;
      }
      return false;
    };
    const wood = new GeoBuilder();
    const leaves = new GeoBuilder();
    const cores = new GeoBuilder();
    const fronds = new GeoBuilder();
    for (const s of specs) {
      const y = this.terrain.height(s.x, s.z);
      const base = new THREE.Vector3(s.x, y - 0.3, s.z);
      const rng = new RNG(Math.floor(s.x * 73856093) ^ Math.floor(s.z * 19349663));
      if (s.type === 'palm') this._palm(base, s, rng, wood, fronds);
      else if (s.type === 'bare') this._bare(base, s, rng, wood, leaves);
      else if (s.type === 'shrub') this._shrub(base, s, rng, leaves, cores);
      else this._broad(base, s, rng, wood, leaves, cores);
    }

    const U = this.uniforms;
    const leafTex = makeLeafTexture();
    const barkTex = makeBarkTexture();

    const woodMat = new THREE.MeshStandardMaterial({ map: barkTex, vertexColors: true, roughness: 0.95 });
    injectWind(woodMat, U);
    const woodMesh = new THREE.Mesh(wood.build(), woodMat);
    woodMesh.castShadow = true; woodMesh.receiveShadow = true;
    woodMesh.customDepthMaterial = windDepthMaterial(U, null, false);

    const leafMat = new THREE.MeshStandardMaterial({
      map: leafTex, vertexColors: true, alphaTest: 0.38, side: THREE.DoubleSide, roughness: 0.85,
    });
    injectWind(leafMat, U, { flutter: true, noFlip: true });
    const leafMesh = new THREE.Mesh(leaves.build(), leafMat);
    leafMesh.castShadow = true; leafMesh.receiveShadow = true;
    leafMesh.customDepthMaterial = windDepthMaterial(U, leafTex, true);

    const coreMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
    injectWind(coreMat, U);
    const coreMesh = new THREE.Mesh(cores.build(), coreMat);
    coreMesh.castShadow = true; coreMesh.receiveShadow = true;
    coreMesh.customDepthMaterial = windDepthMaterial(U, null, false);

    const frondMat = new THREE.MeshStandardMaterial({
      map: makeFrondTexture(), vertexColors: true, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.8,
    });
    injectWind(frondMat, U, { flutter: true, noFlip: true });
    const frondMesh = new THREE.Mesh(fronds.build(), frondMat);
    frondMesh.castShadow = true;
    frondMesh.customDepthMaterial = windDepthMaterial(U, frondMat.map, true);

    this.group.add(woodMesh, coreMesh, leafMesh, frondMesh);
    this.materials = { wood: woodMat, leaf: leafMat, core: coreMat, frond: frondMat };
    this.stats = { trees: specs.length, leafVerts: leaves.vcount, woodVerts: wood.vcount };
    return this.group;
  }

  // 闊葉樹（樟樹、榕樹類）：先決定樹冠橢球，再用枝條把葉叢連回樹幹
  _broad(base, s, rng, wood, leaves, cores) {
    const size = s.size ?? 1;
    const far = !!s.far;
    const slim = s.type === 'slim';
    const hs = s.hs ?? 1; // 高度倍率（依照片中樹冠的高度校正）：樹冠長得比樹幹多
    const trunkH = (s.trunkH ?? rng.range(2.5, 4.5)) * size * Math.sqrt(hs);
    const r0 = rng.range(0.24, 0.38) * size * (slim ? 0.7 : 1) * Math.sqrt(hs);
    const barkCol = new THREE.Color().setHSL(0.08, 0.1, rng.range(0.34, 0.5));
    const lean = new THREE.Vector3(rng.range(-0.1, 0.1), 1, rng.range(-0.1, 0.1)).normalize();
    const mid = base.clone().addScaledVector(lean, trunkH * 0.55);
    mid.x += rng.range(-0.2, 0.2); mid.z += rng.range(-0.2, 0.2);
    const top = mid.clone().addScaledVector(lean, trunkH * 0.45);
    wood.tube(base.clone().add(new THREE.Vector3(0, -0.2, 0)), base.clone().add(new THREE.Vector3(0, 0.6, 0)), r0 * 1.6, r0 * 1.05, 9, barkCol, 0, 0.02, 0, 0.6);
    wood.tube(base.clone().add(new THREE.Vector3(0, 0.5, 0)), mid, r0 * 1.05, r0 * 0.9, 9, barkCol, 0.02, 0.1, 0.5, trunkH * 0.6);
    wood.tube(mid, top, r0 * 0.9, r0 * 0.75, 8, barkCol, 0.1, 0.2, trunkH * 0.6, trunkH);
    this.colliders.push({ x: base.x, z: base.z, r: r0 * 1.15, h: trunkH + 1 });

    // 樹冠橢球
    const CR = rng.range(4.2, 6.0) * size * (slim ? 0.65 : 1) * (1 + (hs - 1) * 0.45);
    const CH = CR * rng.range(0.7, 0.9) * (1 + (hs - 1) * 0.6);
    const cc = top.clone(); cc.y += CH * 0.55; cc.x += lean.x * 1.5; cc.z += lean.z * 1.5;

    // 主枝
    const limbs = [];
    const nL = rng.int(3, 5);
    const az0 = rng.next() * Math.PI * 2;
    for (let i = 0; i < nL; i++) {
      const az = az0 + (i / nL) * Math.PI * 2 + rng.range(-0.35, 0.35);
      const el = rng.range(0.55, 1.05);
      const d = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
      const end = top.clone().addScaledVector(d, CR * rng.range(0.5, 0.7));
      wood.tube(top, end, r0 * 0.7, r0 * 0.38, far ? 5 : 7, barkCol, 0.2, 0.55, 0, 2);
      limbs.push(end);
    }

    // 葉叢：均勻分佈在橢球內（偏向表面）
    const nC = Math.round((far ? rng.range(9, 12) : rng.range(16, 22)) * (slim ? 0.6 : 1) * (1 + (hs - 1) * 1.2));
    const clusters = [];
    for (let i = 0; i < nC; i++) {
      const u = rng.range(-0.55, 1), ph = rng.next() * Math.PI * 2;
      const sr = Math.sqrt(1 - u * u);
      const rr = 0.45 + 0.5 * Math.pow(rng.next(), 0.6);
      const c = new THREE.Vector3(sr * Math.cos(ph) * CR * rr, u * CH * rr, sr * Math.sin(ph) * CR * rr).add(cc);
      clusters.push({ c, r: rng.range(1.7, 2.4) * size * (far ? 1.2 : 1) * (slim ? 0.8 : 1) });
    }
    // 枝條連到葉叢
    if (!far) {
      for (const k of clusters) {
        let best = limbs[0], bd = 1e9;
        for (const l of limbs) { const d = l.distanceToSquared(k.c); if (d < bd) { bd = d; best = l; } }
        const end = best.clone().lerp(k.c, 0.75);
        wood.tube(best, end, r0 * 0.3, r0 * 0.1, 4, barkCol, 0.55, 0.85, 0, 1);
      }
    }

    // 照片中左側樹林偏暗、偏橄欖綠；右側向陽的樹偏黃綠、帶秋色
    const side = s.side ?? (base.x > 0 ? 'R' : 'L');
    const pal = side === 'R'
      ? (s.dark ? { h: [0.15, 0.2], s: [0.45, 0.65], l: [0.2, 0.32] } : { h: [0.14, 0.19], s: [0.6, 0.8], l: [0.36, 0.52] })
      : { h: [0.2, 0.26], s: [0.32, 0.5], l: [0.27, 0.42] };
    const baseHue = rng.range(pal.h[0], pal.h[1]);
    const tint = s.tint ?? 0;
    const nrm = new THREE.Vector3(), ax = new THREE.Vector3(), ay = new THREE.Vector3(), p = new THREE.Vector3();
    const q = new THREE.Quaternion(), e = new THREE.Euler();
    const sunSide = new THREE.Vector3(0.6, 0.45, 0.65).normalize();
    for (const k of clusters) {
      if (this._blocksEye && this._blocksEye(k.c, k.r)) continue;
      const coreCol = new THREE.Color().setHSL(baseHue, 0.45, 0.07 + rng.next() * 0.04);
      cores.blob(k.c, k.r * 0.55, 0.82, coreCol, 0.75, rng, far ? 0 : 1);
      const cards = Math.round((far ? rng.range(10, 13) : rng.range(18, 24)) * (s.hero ? 4.5 : 1));
      const autumn = rng.chance(tint);
      for (let i = 0; i < cards; i++) {
        const u = rng.next() * 2 - 1, phi = rng.next() * Math.PI * 2;
        const sr = Math.sqrt(1 - u * u);
        const rr = k.r * (0.5 + 0.5 * Math.pow(rng.next(), 0.5));
        p.set(sr * Math.cos(phi), u * 0.85, sr * Math.sin(phi)).multiplyScalar(rr).add(k.c);
        nrm.subVectors(p, cc);
        nrm.y *= 1.3;
        nrm.normalize();
        nrm.y += 0.2; nrm.normalize();
        e.set(rng.next() * Math.PI, rng.next() * Math.PI, rng.next() * Math.PI);
        q.setFromEuler(e);
        const sz = rng.range(0.7, 1.0) * size * (far ? 1.35 : 1) * (s.hero ? 0.5 : 1);
        ax.set(sz, 0, 0).applyQuaternion(q);
        ay.set(0, sz, 0).applyQuaternion(q);
        const col = new THREE.Color();
        if (autumn) col.setHSL(rng.range(0.05, 0.1), rng.range(0.55, 0.75), rng.range(0.36, 0.5));
        else col.setHSL(baseHue + rng.range(-0.025, 0.03), rng.range(pal.s[0], pal.s[1]), rng.range(pal.l[0], pal.l[1]));
        // 外層與向陽面較亮
        const outward = clamp(p.distanceTo(cc) / (CR + 0.01), 0.3, 1.15);
        const sunny = 0.85 + 0.25 * Math.max(0, nrm.dot(sunSide));
        col.multiplyScalar((0.7 + 0.4 * outward) * sunny);
        // 前景樹冠：上半部受光、下半部在陰影裡（照片右下角）
        if (s.hero) col.multiplyScalar(lerp(0.3, 1.15, smoothstep(cc.y - CH * 0.5, cc.y + CH * 0.9, p.y)));
        leaves.card(p, ax, ay, nrm, col, 0.75);
      }
    }

    if (s.eyes) {
      for (const eye of s.eyes) {
        this.eyeAnchors.push({ x: base.x + eye.dx, y: eye.ay !== undefined ? base.y + 0.3 + eye.ay : cc.y + CH * 0.2, z: base.z + eye.dz, pair: eye.pair || 0 });
      }
    }
  }

  // 落葉高大的木棉：筆直主幹 + 斜上伸展的枝條
  _bare(base, s, rng, wood, leaves) {
    const size = s.size ?? 1;
    const H = rng.range(17, 22) * size;
    const r0 = rng.range(0.34, 0.46) * size;
    const barkCol = new THREE.Color().setHSL(0.07, 0.07, rng.range(0.45, 0.58));
    const top = base.clone().add(new THREE.Vector3(rng.range(-0.8, 0.8), H, rng.range(-0.8, 0.8)));
    const mid = base.clone().lerp(top, 0.5);
    wood.tube(base.clone().add(new THREE.Vector3(0, -0.2, 0)), mid, r0 * 1.25, r0 * 0.8, 8, barkCol, 0, 0.1, 0, H * 0.5);
    wood.tube(mid, top, r0 * 0.8, r0 * 0.2, 7, barkCol, 0.1, 0.4, H * 0.5, H);
    this.colliders.push({ x: base.x, z: base.z, r: r0, h: H });
    const twig = (p, d, len, r, depth) => {
      const end = p.clone().addScaledVector(d, len);
      wood.tube(p, end, r, r * 0.55, depth === 0 ? 5 : 4, barkCol, 0.35 + depth * 0.2, 0.55 + depth * 0.2, 0, len);
      if (depth >= 2) return;
      const n = depth === 0 ? 3 : 2;
      for (let i = 0; i < n; i++) {
        const nd = d.clone().add(new THREE.Vector3(rng.range(-0.7, 0.7), rng.range(0.1, 0.8), rng.range(-0.7, 0.7))).normalize();
        twig(p.clone().lerp(end, rng.range(0.5, 1)), nd, len * rng.range(0.45, 0.65), r * 0.5, depth + 1);
      }
    };
    const whorls = rng.int(4, 6);
    for (let w = 0; w < whorls; w++) {
      const t = 0.42 + (w / whorls) * 0.52;
      const p = base.clone().lerp(top, t);
      const n = rng.int(2, 4);
      const az0 = rng.next() * Math.PI * 2;
      for (let i = 0; i < n; i++) {
        const az = az0 + (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
        const tilt = rng.range(0.55, 1.0);
        const len = rng.range(3.5, 6) * size * (1.15 - t * 0.5);
        const d = new THREE.Vector3(Math.cos(az) * Math.sin(tilt), Math.cos(tilt), Math.sin(az) * Math.sin(tilt));
        twig(p, d, len, r0 * 0.28, 0);
      }
    }
    // 頂端稀疏的嫩葉
    for (let k = 0; k < 4; k++) {
      const c = top.clone().add(new THREE.Vector3(rng.range(-2, 2), rng.range(-2, 0.5), rng.range(-2, 2)));
      const col = new THREE.Color().setHSL(0.18, 0.35, 0.3);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.next() * 3, rng.next() * 3, rng.next() * 3));
      leaves.card(c, new THREE.Vector3(0.6, 0, 0).applyQuaternion(q), new THREE.Vector3(0, 0.6, 0).applyQuaternion(q), new THREE.Vector3(0, 1, 0), col, 0.9);
    }
  }

  // 大王椰子
  _palm(base, s, rng, wood, fronds) {
    const size = s.size ?? 1;
    const H = 21 * size;
    const segs = 10;
    const col = new THREE.Color(0.62, 0.6, 0.55);
    let prev = base.clone();
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const p = base.clone().add(new THREE.Vector3(Math.sin(t * 1.3) * 0.4, H * t, 0));
      const r = 0.32 * size * (1 - t * 0.35) * (i === Math.round(segs * 0.35) ? 1.12 : 1);
      wood.tube(prev, p, r * 1.02, r, 8, col, t * 0.3, t * 0.4, 0, 2);
      prev = p;
    }
    this.colliders.push({ x: base.x, z: base.z, r: 0.35, h: H });
    // 綠色冠莖
    const cs = prev.clone().add(new THREE.Vector3(0, 1.6, 0));
    wood.tube(prev, cs, 0.25, 0.22, 8, new THREE.Color(0.25, 0.4, 0.15), 0.4, 0.45, 0, 1);
    const n = 14;
    for (let i = 0; i < n; i++) {
      const az = (i / n) * Math.PI * 2 + rng.range(-0.2, 0.2);
      const up = rng.range(-0.3, 0.6);
      const L = rng.range(4, 5.2) * size;
      const dir = new THREE.Vector3(Math.cos(az), up, Math.sin(az)).normalize();
      const side = new THREE.Vector3(-Math.sin(az), 0, Math.cos(az));
      // 葉柄沿拋物線下垂，用多張卡片組成
      const steps = 5;
      let p0 = cs.clone();
      for (let k = 0; k < steps; k++) {
        const t1 = (k + 1) / steps;
        const p1 = cs.clone().addScaledVector(dir, L * t1);
        p1.y -= L * 0.45 * t1 * t1;
        const c = p0.clone().add(p1).multiplyScalar(0.5);
        const along = p1.clone().sub(p0).multiplyScalar(0.5);
        const w = (0.6 + 0.4 * Math.sin(Math.PI * (k + 0.5) / steps)) * 0.9 * size;
        const ax = side.clone().multiplyScalar(w);
        const nrm = new THREE.Vector3().crossVectors(along, ax).normalize();
        if (nrm.y < 0) nrm.negate();
        const colF = new THREE.Color().setHSL(0.24, 0.5, 0.22 + rng.next() * 0.06);
        fronds.card(c, ax, along, nrm, colF, 0.8 + t1 * 0.2, [0, k / steps, 1, (k + 1) / steps]);
        p0 = p1;
      }
    }
  }

  _shrub(base, s, rng, leaves, cores) {
    const size = s.size ?? 1;
    const n = rng.int(3, 6);
    const hue = rng.range(0.2, 0.27);
    for (let i = 0; i < n; i++) {
      const c = base.clone().add(new THREE.Vector3(rng.range(-1.2, 1.2) * size, rng.range(0.6, 1.3) * size, rng.range(-1.2, 1.2) * size));
      const r = rng.range(0.8, 1.3) * size;
      cores.blob(c, r * 0.6, 0.75, new THREE.Color().setHSL(hue, 0.5, 0.1), 0.25, rng, 0);
      for (let k = 0; k < 9; k++) {
        const p = c.clone().add(new THREE.Vector3(rng.range(-1, 1), rng.range(-0.5, 0.8), rng.range(-1, 1)).multiplyScalar(r * 0.8));
        const nrm = p.clone().sub(base).normalize();
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.next() * 3, rng.next() * 3, rng.next() * 3));
        const sz = rng.range(0.45, 0.7) * size;
        const col = new THREE.Color().setHSL(hue + rng.range(-0.02, 0.02), 0.6, rng.range(0.28, 0.42));
        leaves.card(p, new THREE.Vector3(sz, 0, 0).applyQuaternion(q), new THREE.Vector3(0, sz, 0).applyQuaternion(q), nrm, col, 0.35);
      }
    }
  }

  update(time, wind) {
    this.uniforms.uTime.value = time;
    this.uniforms.uWind.value.set(wind.x, wind.z);
  }
}
