import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RNG, clamp, lerp, smoothstep } from './noise.js';
import { buildBodyGeometry, makeFaceTexture, injectBodySkinning, BIND, B, NB, BONE_TEXELS } from './body.js';
import { SkirtSystem } from './skirt.js';

// ==================================================================
// 人群系統：程序化人體（連續的蒙皮網格，GPU instancing 一次畫完，見 body.js）、
// 骨架（正向運動學 + 腳的兩骨 IK）、步態 / 坐姿 / 踢球 / 跌倒等程序化動畫、呼吸與重心轉移、裙子布料（skirt.js），
// 以及行為 AI（野餐、散步、步道行走、踢足球、推大球、飛盤、聊天、長椅）。
// ==================================================================

const TAU = Math.PI * 2;
// 姿勢參數索引
const PY = 0, BP = 1, TP = 2, TY = 3, TR = 4, HP = 5, HY = 6,
  LHP = 7, LHR = 8, LK = 9, RHP = 10, RHR = 11, RK = 12,
  LSP = 13, LSR = 14, LE = 15, RSP = 16, RSR = 17, RE = 18,
  BOB = 19, ANK = 20, PR = 21, LHT = 22, RHT = 23, PX = 24;
const NP = 25;
// 這些動作時雙腳踩地，套用腳的 IK
const IK_MODES = new Set(['move', 'stand', 'idle', 'push', 'kick', 'throw', 'catch', 'crouch']);

const SKIN = ['#f3d2b3', '#eac09b', '#e0b08a', '#d6a37c', '#c48a62', '#a86f4c', '#f0caa8'];
const HAIR = ['#141010', '#1d1612', '#2a1d15', '#3b2a1e', '#4a3423', '#6b4a30', '#a09080'];
const TOPS = ['#f4f4f0', '#f7f6f0', '#ffffff', '#ececec', '#1d1d22', '#26262c', '#2a2f45', '#c0392b', '#e2662f', '#f2b134',
  '#e9a6b8', '#8fb8de', '#3f7f5a', '#7b8a95', '#d9c6a5', '#5a2f3a', '#2f6fb5', '#f6e7a1', '#e85d75', '#ff8c42'];
const BOTTOMS = ['#2b3a55', '#3d4f73', '#1e1e24', '#1e1e24', '#c9b48a', '#6d6a64', '#e8e4da', '#2d4a3a', '#5a4636', '#20325a', '#8a8f99'];
const SHOES = ['#f2f2f2', '#1a1a1a', '#e6e1d8', '#7a4b2a', '#3a3f4a', '#ffffff'];
const HATS = ['#efe3c8', '#f4f4f4', '#d9c39a', '#1d1d22', '#c8a774', '#e9a6b8', '#f2f0e6'];

function strip(g) {
  // 讓 merge 時屬性一致
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  return g;
}
function merge(list) { return mergeGeometries(list.map(strip)); }

// 頭髮的髮絲貼圖：明暗相間的髮束條紋，底部是參差的髮尾（alpha 測試切出不整齊的邊）
function makeHairTexture() {
  const W = 256, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const rng = new RNG(99);
  g.fillStyle = 'rgb(225,225,225)';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 260; i++) {
    const x = rng.range(0, W), w = rng.range(0.6, 2.2), l = Math.round(rng.range(150, 255));
    g.strokeStyle = `rgba(${l},${l},${l},${rng.range(0.25, 0.7)})`;
    g.lineWidth = w;
    g.beginPath(); g.moveTo(x, 0); g.bezierCurveTo(x + rng.range(-4, 4), H * 0.4, x + rng.range(-6, 6), H * 0.7, x + rng.range(-5, 5), H); g.stroke();
  }
  // 髮尾：每一小束長短不一，往下逐漸透明
  const img = g.getImageData(0, 0, W, H);
  const cut = new Float32Array(W);
  let v = 0;
  for (let x = 0; x < W; x++) { if (x % 3 === 0) v = rng.range(0.0, 0.2); cut[x] = v; }
  for (let y = 0; y < H; y++) {
    const fromBottom = 1 - y / H;
    for (let x = 0; x < W; x++) {
      const k = (y * W + x) * 4;
      img.data[k + 3] = fromBottom < cut[x] ? 0 : 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// 頭髮網格（頭部座標）：頭頂的髮帽 + 長髮在背後與兩側垂下的一片髮幕
function hairCap(thetaMax) {
  const g = new THREE.SphereGeometry(0.108, 22, 12, 0, TAU, 0, thetaMax);
  // uv.y：頭頂 = 1、邊緣（髮際線）= 0 → 髮尾落在髮際線
  const uv = g.attributes.uv, pos = g.attributes.position;
  for (let i = 0; i < uv.count; i++) {
    const y = pos.getY(i) / 0.108;
    const th = Math.acos(clamp(y, -1, 1));
    uv.setXY(i, uv.getX(i) * 6, 1 - th / thetaMax * 0.85);
  }
  g.rotateX(-0.42); g.scale(0.94, 1.1, 1.05); g.translate(0, 0.178, -0.004);
  return g;
}
function hairCurtain(len) {
  const pos = [], uv = [], idx = [];
  const NU = 18, NV = 8;
  for (let j = 0; j <= NV; j++) {
    const v = j / NV;
    for (let i = 0; i <= NU; i++) {
      const u = i / NU;
      const phi = (u - 0.5) * Math.PI * 1.35; // 背後為 0，往兩側延伸到耳後
      const side = Math.abs(u - 0.5) * 2;
      const L = len * (1 - 0.45 * side * side); // 兩側較短
      const y = 0.215 - L * v;
      const r = 0.105 + 0.03 * v + 0.012 * Math.sin(v * Math.PI);
      pos.push(Math.sin(phi) * r * 0.98, y, -Math.cos(phi) * r * 1.02 - 0.012);
      uv.push(u * 5, 1 - v);
    }
  }
  for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
    const a = j * (NU + 1) + i, b = a + 1, c = a + NU + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildParts() {
  const hairShort = hairCap(Math.PI * 0.56);
  const hairLong = merge([hairCap(Math.PI * 0.6), hairCurtain(0.36)]);
  const brim = new THREE.CylinderGeometry(0.2, 0.21, 0.012, 22); brim.translate(0, 0.25, 0.01);
  const crown = new THREE.CylinderGeometry(0.1, 0.113, 0.095, 16); crown.translate(0, 0.297, 0.0);
  const hat = merge([brim, crown]);
  return { hairShort, hairLong, hat };
}

// ------------------------------------------------------------------
// 姿勢函式（寫入長度 NP 的陣列）
// ------------------------------------------------------------------
function poseStand(o, t, seed) {
  o.fill(0);
  o[PY] = 0.92; o[LHP] = 0.02; o[RHP] = 0.02;
  o[LSR] = 0.08; o[RSR] = 0.08; o[LE] = 0.16; o[RE] = 0.16;
  // 重心輪流落在一條腿上：骨盆往承重腳側移、承重側的髖抬高、肩膀反向傾，另一腳膝蓋放鬆
  // （雙腳由 IK 釘在原地）
  const ws = Math.tanh(2.5 * Math.sin(t * 0.21 + seed * 1.7));
  o[PX] = 0.03 * ws;
  o[PR] = 0.045 * ws; o[TR] = -0.05 * ws;
  o[LK] = 0.04 + 0.2 * Math.max(0, -ws); o[RK] = 0.04 + 0.2 * Math.max(0, ws);
  o[LHR] = 0.035; o[RHR] = 0.035;
  o[TP] = 0.02; o[BOB] = 0.004 * Math.sin(t * 1.6 + seed);
  o[LSP] = 0.05 * Math.sin(t * 0.5 + seed); o[RSP] = 0.05 * Math.sin(t * 0.5 + seed + 1);
}
function poseGait(o, ph, v) {
  o.fill(0);
  const run = smoothstep(1.8, 2.8, v);
  const a = clamp(v / 1.35, 0.25, 1.25);
  const sp = Math.sin(ph), cp = Math.cos(ph);
  const hipA = lerp(0.42 * a, 0.78, run);
  o[LHP] = hipA * sp + run * 0.15; o[RHP] = -hipA * sp + run * 0.15;
  const kSw = lerp(0.9 * a, 1.75, run), kB = lerp(0.07, 0.35, run);
  o[LK] = kB + kSw * Math.pow(Math.max(0, cp), 1.4);
  o[RK] = kB + kSw * Math.pow(Math.max(0, -cp), 1.4);
  const armA = lerp(0.34 * a, 0.75, run);
  o[LSP] = -armA * sp + run * 0.25; o[RSP] = armA * sp + run * 0.25;
  o[LE] = lerp(0.22 + 0.12 * a, 1.5, run); o[RE] = o[LE];
  o[LSR] = 0.09 + run * 0.12; o[RSR] = o[LSR];
  o[TP] = lerp(0.04, 0.24, run);
  o[TY] = lerp(0.07 * a, 0.13, run) * sp;
  o[PR] = 0.035 * a * sp;
  o[PY] = 0.92 - run * 0.04;
  o[BOB] = lerp(0.024 * a * (Math.abs(cp) - 0.6), 0.06 * (0.55 - Math.abs(cp)), run);
  o[ANK] = 0.15 * Math.max(0, -sp) * a;
  o[HP] = 0.05;
}
function poseSit(o, variant, t, seed) {
  o.fill(0);
  o[PY] = 0.11;
  switch (variant) {
    case 0: // 盤腿
      o[LHP] = o[RHP] = 1.42; o[LHR] = o[RHR] = 0.78; o[LHT] = o[RHT] = 1.35; o[LK] = o[RK] = 2.5; o[TP] = 0.12;
      o[LSP] = o[RSP] = 0.55; o[LE] = o[RE] = 0.65; o[LSR] = o[RSR] = 0.22;
      break;
    case 1: // 抱膝
      o[LHP] = o[RHP] = 2.05; o[LHR] = o[RHR] = 0.12; o[LK] = o[RK] = 1.4; o[TP] = 0.2;
      o[LSP] = o[RSP] = 1.0; o[LE] = o[RE] = 0.55; o[LSR] = o[RSR] = -0.05;
      break;
    case 2: // 伸腿、雙手撐後
      o[LHP] = 1.42; o[RHP] = 1.5; o[LK] = 0.06; o[RK] = 0.5; o[LHR] = 0.07; o[RHR] = 0.12; o[TP] = -0.32;
      o[LSP] = o[RSP] = -0.6; o[LSR] = o[RSR] = 0.32; o[LE] = o[RE] = 0.04;
      break;
    case 3: // 側坐
      o[LHP] = 1.45; o[RHP] = 1.4; o[LHR] = -0.35; o[RHR] = 0.65; o[LHT] = -1.2; o[RHT] = 1.2; o[LK] = 2.4; o[RK] = 2.4;
      o[TR] = 0.08; o[TY] = 0.2; o[RSP] = -0.35; o[RSR] = 0.4; o[RE] = 0.08; o[LSP] = 0.45; o[LE] = 0.75; o[LSR] = 0.1;
      break;
    case 4: // 跪坐
      o[PY] = 0.42; o[LHP] = o[RHP] = 0.05; o[LK] = o[RK] = 1.58; o[LHR] = o[RHR] = 0.06; o[TP] = 0.05;
      o[LSP] = o[RSP] = 0.4; o[LE] = o[RE] = 0.7; o[LSR] = o[RSR] = 0.15; o[ANK] = -0.6;
      break;
  }
  o[BOB] = 0.004 * Math.sin(t * 1.5 + seed);
  o[TR] += 0.015 * Math.sin(t * 0.6 + seed);
}
function gesture(o, g, t, seed) {
  switch (g) {
    case 'talk':
      o[RSP] = 0.5 + 0.25 * Math.sin(t * 3.1 + seed); o[RE] = 1.0 + 0.35 * Math.sin(t * 4.3 + seed); o[RSR] = 0.15;
      o[HY] += 0.15 * Math.sin(t * 1.3 + seed);
      break;
    case 'eat': {
      const k = smoothstep(0.2, 0.5, (Math.sin(t * 1.4 + seed) + 1) / 2);
      o[RSP] = lerp(0.6, 1.1, k); o[RE] = lerp(0.9, 2.3, k); o[RSR] = lerp(0.15, -0.25, k);
      break;
    }
    case 'phone':
      o[LSP] = o[RSP] = 0.75; o[LE] = o[RE] = 1.45; o[LSR] = o[RSR] = -0.18; o[HP] = 0.55;
      break;
    case 'photo':
      o[LSP] = o[RSP] = 1.25; o[LE] = o[RE] = 1.75; o[LSR] = o[RSR] = -0.28; o[HP] = 0.0;
      break;
    case 'wave':
      o[RSP] = 2.6; o[RSR] = 0.45; o[RE] = 0.4 + 0.45 * Math.sin(t * 9 + seed);
      break;
    case 'hips':
      o[LSR] = o[RSR] = 0.75; o[LE] = o[RE] = 1.9; o[LSP] = o[RSP] = -0.25;
      break;
    case 'cross':
      o[LSP] = o[RSP] = 0.55; o[LE] = o[RE] = 2.15; o[LSR] = o[RSR] = -0.32;
      break;
  }
}
function poseLie(o, t, seed, variant) {
  o.fill(0);
  o[PY] = 0.12; o[BP] = -Math.PI / 2;
  o[LHP] = 0.04; o[RHP] = variant ? 0.75 : 0.05; o[RK] = variant ? 1.4 : 0.05; o[LK] = 0.05;
  o[LSP] = o[RSP] = 2.85; o[LE] = o[RE] = 2.1; o[LSR] = o[RSR] = 0.35;
  o[HP] = -0.25; o[BOB] = 0.003 * Math.sin(t * 1.2 + seed);
  o[ANK] = 0.6;
}
function poseBench(o, t, seed) {
  o.fill(0);
  o[PY] = 0.5; o[LHP] = o[RHP] = 1.5; o[LK] = o[RK] = 1.45; o[LHR] = 0.1; o[RHR] = 0.12; o[TP] = -0.08;
  o[LSP] = o[RSP] = 0.35; o[LE] = o[RE] = 0.9; o[LSR] = o[RSR] = 0.2;
  o[TR] = 0.015 * Math.sin(t * 0.6 + seed);
}
function poseCrouch(o) {
  o.fill(0);
  o[PY] = 0.3; o[LHP] = o[RHP] = 1.9; o[LK] = o[RK] = 2.45; o[LHR] = o[RHR] = 0.25; o[TP] = 0.6;
  o[LSP] = o[RSP] = 0.9; o[LE] = o[RE] = 0.4; o[LSR] = o[RSR] = 0.1; o[HP] = 0.3; o[ANK] = 0.2;
}
function poseKick(o, k, leftLeg) {
  o.fill(0);
  o[PY] = 0.9; o[LSR] = 0.45; o[RSR] = 0.45; o[LE] = o[RE] = 0.4; o[TP] = 0.08;
  let hp, kn;
  if (k < 0.4) { const u = smoothstep(0, 0.4, k); hp = lerp(0, -0.65, u); kn = lerp(0.1, 1.35, u); }
  else if (k < 0.6) { const u = smoothstep(0.4, 0.6, k); hp = lerp(-0.65, 1.05, u); kn = lerp(1.35, 0.12, u); }
  else { const u = smoothstep(0.6, 1, k); hp = lerp(1.05, 0.0, u); kn = lerp(0.12, 0.1, u); }
  if (leftLeg) { o[LHP] = hp; o[LK] = kn; o[RHP] = 0.12; o[RK] = 0.28; o[TY] = -0.2 * Math.sin(k * Math.PI); }
  else { o[RHP] = hp; o[RK] = kn; o[LHP] = 0.12; o[LK] = 0.28; o[TY] = 0.2 * Math.sin(k * Math.PI); }
  o[HP] = 0.25;
}
function poseThrow(o, k) {
  o.fill(0);
  o[PY] = 0.9; o[LHP] = 0.25; o[RHP] = -0.15; o[LK] = 0.2; o[RK] = 0.15; o[LSR] = 0.3; o[LE] = 0.6;
  if (k < 0.55) { const u = smoothstep(0, 0.55, k); o[TY] = lerp(0, 0.85, u); o[RSP] = lerp(0.2, 1.25, u); o[RSR] = lerp(0.1, -0.9, u); o[RE] = lerp(0.2, 1.7, u); }
  else if (k < 0.72) { const u = smoothstep(0.55, 0.72, k); o[TY] = lerp(0.85, -0.45, u); o[RSP] = 1.3; o[RSR] = lerp(-0.9, 1.0, u); o[RE] = lerp(1.7, 0.1, u); }
  else { const u = smoothstep(0.72, 1, k); o[TY] = lerp(-0.45, 0, u); o[RSP] = lerp(1.3, 0.2, u); o[RSR] = lerp(1.0, 0.1, u); o[RE] = lerp(0.1, 0.2, u); }
}
function poseCatch(o) {
  o.fill(0);
  o[PY] = 0.9; o[LK] = o[RK] = 0.2; o[LSP] = o[RSP] = 1.25; o[LE] = o[RE] = 0.45; o[LSR] = o[RSR] = 0.12; o[TP] = 0.05; o[HP] = -0.1;
}
function poseKnock(o, tt) {
  // 0~0.5 秒向後跌倒、躺 1.6 秒、再坐起站起
  o.fill(0);
  if (tt < 0.5) {
    const u = (tt / 0.5) ** 2;
    o[BP] = lerp(0, -1.45, u); o[PY] = lerp(0.92, 0.13, u);
    o[LSP] = o[RSP] = lerp(0, 1.9, u); o[LSR] = o[RSR] = lerp(0.1, 0.8, u); o[LE] = o[RE] = 0.4;
    o[LHP] = o[RHP] = lerp(0, 0.7, u); o[LK] = o[RK] = lerp(0.1, 0.6, u);
  } else if (tt < 2.1) {
    o[BP] = -1.5; o[PY] = 0.13; o[LSP] = o[RSP] = 1.2; o[LSR] = o[RSR] = 0.9; o[LE] = o[RE] = 0.6;
    o[LHP] = 0.6; o[RHP] = 0.3; o[LK] = 1.0; o[RK] = 0.4; o[HP] = -0.3;
  } else if (tt < 2.9) {
    const u = smoothstep(2.1, 2.9, tt);
    o[BP] = lerp(-1.5, 0, u); o[PY] = 0.12; o[TP] = lerp(0, 0.4, u);
    o[LHP] = o[RHP] = lerp(0.5, 2.0, u); o[LK] = o[RK] = lerp(0.7, 1.6, u);
    o[LSP] = o[RSP] = lerp(1.0, -0.4, u); o[LSR] = o[RSR] = 0.4;
  } else {
    const u = smoothstep(2.9, 3.6, tt);
    o[PY] = lerp(0.3, 0.92, u); o[TP] = lerp(0.6, 0.02, u);
    o[LHP] = o[RHP] = lerp(1.9, 0.02, u); o[LK] = o[RK] = lerp(2.4, 0.04, u);
    o[LSP] = o[RSP] = lerp(0.9, 0.0, u); o[LSR] = o[RSR] = 0.1;
  }
}

// ------------------------------------------------------------------
// 人群
// ------------------------------------------------------------------
const _m = new THREE.Matrix4(), _root = new THREE.Matrix4(), _pel = new THREE.Matrix4(), _tor = new THREE.Matrix4(),
  _head = new THREE.Matrix4(), _ua = new THREE.Matrix4(), _fa = new THREE.Matrix4(), _th = new THREE.Matrix4(),
  _sh = new THREE.Matrix4(), _ft = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1);
const _yAxis = new THREE.Vector3(0, 1, 0);
const _tmpV = new THREE.Vector3();
const _H = new THREE.Vector3(), _A = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _off = new THREE.Vector3();
const _tgt = [new THREE.Vector3(), new THREE.Vector3()], _ground = [0, 0];
const _qr = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _rot = new THREE.Matrix4(), _tm = new THREE.Matrix4();

// 骨頭世界矩陣 × 綁定姿勢的逆矩陣（純平移）→ 寫進骨頭貼圖
function writeBone(D, base, b, m) {
  const e = m.elements, o = BIND[b], k = base + b * 16;
  for (let j = 0; j < 12; j++) D[k + j] = e[j];
  D[k + 12] = e[12] - (e[0] * o[0] + e[4] * o[1] + e[8] * o[2]);
  D[k + 13] = e[13] - (e[1] * o[0] + e[5] * o[1] + e[9] * o[2]);
  D[k + 14] = e[14] - (e[2] * o[0] + e[6] * o[1] + e[10] * o[2]);
  D[k + 15] = 1;
}

function local(out, x, y, z, rx, ry, rz, order = 'XYZ', sc = 1) {
  _e.set(rx, ry, rz, order);
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _s.set(sc, sc, sc);
  return out.compose(_p, _q, _s);
}
function wrapAngle(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

export class Crowd {
  constructor(terrain, physics, opts = {}) {
    this.terrain = terrain;
    this.physics = physics;
    this.rng = new RNG(opts.seed ?? 31);
    this.people = [];
    this.groups = [];
    this.hash = new Map();
    this.cell = 2;
    this.blankets = [];
    this.obstacles = []; // 圓形障礙 {x,z,r}
    this.meshes = null;
    this.time = 0;
    this.camera = null;
    this.freeCheck = 0;
    physics.crowd = this;
  }

  // ---------------- 建立人物 ----------------
  createPerson(o = {}) {
    const rng = this.rng;
    const child = !!o.child;
    const female = o.female ?? rng.chance(0.5);
    const height = child ? (o.height ?? rng.range(0.95, 1.38)) : (female ? rng.gauss(1.6, 0.05) : rng.gauss(1.72, 0.06));
    const p = {
      id: this.people.length,
      child, female,
      s: height / 1.7,
      headScale: child ? 1.13 + (1.38 - height) * 0.3 : 1,
      skin: rng.pick(SKIN),
      hairColor: rng.pick(HAIR),
      top: o.top ?? rng.pick(TOPS),
      bottom: rng.pick(BOTTOMS),
      shoes: rng.pick(SHOES),
      hairStyle: female ? (rng.chance(0.72) ? 'long' : 'short') : (rng.chance(0.94) ? 'short' : 'none'),
      hat: !child && rng.chance(female ? 0.24 : 0.08),
      hatColor: rng.pick(HATS),
      skirt: !!o.allowSkirt && female && !child && rng.chance(0.3),
      longPants: rng.chance(child ? 0.35 : 0.62),
      longSleeve: rng.chance(0.28),
      x: o.x ?? 0, z: o.z ?? 0, y: 0, vx: 0, vz: 0,
      heading: o.heading ?? rng.range(-Math.PI, Math.PI),
      faceYaw: null,
      goal: null, maxSpeed: 1.3, arrive: 0.35,
      speed: 0,
      mode: 'stand', modeT: 0, variant: 0, gesture: 'none', gestureT: 0, lie: false,
      phase: rng.next() * TAU,
      seed: rng.next() * 100,
      cur: new Float32Array(NP), tgt: new Float32Array(NP),
      blend: 10,
      lookAt: null, lookT: rng.range(1, 5), lookYaw: 0, lookPitch: 0,
      hitT: 0, hitN: new THREE.Vector3(),
      override: null,
      static: false,
      group: null,
      capA: new THREE.Vector3(), capB: new THREE.Vector3(), capFeet: new THREE.Vector3(), hand: new THREE.Vector3(),
      mass: 0,
      radius: 0,
    };
    p.mass = child ? 25 : 65;
    p.radius = 0.24 * p.s;
    // 服裝剪裁與體型（用自己的亂數，不影響其他人的配置）
    const r2 = new RNG(Math.floor(p.seed * 1000) + 7);
    if (o.softSkirt && !p.skirt && female && !child && r2.chance(0.3)) p.skirt = true;
    const sleeve = p.longSleeve ? r2.range(0.9, 0.98) : female && !child && r2.chance(0.2) ? 0.03 : r2.range(0.22, 0.36);
    const pants = p.longPants ? r2.range(0.94, 1.0) : r2.chance(0.55) ? r2.range(0.3, 0.42) : r2.range(0.55, 0.68);
    p.cloth = [sleeve, pants, r2.range(1.39, 1.425), r2.range(0.93, 0.985)];
    const gw = clamp(r2.gauss(1, 0.06), 0.88, 1.18);
    p.shape = child ? [0.92, 0.94, 0.95 * gw, 0.86] : female ? [0.9 * gw, 1.07 * gw, 0.95 * gw, 0.9 * Math.sqrt(gw)] : [1.04 * gw, 0.97 * gw, gw, Math.sqrt(gw)];
    p.breath = r2.next() * TAU; p.exert = 0; p.breathV = 0;
    p.pelM = new THREE.Matrix4();
    p.legJ = [0, 1, 2, 3, 4, 5].map(() => new THREE.Vector3());
    if (child) p.hat = false;
    if (p.skirt) { p.longPants = false; p.cloth[1] = 0; p.cloth[3] = 0.975; p.skirtColor = p.bottom === '#1e1e24' ? '#2a2a30' : rngSkirt(p.seed); }
    poseStand(p.cur, 0, p.seed);
    p.y = this.terrain.height(p.x, p.z);
    this.people.push(p);
    return p;
  }

  addGroup(g) { this.groups.push(g); for (const m of g.members) m.group = g; return g; }

  // ---------------- 建立繪製用網格 ----------------
  build(opts = {}) {
    const parts = buildParts();
    const P = this.people;
    const N = P.length;
    let nShort = 0, nLong = 0, nHat = 0;
    for (const p of P) {
      p.hairIdx = -1; p.hatIdx = -1;
      if (p.hairStyle === 'short') p.hairIdx = nShort++;
      else if (p.hairStyle === 'long') p.hairIdx = nLong++;
      if (p.hat) p.hatIdx = nHat++;
    }

    // ---- 身體：一張連續的蒙皮網格，所有人一次畫完 ----
    const bodyGeo = buildBodyGeometry(opts.detail ?? 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = bodyGeo.index;
    for (const k of Object.keys(bodyGeo.attributes)) geo.setAttribute(k, bodyGeo.attributes[k]);
    geo.instanceCount = N;
    const c = new THREE.Color();
    const col3 = (key) => {
      const a = new Float32Array(N * 3);
      P.forEach((p, i) => { c.set(key(p)); a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; });
      return new THREE.InstancedBufferAttribute(a, 3);
    };
    geo.setAttribute('iTop', col3((p) => p.top));
    geo.setAttribute('iBottom', col3((p) => (p.skirt ? p.skirtColor : p.bottom)));
    geo.setAttribute('iSkin', col3((p) => p.skin));
    geo.setAttribute('iShoe', col3((p) => p.shoes));
    const v4 = (key) => {
      const a = new Float32Array(N * 4);
      P.forEach((p, i) => a.set(key(p), i * 4));
      return new THREE.InstancedBufferAttribute(a, 4);
    };
    geo.setAttribute('iCloth', v4((p) => p.cloth));
    geo.setAttribute('iShape', v4((p) => p.shape));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    this.boneData = new Float32Array(BONE_TEXELS * 4 * N);
    this.boneTex = new THREE.DataTexture(this.boneData, BONE_TEXELS, N, THREE.RGBAFormat, THREE.FloatType);
    this.boneTex.magFilter = this.boneTex.minFilter = THREE.NearestFilter;
    const U = { uBones: { value: this.boneTex }, uFace: { value: makeFaceTexture() } };
    const bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0 });
    injectBodySkinning(bodyMat, U);
    const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    injectBodySkinning(depthMat, U, { color: false });
    const body = new THREE.Mesh(geo, bodyMat);
    body.customDepthMaterial = depthMat;
    body.castShadow = true; body.receiveShadow = true;
    body.frustumCulled = false;
    body.name = 'bodies';
    this.body = body;

    // ---- 頭髮與帽子：剛性跟著頭 ----
    const hairTex = makeHairTexture();
    const hairMat = new THREE.MeshStandardMaterial({ map: hairTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.5, metalness: 0 });
    const hairDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: hairTex, alphaTest: 0.5 });
    const hatMat = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0 });
    const mk = (g, count, mat) => {
      const im = new THREE.InstancedMesh(g, mat, Math.max(1, count));
      if (mat === hairMat) im.customDepthMaterial = hairDepth;
      im.count = count;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.castShadow = true; im.receiveShadow = true;
      im.frustumCulled = false;
      return im;
    };
    const M = { hairShort: mk(parts.hairShort, nShort, hairMat), hairLong: mk(parts.hairLong, nLong, hairMat), hat: mk(parts.hat, nHat, hatMat) };
    for (const p of P) {
      if (p.hairStyle === 'short') M.hairShort.setColorAt(p.hairIdx, c.set(p.hairColor));
      if (p.hairStyle === 'long') M.hairLong.setColorAt(p.hairIdx, c.set(p.hairColor));
      if (p.hat) M.hat.setColorAt(p.hatIdx, c.set(p.hatColor));
    }
    for (const k in M) if (M[k].instanceColor) M[k].instanceColor.needsUpdate = true;
    this.meshes = M;

    const g = new THREE.Group();
    g.name = 'crowd';
    g.add(body);
    for (const k in M) g.add(M[k]);
    this._writeInstances();

    // ---- 裙子布料 ----
    this.skirts = new SkirtSystem(this.terrain, this.physics.wind);
    const srng = new RNG(4242);
    for (const p of P) if (p.skirt) p.skirtSim = this.skirts.add(p, p.skirtColor, srng);
    g.add(this.skirts.build());
    for (let i = 0; i < 90; i++) this.skirts.update(1 / 45); // 先讓布料垂下來
    this.group = g;
    return g;
  }

  // ---------------- 空間雜湊 ----------------
  _rebuildHash() {
    this.hash.clear();
    for (const p of this.people) {
      const k = (Math.floor(p.x / this.cell) * 73856093) ^ (Math.floor(p.z / this.cell) * 19349663);
      let a = this.hash.get(k);
      if (!a) { a = []; this.hash.set(k, a); }
      a.push(p);
    }
  }
  forNear(x, z, r, cb) {
    const c = this.cell;
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const z0 = Math.floor((z - r) / c), z1 = Math.floor((z + r) / c);
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
      const a = this.hash.get((i * 73856093) ^ (j * 19349663));
      if (a) for (const p of a) cb(p);
    }
  }

  // ---------------- 物理回呼：被球打到 ----------------
  onHit(p, ball, strength, n) {
    p.hitT = 0.7;
    p.hitN.copy(n);
    p.lookAt = ball.pos;
    p.lookT = 2.5;
    const standing = !p.override && (p.mode === 'move' || p.mode === 'stand' || p.mode === 'idle');
    if (standing && strength > (p.child ? 7 : 11)) {
      p.override = { type: 'knock', t: 0 };
      p.heading = Math.atan2(n.x, n.z) + Math.PI; // 面向來球方向，往後倒
    }
  }

  // 走到球後方並踢出；回傳 true 表示已出腳
  goKick(p, ball, dx, dz, speed, loft, run = true) {
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    const reach = 0.32 * p.s + ball.radius;
    const px = ball.pos.x + ball.vel.x * 0.25 - dx * reach;
    const pz = ball.pos.z + ball.vel.z * 0.25 - dz * reach;
    const d = Math.hypot(px - p.x, pz - p.z);
    const db = Math.hypot(ball.pos.x - p.x, ball.pos.z - p.z);
    if (db < reach + 0.35 && ball.vel.length() < 4.5 && ball.pos.y - this.terrain.height(ball.pos.x, ball.pos.z) < ball.radius + 0.5) {
      p.override = { type: 'kick', t: 0, ball, dx, dz, speed, loft, done: false, left: this.rng.chance(0.25) };
      p.heading = Math.atan2(dx, dz);
      return true;
    }
    p.goal = { x: px, z: pz };
    p.maxSpeed = run && d > 3 ? (p.child ? 3.2 : 3.6) : d > 1.2 ? 1.8 : 1.0;
    p.arrive = 0.05;
    p.mode = 'move';
    return false;
  }

  _updateOverride(p, dt) {
    const o = p.override;
    o.t += dt;
    p.goal = null;
    if (o.type === 'kick') {
      p.mode = 'kick';
      p.blend = 22;
      const dur = 0.55;
      if (!o.done && o.t > dur * 0.5) {
        o.done = true;
        const b = o.ball;
        const db = Math.hypot(b.pos.x - p.x, b.pos.z - p.z);
        if (db < 1.0 * p.s + b.radius) {
          this.physics.kick(b, o.dx + (this.rng.next() - 0.5) * 0.08, o.dz + (this.rng.next() - 0.5) * 0.08, o.speed, o.loft, (this.rng.next() - 0.5) * 8);
          b.lastKick = this.physics.time;
          b.lastKicker = p;
        }
      }
      if (o.t > dur) { p.override = null; p.blend = 10; p.mode = 'stand'; }
    } else if (o.type === 'knock') {
      p.mode = 'knock';
      p.blend = 25;
      p.vx *= 0.9; p.vz *= 0.9;
      if (o.t > 3.6) { p.override = null; p.blend = 8; p.mode = 'stand'; }
    } else if (o.type === 'fetch') {
      // 撿到使用者丟來的球 → 踢回給相機方向
      const b = o.ball;
      if (!this.physics.balls.includes(b) || o.t > 25) { b.owner = null; p.override = null; return; }
      const cam = this.camera.position;
      const tx = cam.x - b.pos.x, tz = cam.z - b.pos.z;
      const d = Math.hypot(tx, tz);
      const sp = clamp(Math.sqrt(2 * 1.6 * Math.min(d, 45)) + 1.5, 4, 15);
      const kicked = this.goKick(p, b, tx, tz, sp, 0.32, true);
      if (kicked) {
        p.override.after = { type: 'fetchDone' };
        b.owner = null;
        b.cooldown = 6;
      }
    }
  }

  // ---------------- 每幀更新 ----------------
  update(dt, t, camera) {
    this.time = t;
    this.camera = camera;
    dt = Math.min(dt, 0.05);
    this._rebuildHash();
    for (const g of this.groups) g.update(dt, t);
    this._assignFreeBalls(dt);
    for (const p of this.people) {
      if (p.override) this._updateOverride(p, dt);
    }
    for (const p of this.people) this._locomote(p, dt);
    this._lookAtBalls(dt);
    for (const p of this.people) this._animate(p, dt, t);
    this._writeInstances();
    if (this.skirts) this.skirts.update(dt, camera ? camera.position : null);
  }

  // 附近的人會轉頭看飛過來、滾過去的球和飛盤
  _lookAtBalls(dt) {
    this.lookCheck = (this.lookCheck ?? 0) - dt;
    if (this.lookCheck > 0) return;
    this.lookCheck = 0.25;
    const movers = [];
    for (const b of this.physics.balls) if (b.vel.lengthSq() > 9) movers.push(b);
    for (const d of this.physics.discs) if (d.vel.lengthSq() > 9) movers.push(d);
    for (const b of movers) {
      this.forNear(b.pos.x, b.pos.z, 20, (p) => {
        if (p.override || p.lookAt === b.pos || p.mode === 'lie') return;
        const d = Math.hypot(p.x - b.pos.x, p.z - b.pos.z);
        if (d < 20 && this.rng.next() < 0.6 * (1 - d / 20)) { p.lookAt = b.pos; p.lookT = this.rng.range(1.2, 3); }
      });
    }
  }

  _assignFreeBalls(dt) {
    this.freeCheck -= dt;
    if (this.freeCheck > 0) return;
    this.freeCheck = 0.4;
    for (const b of this.physics.balls) {
      if (b.kind !== 'soccer' || b.owner || !b.userBall) continue;
      if (b.cooldown > 0) { b.cooldown -= 0.4; continue; }
      if (b.vel.length() > 3) continue;
      let best = null, bd = 18;
      this.forNear(b.pos.x, b.pos.z, 18, (p) => {
        if (p.override || p.static || p.mode === 'sit' || p.mode === 'lie' || p.mode === 'bench') return;
        if (!p.group || !p.group.canFetch) return;
        const d = Math.hypot(p.x - b.pos.x, p.z - b.pos.z);
        if (d < bd) { bd = d; best = p; }
      });
      if (best) {
        best.override = { type: 'fetch', t: 0, ball: b };
        b.owner = best;
      }
    }
  }

  _locomote(p, dt) {
    if (p.static) {
      p.vx = 0; p.vz = 0; p.speed = 0;
      p.y = this.terrain.height(p.x, p.z);
      return;
    }
    let dvx = 0, dvz = 0;
    if (p.goal && (p.mode === 'move' || p.mode === 'push')) {
      const dx = p.goal.x - p.x, dz = p.goal.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > p.arrive) {
        const sp = p.maxSpeed * Math.min(1, d / (0.4 + p.maxSpeed * 0.6));
        dvx = (dx / d) * sp; dvz = (dz / d) * sp;
      }
    }
    // 分離：避免與他人重疊
    let sx = 0, sz = 0;
    const moving = dvx * dvx + dvz * dvz > 0.01;
    this.forNear(p.x, p.z, 1.6, (q) => {
      if (q === p) return;
      const dx = p.x - q.x, dz = p.z - q.z;
      const d = Math.hypot(dx, dz);
      const minD = p.radius + q.radius + (moving ? 0.35 : 0.1);
      if (d < minD && d > 1e-4) {
        const f = (minD - d) / minD;
        const w = q.static ? 3.5 : 2.2;
        sx += (dx / d) * f * w; sz += (dz / d) * f * w;
      }
    });
    // 樹幹與障礙
    this.physics.forTrunksNear(p.x, p.z, (tr) => {
      const dx = p.x - tr.x, dz = p.z - tr.z;
      const d = Math.hypot(dx, dz), minD = tr.r + p.radius + 0.5;
      if (d < minD && d > 1e-4) { const f = (minD - d) / minD; sx += (dx / d) * f * 3; sz += (dz / d) * f * 3; }
    });
    for (const ob of this.obstacles) {
      const dx = p.x - ob.x, dz = p.z - ob.z;
      if (Math.abs(dx) > ob.r + 2 || Math.abs(dz) > ob.r + 2) continue;
      if (ob.owner && ob.owner === p.group) continue;
      const d = Math.hypot(dx, dz), minD = ob.r + p.radius + 0.2;
      if (d < minD && d > 1e-4) { const f = (minD - d) / minD; sx += (dx / d) * f * 4; sz += (dz / d) * f * 4; }
    }
    const acc = p.child ? 7 : 5;
    const k = Math.min(1, acc * dt);
    p.vx += (dvx + sx - p.vx) * k;
    p.vz += (dvz + sz - p.vz) * k;
    if (p.mode !== 'move' && p.mode !== 'push' && !p.override) { p.vx *= 1 - Math.min(1, 6 * dt); p.vz *= 1 - Math.min(1, 6 * dt); }
    if (p.override && p.override.type === 'kick') { p.vx *= 0.85; p.vz *= 0.85; }
    const sp = Math.hypot(p.vx, p.vz);
    const maxS = Math.max(p.maxSpeed, 0.5) * 1.25;
    if (sp > maxS) { p.vx *= maxS / sp; p.vz *= maxS / sp; }
    p.x += p.vx * dt; p.z += p.vz * dt;
    p.speed = Math.hypot(p.vx, p.vz);
    p.y = this.terrain.height(p.x, p.z);
    // 轉向
    let targetYaw = null;
    if (p.speed > 0.25 && p.mode === 'move') targetYaw = Math.atan2(p.vx, p.vz);
    else if (p.faceYaw !== null && p.faceYaw !== undefined && !p.override) targetYaw = p.faceYaw;
    if (targetYaw !== null) {
      const diff = wrapAngle(targetYaw - p.heading);
      const rate = (p.speed > 2 ? 6 : 4) * dt;
      p.heading += clamp(diff, -rate, rate);
    }
    // 步態相位依實際移動距離推進（避免腳底打滑）
    const stride = (p.child ? 0.95 : 1.3) * p.s * (1 + 0.38 * Math.max(0, p.speed - 1.6));
    p.phase += (TAU * p.speed * dt) / stride;
  }

  _animate(p, dt, t) {
    const o = p.tgt;
    const ov = p.override;
    if (ov && ov.type === 'kick') poseKick(o, ov.t / 0.55, ov.left);
    else if (ov && ov.type === 'knock') poseKnock(o, ov.t);
    else {
      switch (p.mode) {
        case 'sit': poseSit(o, p.variant, t, p.seed); gesture(o, p.gesture, t, p.seed); break;
        case 'lie': poseLie(o, t, p.seed, p.variant % 2); break;
        case 'bench': poseBench(o, t, p.seed); gesture(o, p.gesture === 'phone' ? 'phone' : 'none', t, p.seed); break;
        case 'crouch': poseCrouch(o); break;
        case 'throw': poseThrow(o, clamp(p.modeT, 0, 1)); break;
        case 'catch': poseCatch(o); break;
        case 'push': poseGait(o, p.phase, p.speed); o[LSP] = o[RSP] = 1.35; o[LE] = o[RE] = 0.45; o[LSR] = o[RSR] = 0.05; o[TP] = 0.32; break;
        case 'move':
          if (p.speed > 0.18) poseGait(o, p.phase, p.speed);
          else { poseStand(o, t, p.seed); gesture(o, p.gesture, t, p.seed); }
          break;
        default:
          poseStand(o, t, p.seed); gesture(o, p.gesture, t, p.seed);
      }
    }
    // 頭部：環顧四周或看向目標
    p.lookT -= dt;
    if (p.lookT < 0) {
      p.lookT = this.rng.range(2, 7);
      p.lookYaw = this.rng.chance(0.4) ? 0 : this.rng.range(-0.9, 0.9);
      p.lookPitch = this.rng.range(-0.1, 0.15);
      if (p.lookAt && this.rng.chance(0.5)) p.lookAt = null;
    }
    let hy = p.lookYaw, hp = p.lookPitch;
    if (p.lookAt) {
      const dx = p.lookAt.x - p.x, dz = p.lookAt.z - p.z;
      hy = clamp(wrapAngle(Math.atan2(dx, dz) - p.heading), -1.2, 1.2);
      const dy = p.lookAt.y - (p.y + 1.5 * p.s);
      hp = clamp(-Math.atan2(dy, Math.hypot(dx, dz)), -0.6, 0.6);
    }
    if (p.mode === 'move' && p.speed > 0.3 && !p.lookAt) { hy *= 0.3; hp = 0.05; }
    if (!(ov && (ov.type === 'knock' || ov.type === 'kick'))) {
      o[HY] += hy * 0.75; o[TY] += hy * 0.2;
      if (p.gesture !== 'phone' || p.mode === 'move') o[HP] += hp;
    }
    // 被打中時的反射動作
    if (p.hitT > 0) {
      p.hitT -= dt;
      const k = Math.sin(clamp(p.hitT / 0.7, 0, 1) * Math.PI);
      o[TP] -= 0.35 * k; o[LSP] += 1.1 * k; o[RSP] += 1.1 * k; o[LE] += 1.2 * k; o[RE] += 1.2 * k; o[HP] -= 0.2 * k;
    }
    // 呼吸：跑完步後喘得比較快、比較深，再慢慢恢復
    const exT = clamp((p.speed - 1.6) / 2, 0, 1);
    p.exert += (exT - p.exert) * Math.min(1, dt * (exT > p.exert ? 0.6 : 0.07));
    p.breath += dt * TAU * (0.22 + 0.45 * p.exert);
    const br = Math.sin(p.breath);
    p.breathV = br * (0.6 + 0.9 * p.exert);
    if (!(ov && ov.type === 'knock')) {
      o[TP] += 0.012 * br * (0.6 + p.exert); o[LSR] += 0.012 * br; o[RSR] += 0.012 * br; o[HP] -= 0.008 * br;
    }
    const a = 1 - Math.exp(-p.blend * dt);
    const c = p.cur;
    for (let i = 0; i < NP; i++) c[i] += (o[i] - c[i]) * a;
    p.modeT += dt;
  }

  // ---------------- 骨架：正向運動學 + 腳的 IK → 骨頭貼圖 ----------------
  _legFK(pel, c, L, th, sh, ft) {
    const hpv = L ? c[LHP] : c[RHP], kn = L ? c[LK] : c[RK];
    local(_m, L ? 0.09 : -0.09, 0, 0, -hpv, L ? c[LHT] : -c[RHT], L ? c[LHR] : -c[RHR], 'XZY');
    th.multiplyMatrices(pel, _m);
    local(_m, 0, -0.43, 0, kn, 0, 0);
    sh.multiplyMatrices(th, _m);
    local(_m, 0, -0.42, 0, hpv - kn + c[ANK], 0, 0);
    ft.multiplyMatrices(sh, _m);
  }

  // 兩骨 IK：膝蓋角度由餘弦定理決定，再把大腿繞髖關節轉向目標（保留原本膝蓋朝向的平面）；
  // 腳掌貼合腳下地面的坡度（抬腳時逐漸回到原本的角度）
  _legIK(p, pel, c, L, target, groundY, th, sh, ft) {
    const s = p.s, T = this.terrain;
    const hpv = L ? c[LHP] : c[RHP];
    local(_m, L ? 0.09 : -0.09, 0, 0, -hpv, L ? c[LHT] : -c[RHT], L ? c[LHR] : -c[RHR], 'XZY');
    th.multiplyMatrices(pel, _m);
    _H.setFromMatrixPosition(th);
    const a = 0.43 * s, b = 0.42 * s;
    const d = clamp(_H.distanceTo(target), Math.abs(a - b) + 0.02 * s, (a + b) * 0.9995);
    const kn2 = Math.PI - Math.acos(clamp((a * a + b * b - d * d) / (2 * a * b), -1, 1));
    local(_m, 0, -0.43, 0, kn2, 0, 0);
    sh.multiplyMatrices(th, _m);
    _A.set(0, -0.42, 0).applyMatrix4(sh);
    _v1.subVectors(_A, _H).normalize();
    _v2.subVectors(target, _H).normalize();
    _qr.setFromUnitVectors(_v1, _v2);
    _rot.makeRotationFromQuaternion(_qr);
    _tm.makeTranslation(-_H.x, -_H.y, -_H.z); th.premultiply(_tm);
    th.premultiply(_rot);
    _tm.makeTranslation(_H.x, _H.y, _H.z); th.premultiply(_tm);
    local(_m, 0, -0.43, 0, kn2, 0, 0);
    sh.multiplyMatrices(th, _m);
    _A.set(0, -0.42, 0).applyMatrix4(sh);
    const sn = Math.sin(p.heading), cs = Math.cos(p.heading);
    const hF = T.height(_A.x + sn * 0.12 * s, _A.z + cs * 0.12 * s), hB = T.height(_A.x - sn * 0.06 * s, _A.z - cs * 0.06 * s);
    const slope = clamp(Math.atan2(hF - hB, 0.18 * s), -0.45, 0.45);
    const lift = clamp((_A.y - groundY - 0.075 * s) / (0.12 * s), 0, 1);
    _e.set(c[ANK] + c[BP] - slope * (1 - lift), p.heading, 0, 'YXZ');
    _q2.setFromEuler(_e);
    ft.compose(_A, _q2, _s.set(s, s, s));
  }

  _writeInstances() {
    const M = this.meshes, D = this.boneData;
    if (!M || !D) return;
    const P = this.people, T = this.terrain;
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      const c = p.cur, s = p.s;
      const base = i * BONE_TEXELS * 4;
      _q.setFromAxisAngle(_yAxis, p.heading);
      _root.compose(_p.set(p.x, p.y, p.z), _q, _s.set(s, s, s));
      local(_m, 0, c[PY] + c[BOB], 0, c[BP], 0, c[PR]);
      _pel.multiplyMatrices(_root, _m);
      const ik = IK_MODES.has(p.mode) && !(p.override && p.override.type === 'knock');
      if (ik) {
        // 原本姿勢的腳位 → 依腳下地面高低移動成 IK 目標
        for (let k = 0; k < 2; k++) {
          this._legFK(_pel, c, k === 0, _th, _sh, _ft);
          _tgt[k].setFromMatrixPosition(_ft);
          _ground[k] = T.height(_tgt[k].x, _tgt[k].z);
          _tgt[k].y += _ground[k] - p.y;
        }
        // 重心側移 + 骨盆下沉到較低那隻腳搆得到的高度
        const drop = clamp(p.y - Math.min(_ground[0], _ground[1]), 0, 0.2 * s);
        const px = c[PX] * s;
        _pel.elements[12] += Math.cos(p.heading) * px;
        _pel.elements[13] -= drop;
        _pel.elements[14] -= Math.sin(p.heading) * px;
        let extra = 0;
        for (let k = 0; k < 2; k++) {
          _H.set(k === 0 ? 0.09 : -0.09, 0, 0).applyMatrix4(_pel);
          extra = Math.max(extra, _H.distanceTo(_tgt[k]) - 0.845 * s);
        }
        _pel.elements[13] -= Math.min(Math.max(0, extra), 0.12 * s);
      }
      writeBone(D, base, B.PEL, _pel);
      p.pelM.copy(_pel);
      local(_m, 0, 0, 0, c[TP], c[TY], c[TR], 'YXZ');
      _tor.multiplyMatrices(_pel, _m);
      writeBone(D, base, B.TOR, _tor);
      local(_m, 0, 0.495, 0, c[HP], c[HY], 0, 'YXZ', p.headScale);
      _head.multiplyMatrices(_tor, _m);
      writeBone(D, base, B.HEAD, _head);
      if (p.hairStyle === 'short') M.hairShort.setMatrixAt(p.hairIdx, _head);
      else if (p.hairStyle === 'long') M.hairLong.setMatrixAt(p.hairIdx, _head);
      if (p.hatIdx >= 0) M.hat.setMatrixAt(p.hatIdx, _head);
      p.capB.set(0, 0.17, 0).applyMatrix4(_head);
      p.capA.setFromMatrixPosition(_pel);
      // 手臂
      for (let sIdx = 0; sIdx < 2; sIdx++) {
        const L = sIdx === 0;
        const sx = L ? 0.183 : -0.183;
        local(_m, sx, 0.455, 0, -(L ? c[LSP] : c[RSP]), 0, L ? c[LSR] : -c[RSR]);
        _ua.multiplyMatrices(_tor, _m);
        writeBone(D, base, L ? B.UA_L : B.UA_R, _ua);
        local(_m, 0, -0.29, 0, -(L ? c[LE] : c[RE]), 0, 0);
        _fa.multiplyMatrices(_ua, _m);
        writeBone(D, base, L ? B.FA_L : B.FA_R, _fa);
        if (!L) p.hand.set(0, -0.3, 0).applyMatrix4(_fa);
      }
      // 腿
      _tmpV.set(0, 0, 0);
      for (let sIdx = 0; sIdx < 2; sIdx++) {
        const L = sIdx === 0;
        if (ik) this._legIK(p, _pel, c, L, _tgt[sIdx], _ground[sIdx], _th, _sh, _ft);
        else this._legFK(_pel, c, L, _th, _sh, _ft);
        writeBone(D, base, L ? B.TH_L : B.TH_R, _th);
        writeBone(D, base, L ? B.SH_L : B.SH_R, _sh);
        writeBone(D, base, L ? B.FT_L : B.FT_R, _ft);
        const J = p.legJ, o = sIdx * 3;
        J[o].setFromMatrixPosition(_th); J[o + 1].setFromMatrixPosition(_sh); J[o + 2].setFromMatrixPosition(_ft);
        _tmpV.add(J[o + 2]);
      }
      p.capFeet.copy(_tmpV).multiplyScalar(0.5);
      D[base + NB * 16] = p.breathV;
    }
    this.boneTex.needsUpdate = true;
    for (const k in M) M[k].instanceMatrix.needsUpdate = true;
  }

  // ---------------- 工具 ----------------
  randomLawnPoint(rng, zMin, zMax, margin = 3, xBias = null) {
    const T = this.terrain;
    for (let i = 0; i < 60; i++) {
      const z = rng.range(zMin, zMax);
      const L = T.lawnLeft(z) + margin, R = T.lawnRight(z) - margin;
      let x = xBias ? lerp(L, R, clamp(xBias(rng), 0, 1)) : rng.range(L, R);
      if (T.bunkerWeight(x, z) > 0.05) continue;
      let bad = false;
      for (const b of this.blankets) if (Math.hypot(b.x - x, b.z - z) < Math.max(b.w, b.h) * 0.7 + 1) { bad = true; break; }
      if (bad) continue;
      for (const ob of this.obstacles) if (Math.hypot(ob.x - x, ob.z - z) < ob.r + 1) { bad = true; break; }
      if (bad) continue;
      return { x, z };
    }
    return { x: 0, z: (zMin + zMax) / 2 };
  }
}

function rngSkirt(seed) {
  const opts = ['#f2e6d8', '#d8a7b1', '#2f4f6f', '#f4f1ea', '#c97b4a', '#6b8e5a'];
  return opts[Math.floor(seed) % opts.length];
}

// ==================================================================
// 行為群組
// ==================================================================
function arrived(p, x, z, r = 0.3) { return Math.hypot(p.x - x, p.z - z) < r; }

export class PicnicGroup {
  constructor(crowd, blanket, members, rng) {
    this.crowd = crowd; this.blanket = blanket; this.members = members; this.rng = rng;
    this.awayCount = 0;
    this.canFetch = true;
    const { x, z, rot, w, h } = blanket;
    const c = Math.cos(rot), s = Math.sin(rot);
    // 野餐墊邊緣的座位
    const cand = [];
    const ex = w / 2 - 0.38, ez = h / 2 - 0.38;
    for (const lz of [-ez * 0.5, ez * 0.5]) { cand.push([-ex, lz]); cand.push([ex, lz]); }
    for (const lx of [-w * 0.22, w * 0.22]) { cand.push([lx, -ez]); cand.push([lx, ez]); }
    cand.push([0, 0]);
    for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [cand[i], cand[j]] = [cand[j], cand[i]]; }
    this.slots = [];
    members.forEach((m, i) => {
      const [lx, lz] = cand[i % cand.length];
      const sx = x + lx * c - lz * s, sz = z + lx * s + lz * c;
      const yaw = Math.atan2(x - sx, z - sz) + rng.range(-0.5, 0.5);
      const slot = { x: sx, z: sz, yaw };
      this.slots.push(slot);
      m.pstate = { s: 'sit', t: rng.range(5, 80), slot };
      m.variant = m.child ? rng.pick([0, 1, 4]) : rng.pick([0, 0, 1, 2, 2, 3, 4]);
      if (m.child && rng.chance(0.55)) { m.pstate.s = 'play'; m.pstate.t = 0; }
      if (m.pstate.s === 'sit') { m.x = sx; m.z = sz; m.heading = yaw; m.mode = 'sit'; m.static = true; poseSit(m.cur, m.variant, 0, m.seed); }
      else { m.x = sx + rng.range(-3, 3); m.z = sz + rng.range(-3, 3); }
      m.gesture = 'none';
      m.lie = !m.child && m.variant === 2 && rng.chance(0.25);
    });
  }
  update(dt, t) {
    const rng = this.rng, crowd = this.crowd;
    for (const m of this.members) {
      if (m.override) { m.static = false; continue; }
      const st = m.pstate;
      st.t -= dt;
      switch (st.s) {
        case 'sit': {
          m.static = true; m.goal = null;
          m.mode = m.lie ? 'lie' : 'sit';
          m.faceYaw = st.slot.yaw;
          m.x += (st.slot.x - m.x) * Math.min(1, dt * 3);
          m.z += (st.slot.z - m.z) * Math.min(1, dt * 3);
          m.gestureT -= dt;
          if (m.gestureT < 0) {
            m.gestureT = rng.range(2, 9);
            m.gesture = rng.pick(['none', 'none', 'talk', 'talk', 'eat', 'phone']);
          }
          if (st.t < 0) {
            st.t = rng.range(20, 90);
            if (!m.child && this.awayCount === 0 && rng.chance(0.35)) { st.s = 'standup'; st.t = 1.3; this.awayCount++; m.lie = false; }
            else if (m.child && rng.chance(0.6)) { st.s = 'standup'; st.t = 0.8; st.thenPlay = true; }
            else if (!m.child && (m.variant === 2 || m.variant === 1) && rng.chance(0.3)) { m.lie = !m.lie; m.blend = 3; }
          }
          break;
        }
        case 'standup':
          m.static = false; m.mode = 'stand'; m.blend = 4; m.gesture = 'none';
          if (st.t < 0) {
            m.blend = 10;
            if (st.thenPlay) { st.s = 'play'; st.thenPlay = false; st.t = 0; break; }
            st.s = 'goAway';
            const a = rng.next() * TAU, r = rng.range(6, 22);
            const T = crowd.terrain;
            let tx = this.blanket.x + Math.cos(a) * r, tz = this.blanket.z + Math.sin(a) * r;
            tx = clamp(tx, T.lawnLeft(tz) + 1, T.lawnRight(tz) - 2);
            st.target = { x: tx, z: tz };
          }
          break;
        case 'goAway':
          m.mode = 'move'; m.goal = st.target; m.maxSpeed = 1.2; m.arrive = 0.4;
          if (arrived(m, st.target.x, st.target.z, 0.6)) { st.s = 'away'; st.t = rng.range(4, 14); m.gesture = rng.pick(['none', 'photo', 'phone', 'hips', 'wave']); }
          break;
        case 'away':
          m.mode = 'stand'; m.goal = null;
          m.faceYaw = Math.atan2(this.blanket.x - m.x, this.blanket.z - m.z);
          if (st.t < 0) { st.s = 'return'; m.gesture = 'none'; }
          break;
        case 'return':
          m.mode = 'move'; m.goal = st.slot; m.maxSpeed = m.child ? 2.4 : 1.2; m.arrive = 0.12;
          if (arrived(m, st.slot.x, st.slot.z, 0.35)) { st.s = 'sitdown'; st.t = 1.2; }
          break;
        case 'sitdown':
          m.mode = 'sit'; m.blend = 3.5; m.goal = null; m.faceYaw = st.slot.yaw; m.static = true;
          if (st.t < 0) { st.s = 'sit'; st.t = rng.range(20, 80); m.blend = 10; if (!m.child) this.awayCount = Math.max(0, this.awayCount - 1); }
          break;
        case 'play': {
          // 小孩在野餐墊附近跑來跑去
          m.static = false;
          if (!st.target || st.t < 0) {
            if (st.target && rng.chance(0.12)) { st.s = 'return'; st.target = null; break; }
            const a = rng.next() * TAU, r = rng.range(2, 11);
            const T = crowd.terrain;
            let tx = this.blanket.x + Math.cos(a) * r, tz = this.blanket.z + Math.sin(a) * r;
            tx = clamp(tx, T.lawnLeft(tz) + 0.5, T.lawnRight(tz) - 2);
            st.target = { x: tx, z: tz };
            st.t = rng.range(3, 8);
            st.pause = rng.range(0.5, 3);
            st.run = rng.chance(0.7);
          }
          if (!arrived(m, st.target.x, st.target.z, 0.5)) {
            m.mode = 'move'; m.goal = st.target; m.maxSpeed = st.run ? rng.range(2.6, 3.2) : 1.1; m.arrive = 0.3;
          } else {
            m.goal = null;
            m.mode = st.pause > 1.8 ? 'crouch' : 'stand';
          }
          break;
        }
      }
    }
  }
}

// 草坪上散步的家庭 / 情侶 / 個人
export class WalkGroup {
  constructor(crowd, members, rng, region) {
    this.crowd = crowd; this.members = members; this.rng = rng; this.region = region;
    this.leader = members.find((m) => !m.child) || members[0];
    this.state = 'walk'; this.t = 0;
    this.canFetch = true;
    this.offsets = members.map((m, i) => {
      if (m === this.leader) return { x: 0, z: 0 };
      if (m.child) return { x: rng.range(-2, 2), z: rng.range(-1, 2.5), kid: true };
      const side = i % 2 ? 1 : -1;
      return { x: side * rng.range(0.55, 0.7), z: rng.range(-0.3, 0.1) };
    });
    const start = crowd.randomLawnPoint(rng, region.z0, region.z1, 3);
    members.forEach((m, i) => { m.x = start.x + this.offsets[i].x; m.z = start.z + this.offsets[i].z; });
    this._pick();
    this.speed = rng.range(1.0, 1.4);
  }
  _pick() {
    const r = this.region;
    for (let i = 0; i < 10; i++) {
      const p = this.crowd.randomLawnPoint(this.rng, r.z0, r.z1, 3);
      if (Math.hypot(p.x - this.leader.x, p.z - this.leader.z) > 12) { this.target = p; return; }
    }
    this.target = this.crowd.randomLawnPoint(this.rng, r.z0, r.z1, 3);
  }
  update(dt, t) {
    const rng = this.rng, L = this.leader;
    this.t -= dt;
    if (!L.override) {
      if (this.state === 'walk') {
        L.mode = 'move'; L.goal = this.target; L.maxSpeed = this.speed; L.arrive = 0.5; L.gesture = 'none';
        if (arrived(L, this.target.x, this.target.z, 1.0)) {
          this.state = 'pause'; this.t = rng.range(3, 12);
          L.goal = null; L.mode = 'stand';
          L.gesture = rng.pick(['none', 'photo', 'phone', 'hips', 'none', 'cross']);
        }
      } else {
        L.mode = 'stand'; L.goal = null;
        if (this.t < 0) { this.state = 'walk'; this._pick(); }
      }
    }
    const hx = Math.sin(L.heading), hz = Math.cos(L.heading);
    this.members.forEach((m, i) => {
      if (m === L || m.override) return;
      const o = this.offsets[i];
      if (o.kid) {
        // 小孩繞著大人跑跑停停
        o.t = (o.t ?? 0) - dt;
        if (o.t < 0) { o.t = rng.range(1.5, 4); o.x = rng.range(-3.5, 3.5); o.z = rng.range(-2, 4); o.run = rng.chance(0.5); }
      }
      // 隊形：相對領隊朝向
      const gx = L.x + o.x * hz + o.z * hx, gz = L.z - o.x * hx + o.z * hz;
      const d = Math.hypot(gx - m.x, gz - m.z);
      if (this.state === 'walk' || d > 1.2) {
        m.mode = 'move'; m.goal = { x: gx, z: gz };
        m.maxSpeed = o.kid && o.run ? 2.8 : Math.min(3, this.speed * (d > 1.5 ? 1.8 : 1.05));
        m.arrive = 0.2; m.gesture = 'none';
      } else {
        m.mode = 'stand'; m.goal = null;
        m.faceYaw = Math.atan2(L.x - m.x, L.z - m.z);
        if (!m.child && rng.chance(dt * 0.1)) m.gesture = rng.pick(['none', 'talk', 'phone']);
      }
    });
  }
}

// 沿步道行走
export class PathGroup {
  constructor(crowd, members, rng, t0, dir) {
    this.crowd = crowd; this.members = members; this.rng = rng;
    this.t = t0; this.dir = dir;
    this.speed = rng.range(1.05, 1.45);
    this.canFetch = false;
    this.side = rng.range(0.35, 0.75);
    const T = crowd.terrain;
    const pt = T.pathPoint(t0);
    members.forEach((m, i) => {
      const lat = (dir > 0 ? this.side : -this.side) + (i - (members.length - 1) / 2) * 0.62;
      m.x = pt.x - pt.tz * lat; m.z = pt.z + pt.tx * lat;
      m.heading = Math.atan2(pt.tx * dir, pt.tz * dir);
    });
    this._pt = { x: 0, z: 0, tx: 0, tz: 0 };
  }
  update(dt) {
    const T = this.crowd.terrain;
    // 以最慢成員的進度推進
    let lag = 0;
    const pt = T.pathPoint(this.t, this._pt);
    for (const m of this.members) {
      const along = (m.x - pt.x) * pt.tx + (m.z - pt.z) * pt.tz;
      lag = Math.min(lag, along * this.dir);
    }
    const sp = lag < -2 ? this.speed * 0.3 : this.speed;
    this.t += (this.dir * sp * dt) / T.pathLength;
    if (this.t > 0.985) { this.t = 0.985; this.dir = -1; }
    if (this.t < 0.004) { this.t = 0.004; this.dir = 1; }
    const ahead = T.pathPoint(clamp(this.t + (this.dir * 1.6) / T.pathLength, 0, 1), this._pt);
    this.members.forEach((m, i) => {
      if (m.override) return;
      const lat = (this.dir > 0 ? this.side : -this.side) + (i - (this.members.length - 1) / 2) * 0.62;
      const nx = -ahead.tz, nz = ahead.tx;
      m.mode = 'move';
      m.goal = { x: ahead.x + nx * lat, z: ahead.z + nz * lat };
      m.maxSpeed = this.speed * 1.15; m.arrive = 0.05;
    });
  }
}

// 足球小組
export class SoccerGroup {
  constructor(crowd, members, ball, center, rng, opts = {}) {
    this.crowd = crowd; this.members = members; this.ball = ball; this.center = center; this.rng = rng;
    this.radius = opts.radius ?? 7;
    this.chaser = null; this.cool = 0;
    this.canFetch = false;
    ball.owner = this;
    this.spots = members.map((m, i) => {
      const a = (i / members.length) * TAU + rng.range(-0.3, 0.3);
      return { x: center.x + Math.cos(a) * this.radius, z: center.z + Math.sin(a) * this.radius * 0.8 };
    });
    members.forEach((m, i) => { m.x = this.spots[i].x; m.z = this.spots[i].z; });
    this.passSpeed = opts.passSpeed ?? 1;
  }
  update(dt) {
    const b = this.ball, rng = this.rng;
    this.cool -= dt;
    // 選出離球最近的人去追球（有遲滯，避免來回切換）
    let best = null, bd = 1e9;
    for (const m of this.members) {
      if (m.override && m.override.type !== 'kick') continue;
      const d = Math.hypot(m.x - b.pos.x, m.z - b.pos.z) - (m === this.chaser ? 1.5 : 0);
      if (d < bd) { bd = d; best = m; }
    }
    if (this.cool <= 0) this.chaser = best;
    const ballSpeed = b.vel.length();
    for (let i = 0; i < this.members.length; i++) {
      const m = this.members[i];
      if (m.override) continue;
      if (m === this.chaser && ballSpeed < 6) {
        // 決定傳給誰
        if (!this.receiver || this.receiver === m) {
          const others = this.members.filter((q) => q !== m);
          this.receiver = rng.pick(others);
        }
        const R = this.receiver;
        const far = Math.hypot(b.pos.x - this.center.x, b.pos.z - this.center.z) > this.radius * 2.2;
        const tx = far ? this.center.x - b.pos.x : R.x - b.pos.x;
        const tz = far ? this.center.z - b.pos.z : R.z - b.pos.z;
        const d = Math.hypot(tx, tz);
        const speed = clamp(Math.sqrt(2 * 1.35 * d) + 1.2, 3, 13) * this.passSpeed;
        if (this.crowd.goKick(m, b, tx, tz, speed, rng.chance(0.2) ? 0.35 : 0.06, true)) {
          this.cool = 1.4;
          this.chaser = null;
          this.lastReceiver = R;
          this.receiver = null;
        }
      } else {
        // 回到站位，面向球
        const sp = this.spots[i];
        const toBallX = b.pos.x - sp.x, toBallZ = b.pos.z - sp.z;
        const gx = sp.x + clamp(toBallX * 0.15, -2, 2), gz = sp.z + clamp(toBallZ * 0.15, -2, 2);
        if (Math.hypot(gx - m.x, gz - m.z) > 0.8) {
          m.mode = 'move'; m.goal = { x: gx, z: gz }; m.maxSpeed = 1.6; m.arrive = 0.4;
        } else {
          m.mode = 'stand'; m.goal = null;
        }
        m.faceYaw = Math.atan2(b.pos.x - m.x, b.pos.z - m.z);
        m.lookAt = b.pos;
        m.gesture = this.lastReceiver === m && ballSpeed > 2 ? 'catch-ready' : 'none';
      }
    }
  }
}

// 推大顆充氣足球的小孩
export class GiantBallGroup {
  constructor(crowd, kids, adults, ball, home, rng) {
    this.crowd = crowd; this.members = [...kids, ...adults]; this.kids = kids; this.adults = adults;
    this.ball = ball; this.home = home; this.rng = rng;
    this.canFetch = false;
    ball.owner = this;
    kids.forEach((k) => { k.x = home.x + rng.range(-3, 3); k.z = home.z + rng.range(-3, 3); k.cool = rng.range(0, 2); });
    adults.forEach((a, i) => { a.x = home.x - 3 + i * 1.2; a.z = home.z + 3.5; a.gesture = i === 0 ? 'photo' : 'cross'; });
  }
  update(dt) {
    const b = this.ball, rng = this.rng;
    for (const k of this.kids) {
      if (k.override) continue;
      k.cool -= dt;
      const d = Math.hypot(b.pos.x - k.x, b.pos.z - k.z);
      if (k.cool < 0) {
        const far = Math.hypot(b.pos.x - this.home.x, b.pos.z - this.home.z) > 9;
        const a = rng.next() * TAU;
        const tx = far ? this.home.x - b.pos.x : Math.cos(a), tz = far ? this.home.z - b.pos.z : Math.sin(a);
        if (this.crowd.goKick(k, b, tx, tz, rng.range(3, 5.5), 0.45, true)) k.cool = rng.range(1.5, 4);
      } else {
        // 跟在球附近
        if (d > 3.5) { k.mode = 'move'; k.goal = { x: b.pos.x + rng.range(-1, 1), z: b.pos.z + rng.range(-1, 1) }; k.maxSpeed = 2.6; k.arrive = 2.2; }
        else { k.mode = 'stand'; k.goal = null; k.faceYaw = Math.atan2(b.pos.x - k.x, b.pos.z - k.z); }
      }
    }
    for (const a of this.adults) {
      if (a.override) continue;
      const d = Math.hypot(b.pos.x - a.x, b.pos.z - a.z);
      if (d > 9) { a.mode = 'move'; a.goal = { x: b.pos.x + 3, z: b.pos.z + 3 }; a.maxSpeed = 1.2; a.arrive = 2; }
      else { a.mode = 'stand'; a.goal = null; a.faceYaw = Math.atan2(b.pos.x - a.x, b.pos.z - a.z); }
      a.lookAt = b.pos;
    }
  }
}

// 站著聊天
export class ChatGroup {
  constructor(crowd, members, center, rng) {
    this.crowd = crowd; this.members = members; this.center = center; this.rng = rng;
    this.canFetch = true;
    members.forEach((m, i) => {
      const a = (i / members.length) * TAU + rng.range(-0.25, 0.25);
      const r = 0.55 + members.length * 0.12;
      m.home = { x: center.x + Math.cos(a) * r, z: center.z + Math.sin(a) * r };
      m.x = m.home.x; m.z = m.home.z;
      m.gesture = 'none';
    });
  }
  update(dt) {
    const rng = this.rng;
    for (const m of this.members) {
      if (m.override) continue;
      if (Math.hypot(m.home.x - m.x, m.home.z - m.z) > 0.4) { m.mode = 'move'; m.goal = m.home; m.maxSpeed = 1.1; m.arrive = 0.15; }
      else { m.mode = 'stand'; m.goal = null; m.faceYaw = Math.atan2(this.center.x - m.x, this.center.z - m.z); }
      m.gestureT -= dt;
      if (m.gestureT < 0) { m.gestureT = rng.range(2, 7); m.gesture = rng.pick(['none', 'talk', 'talk', 'cross', 'hips', 'phone']); }
    }
  }
}

// 坐長椅
export class BenchGroup {
  constructor(crowd, members, bench, rng) {
    this.crowd = crowd; this.members = members; this.bench = bench; this.rng = rng;
    this.canFetch = false;
    members.forEach((m, i) => {
      const off = (i - (members.length - 1) / 2) * 0.62;
      const c = Math.cos(bench.rot), s = Math.sin(bench.rot);
      m.x = bench.x + off * c; m.z = bench.z - off * s;
      m.heading = bench.rot; m.faceYaw = bench.rot;
      m.mode = 'bench'; m.static = true;
      m.gesture = rng.chance(0.4) ? 'phone' : 'none';
      poseBench(m.cur, 0, m.seed);
    });
  }
  update() { for (const m of this.members) if (!m.override) { m.mode = 'bench'; m.static = true; m.faceYaw = this.bench.rot; } }
}

// 丟飛盤
export class FrisbeeGroup {
  constructor(crowd, members, disc, a, b, rng) {
    this.crowd = crowd; this.members = members; this.disc = disc; this.rng = rng;
    this.spots = [a, b];
    this.canFetch = false;
    members[0].x = a.x; members[0].z = a.z; members[1].x = b.x; members[1].z = b.z;
    disc.held = members[0];
    this.holder = members[0];
    this.wait = 2;
  }
  update(dt) {
    const d = this.disc, rng = this.rng, phys = this.crowd.physics;
    const [A, B] = this.members;
    if (d.held) {
      const h = d.held;
      const other = h === A ? B : A;
      h.goal = null;
      h.faceYaw = Math.atan2(other.x - h.x, other.z - h.z);
      this.wait -= dt;
      if (this.wait < 0.6 && h.mode !== 'throw') { h.mode = 'throw'; h.modeT = 0; }
      if (h.mode === 'throw') {
        h.modeT += dt * 1.6;
        if (h.modeT > 0.62 && d.held) {
          // 出手：朝隊友方向，速度依距離
          const dx = other.x - h.x, dz = other.z - h.z;
          const dist = Math.hypot(dx, dz);
          const v = 6.5 + dist * 0.32;
          d.held = null; d.flying = true; d.onGround = false;
          d.pos.copy(h.hand);
          d.vel.set((dx / dist) * v, 1.0 + dist * 0.03, (dz / dist) * v);
          d.spin = 40; d.alpha0 = rng.range(0.08, 0.14);
          this.catcher = other;
        }
      } else h.mode = 'stand';
      // 手上的飛盤
      if (d.held) d.pos.copy(h.hand);
      return;
    }
    for (const m of this.members) if (m.mode === 'throw' && m.modeT > 1) m.mode = 'stand';
    // 接盤者移動到預測落點
    const C = this.catcher || A;
    const O = C === A ? B : A;
    if (d.flying) {
      const px = d.pos.x + d.vel.x * 0.5, pz = d.pos.z + d.vel.z * 0.5;
      C.mode = 'move'; C.goal = { x: px, z: pz }; C.maxSpeed = 3.2; C.arrive = 0.3;
      C.lookAt = d.pos;
      const hd = Math.hypot(d.pos.x - C.x, d.pos.z - C.z);
      const hy = d.pos.y - C.y;
      if (hd < 0.9 * C.s + 0.3 && hy > 0.4 * C.s && hy < 2.3 * C.s) {
        d.held = C; d.flying = false; d.vel.set(0, 0, 0);
        C.mode = 'catch'; C.goal = null;
        this.wait = rng.range(1.5, 3.0);
        C.lookAt = null;
        // 換邊：回到自己的位置
        this.spots[this.members.indexOf(C)] = { x: C.x, z: C.z };
      }
      O.mode = 'stand'; O.goal = null; O.faceYaw = Math.atan2(d.pos.x - O.x, d.pos.z - O.z); O.lookAt = d.pos;
    } else if (d.onGround) {
      // 掉地上：走過去撿
      C.mode = 'move'; C.goal = { x: d.pos.x, z: d.pos.z }; C.maxSpeed = 1.6; C.arrive = 0.4; C.lookAt = null;
      if (arrived(C, d.pos.x, d.pos.z, 0.7)) {
        C.mode = 'crouch';
        C.pickT = (C.pickT ?? 0) + dt;
        if (C.pickT > 0.8) {
          C.pickT = 0; d.held = C; d.onGround = false; this.wait = rng.range(1.5, 2.5);
          // 若離太遠，走回去
          const sp = this.spots[this.members.indexOf(C)];
          if (Math.hypot(sp.x - C.x, sp.z - C.z) > 18) this.spots[this.members.indexOf(C)] = { x: (C.x + O.x) / 2 + (C.x - O.x) * 0.2, z: (C.z + O.z) / 2 };
        }
      }
    }
    if (d.held && d.held.mode === 'catch') { /* 停留一下 */ }
  }
}

// 小孩玩鬼抓人
export class TagGroup {
  constructor(crowd, kids, center, rng) {
    this.crowd = crowd; this.members = kids; this.center = center; this.rng = rng;
    this.it = kids[0]; this.cool = 0;
    this.canFetch = true;
    kids.forEach((k) => { k.x = center.x + rng.range(-4, 4); k.z = center.z + rng.range(-4, 4); });
  }
  update(dt) {
    const rng = this.rng, it = this.it;
    this.cool -= dt;
    let target = null, td = 1e9;
    for (const k of this.members) {
      if (k === it) continue;
      const d = Math.hypot(k.x - it.x, k.z - it.z);
      if (d < td) { td = d; target = k; }
    }
    if (!it.override) {
      if (this.cool > 0) { it.mode = 'stand'; it.goal = null; it.gesture = 'none'; }
      else { it.mode = 'move'; it.goal = { x: target.x, z: target.z }; it.maxSpeed = 3.1; it.arrive = 0.1; }
    }
    if (target && td < 0.55 && this.cool <= 0) { this.it = target; this.cool = 2; }
    for (const k of this.members) {
      if (k === it || k.override) continue;
      const dx = k.x - it.x, dz = k.z - it.z, d = Math.hypot(dx, dz) || 1;
      if (d < 6) {
        // 逃跑，但留在中心附近
        let fx = dx / d + (this.center.x - k.x) * 0.06, fz = dz / d + (this.center.z - k.z) * 0.06;
        const fl = Math.hypot(fx, fz) || 1;
        k.mode = 'move'; k.goal = { x: k.x + (fx / fl) * 3, z: k.z + (fz / fl) * 3 }; k.maxSpeed = 2.9; k.arrive = 0.1;
      } else {
        k.wanderT = (k.wanderT ?? 0) - dt;
        if (k.wanderT < 0) { k.wanderT = rng.range(1, 3); k.wander = { x: this.center.x + rng.range(-6, 6), z: this.center.z + rng.range(-6, 6) }; }
        k.mode = 'move'; k.goal = k.wander; k.maxSpeed = 1.4; k.arrive = 0.5;
        k.lookAt = null;
      }
    }
  }
}
