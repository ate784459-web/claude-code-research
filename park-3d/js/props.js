import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RNG } from './noise.js';
import { Ball, Cloth, Disc, RopeBalloon } from './physics.js';

// ==================================================================
// 場景道具：野餐墊（布料模擬）、帳篷、推車、冰桶、角錐、長椅、
// 足球（含大顆充氣球）、飛盤、樹上的巨大眼球氣球。全部程序化產生。
// ==================================================================

// ---- 程序化貼圖 ----
function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const BLANKET_STYLES = [
  (g, w, h) => { // 紅白格子
    g.fillStyle = '#f4efe6'; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(200,40,40,0.55)';
    for (let i = 0; i < w; i += 32) { g.fillRect(i, 0, 16, h); g.fillRect(0, i, w, 16); }
  },
  (g, w, h) => { // 藍白格子
    g.fillStyle = '#eef2f6'; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(40,90,170,0.5)';
    for (let i = 0; i < w; i += 28) { g.fillRect(i, 0, 14, h); g.fillRect(0, i, w, 14); }
  },
  (g, w, h) => { // 彩色條紋
    const cols = ['#e85d75', '#f2b134', '#2f9e8f', '#f4f1ea', '#3d5a99', '#e2662f'];
    for (let i = 0; i < 12; i++) { g.fillStyle = cols[i % cols.length]; g.fillRect(0, (i * h) / 12, w, h / 12 + 1); }
  },
  (g, w, h) => { // 米白素色 + 邊
    g.fillStyle = '#efe7d6'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#b89c6e'; g.lineWidth = 14; g.strokeRect(10, 10, w - 20, h - 20);
  },
  (g, w, h) => { // 粉紅
    g.fillStyle = '#f2c4cf'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffffff';
    for (let i = 0; i < 60; i++) { g.beginPath(); g.arc((i * 37) % w, (i * 71) % h, 6, 0, Math.PI * 2); g.fill(); }
  },
  (g, w, h) => { // 格紋（蘇格蘭）
    g.fillStyle = '#2d4a3a'; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(200,60,50,0.6)';
    for (let i = 0; i < w; i += 64) { g.fillRect(i + 20, 0, 22, h); g.fillRect(0, i + 20, w, 22); }
    g.fillStyle = 'rgba(240,220,120,0.5)';
    for (let i = 0; i < w; i += 64) { g.fillRect(i + 50, 0, 4, h); g.fillRect(0, i + 50, w, 4); }
  },
  (g, w, h) => { // 白色鋁箔防潮墊
    g.fillStyle = '#dfe3e6'; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(120,130,140,0.4)'; g.lineWidth = 3;
    for (let i = 0; i < w; i += 40) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, h); g.stroke(); }
  },
  (g, w, h) => { // 淺藍
    g.fillStyle = '#9cc6e8'; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.35)';
    for (let i = 0; i < h; i += 24) g.fillRect(0, i, w, 6);
  },
];

// 足球貼圖：以截角二十面體的 12 個五邊形方向決定黑色區塊
function soccerTexture() {
  const W = 512, H = 256;
  const phi = (1 + Math.sqrt(5)) / 2;
  const ico = [[-1, phi, 0], [1, phi, 0], [-1, -phi, 0], [1, -phi, 0], [0, -1, phi], [0, 1, phi], [0, -1, -phi], [0, 1, -phi],
    [phi, 0, -1], [phi, 0, 1], [-phi, 0, -1], [-phi, 0, 1]].map((v) => new THREE.Vector3(...v).normalize());
  // 20 個六邊形中心 = 二十面體面中心
  const faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const hex = faces.map(([a, b, c]) => ico[a].clone().add(ico[b]).add(ico[c]).normalize());
  const centers = [...ico.map((v) => ({ v, pent: true })), ...hex.map((v) => ({ v, pent: false }))];
  return canvasTex(W, H, (g) => {
    const img = g.createImageData(W, H);
    const d = new THREE.Vector3();
    for (let y = 0; y < H; y++) {
      const theta = ((y + 0.5) / H) * Math.PI;
      for (let x = 0; x < W; x++) {
        const ph = ((x + 0.5) / W) * Math.PI * 2;
        d.set(-Math.cos(ph) * Math.sin(theta), Math.cos(theta), Math.sin(ph) * Math.sin(theta));
        let b1 = -2, b2 = -2, best = null;
        for (const c of centers) {
          const dt = c.v.dot(d);
          if (dt > b1) { b2 = b1; b1 = dt; best = c; } else if (dt > b2) b2 = dt;
        }
        const seam = b1 - b2 < 0.012;
        let v = best.pent ? 22 : 245;
        if (seam) v = best.pent ? 40 : 150;
        const i = (y * W + x) * 4;
        img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  });
}

// 眼球貼圖：瞳孔朝 +Z
function eyeTexture() {
  const W = 512, H = 256;
  return canvasTex(W, H, (g) => {
    const img = g.createImageData(W, H);
    const d = new THREE.Vector3();
    for (let y = 0; y < H; y++) {
      const theta = ((y + 0.5) / H) * Math.PI;
      for (let x = 0; x < W; x++) {
        const ph = ((x + 0.5) / W) * Math.PI * 2;
        d.set(-Math.cos(ph) * Math.sin(theta), Math.cos(theta), Math.sin(ph) * Math.sin(theta));
        const ang = Math.acos(Math.min(1, d.z));
        let r = 246, gg = 246, b = 242;
        // 微血管紋路
        const vein = Math.sin(ph * 37 + theta * 11) * Math.sin(ph * 13 - theta * 23);
        if (vein > 0.93 && ang > 0.6) { r = 230; gg = 200; b = 200; }
        if (ang < 0.42) { // 虹膜
          const k = ang / 0.42;
          const stria = 0.85 + 0.15 * Math.sin(Math.atan2(d.y, d.x) * 40);
          r = (60 + 50 * k) * stria; gg = (150 + 40 * k) * stria; b = (60 + 10 * k) * stria;
          if (k > 0.9) { r = 40; gg = 90; b = 40; }
        }
        if (ang < 0.19) { r = 12; gg = 14; b = 12; }
        // 反光點
        const hx = d.x + 0.1, hy = d.y - 0.12;
        if (d.z > 0.95 && hx * hx + hy * hy < 0.0025) { r = 255; gg = 255; b = 255; }
        const i = (y * W + x) * 4;
        img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  });
}

// ---- 合併靜態小物件（附頂點色）----
class StaticBatch {
  constructor() { this.geos = []; }
  add(geo, color, matrix) {
    const g = geo.clone();
    if (matrix) g.applyMatrix4(matrix);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    const c = new THREE.Color(color);
    const n = g.attributes.position.count;
    const cols = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    this.geos.push(g.index ? g.toNonIndexed() : g);
  }
  build(mat) {
    if (!this.geos.length) return new THREE.Group();
    const m = new THREE.Mesh(mergeGeometries(this.geos), mat);
    m.castShadow = true; m.receiveShadow = true;
    return m;
  }
}

const M4 = (x, y, z, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
  const m = new THREE.Matrix4();
  m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(sx, sy, sz));
  return m;
};

export class Props {
  constructor(terrain, physics, crowd) {
    this.terrain = terrain; this.physics = physics; this.crowd = crowd;
    this.group = new THREE.Group();
    this.group.name = 'props';
    this.batch = new StaticBatch();
    this.rng = new RNG(555);
    this.blankets = [];
    this.balls = [];
    this.eyes = [];
    this.discs = [];
    this.soccerTex = soccerTexture();
    this.blanketTex = BLANKET_STYLES.map((f) => canvasTex(256, 256, f));
    this.box = new THREE.BoxGeometry(1, 1, 1);
    this.cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
  }

  h(x, z) { return this.terrain.height(x, z); }

  // ---- 野餐墊（Verlet 布料）----
  addBlanket(x, z, rot, w, h, style) {
    const nx = 9, ny = 9;
    const cl = new Cloth(this.terrain, x, z, rot, w, h, nx, ny);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cl.p), 3));
    const uv = [], idx = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) uv.push(i / (nx - 1), j / (ny - 1));
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    cl.geometry = geo;
    const mat = new THREE.MeshStandardMaterial({ map: this.blanketTex[style % this.blanketTex.length], roughness: 0.92, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true; mesh.castShadow = true;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.physics.cloths.push(cl);
    const b = { x, z, rot, w, h, cloth: cl, mesh };
    this.blankets.push(b);
    this.crowd.blankets.push(b);
    return b;
  }

  // 野餐墊上的小物件（壓住布料）
  addPicnicItems(b, rng) {
    const n = rng.int(1, 4);
    const c = Math.cos(b.rot), s = Math.sin(b.rot);
    for (let i = 0; i < n; i++) {
      const lx = rng.range(-0.25, 0.25) * b.w, lz = rng.range(-0.25, 0.25) * b.h;
      const x = b.x + lx * c - lz * s, z = b.z + lx * s + lz * c;
      const y = this.h(x, z) + 0.03;
      const kind = rng.pick(['cooler', 'basket', 'bag', 'bottles', 'box', 'bag']);
      const ry = b.rot + rng.range(-0.4, 0.4);
      if (kind === 'cooler') {
        const col = rng.pick(['#2f6fb5', '#c0392b', '#e8e8e8', '#3f7f5a']);
        this.batch.add(this.box, col, M4(x, y + 0.17, z, ry, 0, 0, 0.5, 0.34, 0.32));
        this.batch.add(this.box, '#f4f4f4', M4(x, y + 0.36, z, ry, 0, 0, 0.52, 0.05, 0.34));
        this.physics.statics.push({ type: 'box', c: new THREE.Vector3(x, y + 0.2, z), hx: 0.26, hy: 0.2, hz: 0.17, rot: ry });
      } else if (kind === 'basket') {
        this.batch.add(this.box, '#a9773f', M4(x, y + 0.12, z, ry, 0, 0, 0.42, 0.24, 0.3));
      } else if (kind === 'bag') {
        this.batch.add(this.box, rng.pick(['#1d1d22', '#e9a6b8', '#d9c6a5', '#2a2f45', '#f2b134']), M4(x, y + 0.13, z, ry, 0.15, 0, 0.36, 0.26, 0.16));
      } else if (kind === 'bottles') {
        for (let k = 0; k < 3; k++) this.batch.add(this.cyl, rng.pick(['#5ab0d6', '#e8e8e8', '#f2b134']), M4(x + k * 0.08, y + 0.11, z, 0, 0, 0, 0.07, 0.22, 0.07));
      } else {
        this.batch.add(this.box, rng.pick(['#f4f4f4', '#f2b134', '#e2662f']), M4(x, y + 0.04, z, ry, 0, 0, 0.3, 0.08, 0.22));
      }
      b.cloth.pinNear(x, z, 0.32);
    }
  }

  addWagon(x, z, ry, rng) {
    const y = this.h(x, z);
    const col = rng.pick(['#2d4a3a', '#5a6470', '#c0392b', '#2a2f45', '#7a4b2a']);
    const m = M4(x, y, z, ry);
    const add = (geo, color, lx, ly, lz, sx, sy, sz, rx = 0, rz = 0) => {
      const L = M4(lx, ly, lz, 0, rx, rz, sx, sy, sz);
      this.batch.add(geo, color, m.clone().multiply(L));
    };
    add(this.box, col, 0, 0.42, 0, 0.55, 0.38, 0.95);
    add(this.box, '#222222', 0, 0.24, 0, 0.5, 0.04, 0.9);
    for (const [wx, wz] of [[-0.28, -0.35], [0.28, -0.35], [-0.28, 0.35], [0.28, 0.35]]) add(this.cyl, '#1a1a1a', wx, 0.11, wz, 0.22, 0.06, 0.22, 0, Math.PI / 2);
    add(this.cyl, '#333333', 0, 0.55, 0.65, 0.03, 0.6, 0.03, 0.9);
    // 車內雜物
    add(this.box, rng.pick(['#f2b134', '#e8e8e8', '#e85d75']), 0.05, 0.65, 0.1, 0.35, 0.18, 0.4);
    this.physics.statics.push({ type: 'box', c: new THREE.Vector3(x, y + 0.4, z), hx: 0.3, hy: 0.35, hz: 0.5, rot: ry });
    this.crowd.obstacles.push({ x, z, r: 0.7 });
  }

  addStroller(x, z, ry) {
    const y = this.h(x, z);
    const m = M4(x, y, z, ry);
    const add = (geo, color, lx, ly, lz, sx, sy, sz, rx = 0, rz = 0) => this.batch.add(geo, color, m.clone().multiply(M4(lx, ly, lz, 0, rx, rz, sx, sy, sz)));
    add(this.box, '#1d1d22', 0, 0.55, 0, 0.42, 0.12, 0.6);
    add(this.box, '#1d1d22', 0, 0.78, -0.25, 0.42, 0.45, 0.08, -0.3);
    const canopy = new THREE.SphereGeometry(0.32, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    add(canopy, '#2a2a30', 0, 0.85, -0.18, 1, 0.8, 1, -0.5);
    for (const [wx, wz] of [[-0.22, -0.3], [0.22, -0.3], [-0.22, 0.3], [0.22, 0.3]]) add(this.cyl, '#111111', wx, 0.12, wz, 0.24, 0.05, 0.24, 0, Math.PI / 2);
    add(this.cyl, '#888888', 0, 0.5, -0.1, 0.03, 0.9, 0.03, 0.35);
    add(this.cyl, '#888888', 0, 0.95, -0.5, 0.42, 0.03, 0.03, 0, Math.PI / 2);
    this.crowd.obstacles.push({ x, z, r: 0.5 });
  }

  addChair(x, z, ry) {
    const y = this.h(x, z);
    const m = M4(x, y, z, ry);
    const add = (geo, color, lx, ly, lz, sx, sy, sz, rx = 0) => this.batch.add(geo, color, m.clone().multiply(M4(lx, ly, lz, 0, rx, 0, sx, sy, sz)));
    const col = this.rng.pick(['#2a2f45', '#3f7f5a', '#1d1d22', '#7a4b2a']);
    add(this.box, col, 0, 0.32, 0, 0.5, 0.04, 0.45);
    add(this.box, col, 0, 0.62, -0.24, 0.5, 0.55, 0.04, -0.2);
    for (const [wx, wz] of [[-0.23, -0.2], [0.23, -0.2], [-0.23, 0.2], [0.23, 0.2]]) add(this.cyl, '#444444', wx, 0.16, wz, 0.025, 0.32, 0.025);
  }

  addDomeTent(x, z, ry, color, size = 1) {
    const y = this.h(x, z);
    const dome = new THREE.SphereGeometry(1.0, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    const m = M4(x, y - 0.05, z, ry, 0, 0, 1.25 * size, 0.95 * size, 1.05 * size);
    this.batch.add(dome, color, m);
    // 開口
    const door = new THREE.CircleGeometry(0.55, 16, 0, Math.PI);
    const dm = M4(x, y, z, ry).multiply(M4(0, 0.0, 1.02 * size * 0.98, 0, 0, 0, 0.9 * size, 1.25 * size, 1));
    this.batch.add(door, '#2b211c', dm);
    // 骨架線
    const ring = new THREE.TorusGeometry(1.0, 0.015, 4, 24, Math.PI);
    this.batch.add(ring, '#3a2e26', M4(x, y - 0.05, z, ry + Math.PI / 4, 0, 0, 1.26 * size, 0.96 * size, 1.06 * size));
    this.batch.add(ring, '#3a2e26', M4(x, y - 0.05, z, ry - Math.PI / 4, 0, 0, 1.26 * size, 0.96 * size, 1.06 * size));
    this.physics.statics.push({ type: 'sphere', c: new THREE.Vector3(x, y - 0.3 * size, z), r: 1.15 * size, e: 0.4 });
    this.crowd.obstacles.push({ x, z, r: 1.3 * size });
  }

  addCanopy(x, z, ry, color = '#f6f6f2') {
    const y = this.h(x, z);
    const m = M4(x, y, z, ry);
    const add = (geo, c, lx, ly, lz, sx, sy, sz) => this.batch.add(geo, c, m.clone().multiply(M4(lx, ly, lz, 0, 0, 0, sx, sy, sz)));
    for (const [lx, lz] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]]) add(this.cyl, '#cccccc', lx, 1.1, lz, 0.05, 2.2, 0.05);
    const roof = new THREE.ConeGeometry(2.05, 0.7, 4, 1);
    roof.rotateY(Math.PI / 4);
    add(roof, color, 0, 2.55, 0, 1, 1, 1);
    add(this.box, color, 0, 2.1, 0, 2.95, 0.22, 2.95);
    this.crowd.obstacles.push({ x: x + 1.4, z: z + 1.4, r: 0.3 }, { x: x - 1.4, z: z - 1.4, r: 0.3 }, { x: x + 1.4, z: z - 1.4, r: 0.3 }, { x: x - 1.4, z: z + 1.4, r: 0.3 });
  }

  addCone(x, z) {
    const y = this.h(x, z);
    const cone = new THREE.ConeGeometry(0.13, 0.42, 14);
    this.batch.add(cone, '#2fb34a', M4(x, y + 0.21, z));
    this.batch.add(this.box, '#25883a', M4(x, y + 0.015, z, 0, 0, 0, 0.3, 0.03, 0.3));
    this.physics.statics.push({ type: 'sphere', c: new THREE.Vector3(x, y + 0.12, z), r: 0.14 });
  }

  addBench(x, z, ry) {
    const y = this.h(x, z);
    const m = M4(x, y, z, ry);
    const add = (geo, c, lx, ly, lz, sx, sy, sz, rx = 0) => this.batch.add(geo, c, m.clone().multiply(M4(lx, ly, lz, 0, rx, 0, sx, sy, sz)));
    for (let i = 0; i < 3; i++) add(this.box, '#9b6b3f', 0, 0.45, -0.14 + i * 0.14, 1.8, 0.04, 0.11);
    for (let i = 0; i < 2; i++) add(this.box, '#9b6b3f', 0, 0.62 + i * 0.16, -0.27, 1.8, 0.1, 0.035, -0.15);
    for (const lx of [-0.75, 0.75]) { add(this.box, '#3a3a3a', lx, 0.22, 0, 0.06, 0.45, 0.45); add(this.box, '#3a3a3a', lx, 0.62, -0.27, 0.06, 0.4, 0.05); }
    this.physics.statics.push({ type: 'box', c: new THREE.Vector3(x, y + 0.4, z), hx: 0.92, hy: 0.4, hz: 0.3, rot: ry });
    return { x, z, rot: ry };
  }

  addPost(x, z) {
    const y = this.h(x, z);
    this.batch.add(this.box, '#f0f0ea', M4(x, y + 0.45, z, 0.3, 0, 0, 0.18, 0.9, 0.18));
    this.physics.statics.push({ type: 'box', c: new THREE.Vector3(x, y + 0.45, z), hx: 0.09, hy: 0.45, hz: 0.09, rot: 0.3 });
  }

  // ---- 動態物件 ----
  addSoccerBall(x, z, opts = {}) {
    const r = opts.radius ?? 0.11;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), new THREE.MeshStandardMaterial({ map: this.soccerTex, roughness: 0.45 }));
    mesh.castShadow = true; mesh.receiveShadow = true;
    const b = new Ball({ radius: r, mass: opts.mass ?? 0.43, restitution: opts.restitution ?? 0.7, rolling: opts.rolling ?? 0.12, cd: opts.cd ?? 0.25, mesh, kind: opts.kind ?? 'soccer' });
    b.pos.set(x, this.h(x, z) + r + 0.01, z);
    b.quat.setFromEuler(new THREE.Euler(Math.random() * 3, Math.random() * 3, 0));
    this.physics.addBall(b);
    this.group.add(mesh);
    this.balls.push(b);
    return b;
  }

  removeBall(b) {
    this.physics.removeBall(b);
    this.group.remove(b.mesh);
    b.mesh.geometry.dispose();
    const i = this.balls.indexOf(b);
    if (i >= 0) this.balls.splice(i, 1);
  }

  addDisc(x, z) {
    const geo = new THREE.CylinderGeometry(0.135, 0.12, 0.03, 20);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#ff6b2c', roughness: 0.4 }));
    mesh.castShadow = true;
    const d = new Disc(mesh);
    d.pos.set(x, this.h(x, z) + 1, z);
    this.physics.discs.push(d);
    this.group.add(mesh);
    this.discs.push(d);
    return d;
  }

  addEyeBalloon(anchor, offsetX = 0) {
    const a = anchor.clone(); a.x += offsetX;
    const R = 1.15;
    const rope = new RopeBalloon(a, 1.6, 6, R, 6);
    this.physics.ropes.push(rope);
    if (!this.eyeTex) this.eyeTex = eyeTexture();
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(R, 40, 28), new THREE.MeshStandardMaterial({ map: this.eyeTex, roughness: 0.28, metalness: 0 }));
    mesh.castShadow = true; mesh.receiveShadow = true;
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((rope.n + 1) * 3), 3));
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x3a3a35 }));
    line.frustumCulled = false;
    this.group.add(mesh, line);
    this.eyes.push({ rope, mesh, line });
  }

  finalize() {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
    this.group.add(this.batch.build(mat));
  }

  // 每幀：同步物理狀態到網格
  sync() {
    for (const b of this.balls) {
      b.mesh.position.copy(b.pos);
      b.mesh.quaternion.copy(b.quat);
    }
    for (const d of this.discs) {
      d.mesh.position.copy(d.pos);
      if (d.held) d.mesh.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.2);
      else {
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.tilt);
        d.mesh.quaternion.copy(q).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), d.angle));
      }
    }
    for (const e of this.eyes) {
      e.mesh.position.copy(e.rope.center);
      e.mesh.quaternion.copy(e.rope.quat);
      const arr = e.line.geometry.attributes.position.array;
      for (let i = 0; i < e.rope.n; i++) { arr[i * 3] = e.rope.p[i].x; arr[i * 3 + 1] = e.rope.p[i].y; arr[i * 3 + 2] = e.rope.p[i].z; }
      const top = e.rope.center;
      arr[e.rope.n * 3] = top.x; arr[e.rope.n * 3 + 1] = top.y + e.rope.radius; arr[e.rope.n * 3 + 2] = top.z;
      e.line.geometry.attributes.position.needsUpdate = true;
    }
  }
}
