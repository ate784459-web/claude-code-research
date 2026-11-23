import * as THREE from 'three';
import { smoothstep } from './noise.js';

// ==================================================================
// 連續的人體網格 + GPU 蒙皮
// 全身是一張網格（軀幹到脖子一體、手臂與腿是連續的管狀曲面），每個頂點綁到最多 4 根骨頭，
// 關節處的權重平滑過渡，所以手肘、膝蓋、腰、肩膀彎曲時是連續變形，不再是一節節剛體。
// 所有人共用這張網格，以 instancing 一次畫完；每人的 13 根骨頭矩陣每幀寫進一張浮點貼圖，
// 頂點著色器依 gl_InstanceID 讀出來做線性混合蒙皮。
// 衣服不是另外的網格：依部位與「沿著肢體的位置」在著色器裡決定是上衣、褲子、皮膚還是鞋，
// 所以每個人的袖長、褲長、領口、腰線都可以不同。
// ==================================================================

// 骨頭索引
export const B = { PEL: 0, TOR: 1, HEAD: 2, UA_L: 3, FA_L: 4, UA_R: 5, FA_R: 6, TH_L: 7, SH_L: 8, FT_L: 9, TH_R: 10, SH_R: 11, FT_R: 12 };
export const NB = 13;
// 綁定姿勢（站直、手臂下垂）下各骨頭原點，單位為 1.7 m 身高的人
export const BIND = [
  [0, 0.92, 0], [0, 0.92, 0], [0, 1.415, 0],
  [0.183, 1.375, 0], [0.183, 1.085, 0], [-0.183, 1.375, 0], [-0.183, 1.085, 0],
  [0.09, 0.92, 0], [0.09, 0.49, 0], [0.09, 0.07, 0], [-0.09, 0.92, 0], [-0.09, 0.49, 0], [-0.09, 0.07, 0],
];
export const BONE_TEXELS = NB * 4 + 1; // 每人：13 個 mat4 + 1 個額外資料（呼吸）

// 部位代碼（aRegion.x）
const R_SKIN = 0, R_TORSO = 1, R_ARM = 2, R_LEG = 3, R_SHOE = 4, R_FACE = 5;

// ------------------------------------------------------------------
// 幾何建構工具
// ------------------------------------------------------------------
class Part {
  constructor() { this.pos = []; this.uv = []; this.idx = []; this.bones = []; this.weights = []; this.axis = []; this.region = []; }
  get n() { return this.pos.length / 3; }
  vert(x, y, z, bw, axis, region, along, u = 0, v = 0) {
    this.pos.push(x, y, z);
    this.uv.push(u, v);
    // bw：[[bone, weight], ...] → 正規化、補滿 4 個
    const list = bw.filter((e) => e[1] > 1e-3).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = list.reduce((s, e) => s + e[1], 0) || 1;
    for (let k = 0; k < 4; k++) {
      this.bones.push(list[k] ? list[k][0] : 0);
      this.weights.push(list[k] ? list[k][1] / sum : 0);
    }
    this.axis.push(axis[0], axis[1], axis[2]);
    this.region.push(region, along);
    return this.n - 1;
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aBones', new THREE.Float32BufferAttribute(this.bones, 4));
    g.setAttribute('aWeights', new THREE.Float32BufferAttribute(this.weights, 4));
    g.setAttribute('aAxis', new THREE.Float32BufferAttribute(this.axis, 3));
    g.setAttribute('aRegion', new THREE.Float32BufferAttribute(this.region, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

// 沿 Y 軸放樣的管子：rings = [{ y, w, d, cx, cz }]，每圈為橢圓；上下自動封口
function loftY(part, rings, S, info) {
  const base = part.n;
  for (const r of rings) {
    for (let a = 0; a < S; a++) {
      const t = (a / S) * Math.PI * 2;
      const x = r.cx + r.w * Math.sin(t), z = r.cz + r.d * Math.cos(t);
      part.vert(x, r.y, z, info.weights(r.y, x, z), [r.cx, r.y, r.cz], info.region, info.along(r.y));
    }
  }
  const NR = rings.length;
  for (let k = 0; k < NR - 1; k++) {
    for (let a = 0; a < S; a++) {
      const i0 = base + k * S + a, i1 = base + k * S + ((a + 1) % S);
      const j0 = i0 + S, j1 = i1 + S;
      // 由下往上（y 遞減時翻轉繞向）
      if (rings[k + 1].y > rings[k].y) part.idx.push(i0, i1, j0, i1, j1, j0);
      else part.idx.push(i0, j0, i1, i1, j0, j1);
    }
  }
  for (const end of [0, NR - 1]) {
    const r = rings[end];
    const dir = (end === 0) === (rings[NR - 1].y > rings[0].y) ? -1 : 1; // 封口往外凸一點
    const cy = r.y + dir * Math.min(r.w, r.d) * 0.35;
    const c = part.vert(r.cx, cy, r.cz, info.weights(cy, r.cx, r.cz), [r.cx, cy, r.cz], info.region, info.along(cy));
    for (let a = 0; a < S; a++) {
      const i0 = base + end * S + a, i1 = base + end * S + ((a + 1) % S);
      if (dir > 0) part.idx.push(i0, i1, c); else part.idx.push(i1, i0, c);
    }
  }
}

// 由剖面表內插出一圈圈
function sampleProfile(rows, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const f = t * (rows.length - 1);
    const k = Math.min(rows.length - 2, Math.floor(f)), u = f - k;
    const a = rows[k], b = rows[k + 1];
    const s = u * u * (3 - 2 * u) * 0.35 + u * 0.65; // 稍微平滑
    out.push(a.map((v, j) => v + (b[j] - v) * s));
  }
  return out;
}

// 橢球（手、耳朵等小部位）
function ellipsoid(part, c, r, wS, hS, bw, region) {
  const base = part.n;
  for (let j = 0; j <= hS; j++) {
    const th = (j / hS) * Math.PI;
    for (let i = 0; i < wS; i++) {
      const ph = (i / wS) * Math.PI * 2;
      const x = c[0] + r[0] * Math.sin(th) * Math.sin(ph), y = c[1] + r[1] * Math.cos(th), z = c[2] + r[2] * Math.sin(th) * Math.cos(ph);
      part.vert(x, y, z, bw, c, region, 0);
    }
  }
  for (let j = 0; j < hS; j++) {
    for (let i = 0; i < wS; i++) {
      const a = base + j * wS + i, b = base + j * wS + ((i + 1) % wS), cc = a + wS, d = b + wS;
      part.idx.push(a, cc, b, b, cc, d);
    }
  }
}

// ------------------------------------------------------------------
// 人體
// ------------------------------------------------------------------
export function buildBodyGeometry(detail = 1) {
  const hi = detail >= 1;
  const P = new Part();

  // ---- 軀幹 + 骨盆 + 脖子（一體）----
  // [y, 半寬, 半厚, 前後偏移]
  const torsoRows = [
    [0.775, 0.07, 0.05, 0.0], [0.80, 0.135, 0.092, -0.004], [0.85, 0.158, 0.106, -0.012], [0.90, 0.163, 0.106, -0.012],
    [0.95, 0.155, 0.098, -0.004], [1.0, 0.143, 0.088, 0.004], [1.06, 0.14, 0.088, 0.008], [1.13, 0.148, 0.094, 0.013],
    [1.2, 0.158, 0.103, 0.018], [1.26, 0.163, 0.105, 0.016], [1.32, 0.163, 0.097, 0.006], [1.37, 0.148, 0.084, -0.004],
    [1.405, 0.12, 0.07, -0.006], [1.43, 0.068, 0.056, -0.002], [1.45, 0.05, 0.049, 0.002], [1.5, 0.046, 0.046, 0.006], [1.54, 0.043, 0.043, 0.01],
  ];
  const torsoRings = sampleProfile(torsoRows, hi ? 24 : 15).map(([y, w, d, cz]) => ({ y, w, d, cx: 0, cz }));
  loftY(P, torsoRings, hi ? 18 : 12, {
    region: R_TORSO,
    along: (y) => y,
    weights: (y) => {
      const wp = 1 - smoothstep(0.9, 1.05, y), wh = smoothstep(1.43, 1.51, y);
      return [[B.PEL, wp], [B.TOR, Math.max(0, 1 - wp - wh)], [B.HEAD, wh]];
    },
  });

  // ---- 手臂（肩 → 腕，一條連續的管子）----
  const armRows = [
    [0.035, 0.026], [0.02, 0.044], [0.0, 0.052], [-0.06, 0.05], [-0.15, 0.047], [-0.23, 0.042], [-0.29, 0.037],
    [-0.335, 0.04], [-0.42, 0.035], [-0.5, 0.029], [-0.55, 0.025],
  ];
  for (const side of [1, -1]) {
    const L = side > 0;
    const sx = 0.183 * side;
    const rings = sampleProfile(armRows, hi ? 16 : 10).map(([yr, r]) => ({ y: 1.375 + yr, w: r, d: r * 0.95, cx: sx - side * 0.004 * smoothstep(0, -0.5, yr), cz: 0 }));
    loftY(P, rings, hi ? 10 : 7, {
      region: R_ARM,
      along: (y) => THREE.MathUtils.clamp((1.375 - y) / 0.55, 0, 1),
      weights: (y) => {
        const yr = y - 1.375;
        const wt = smoothstep(0.0, 0.04, yr) * 0.4;
        const wf = smoothstep(-0.25, -0.33, yr);
        return [[B.TOR, wt], [L ? B.UA_L : B.UA_R, Math.max(0, 1 - wt - wf)], [L ? B.FA_L : B.FA_R, wf]];
      },
    });
    // 手：掌心朝向身體（綁定姿勢）、拇指在前
    const fa = L ? B.FA_L : B.FA_R;
    ellipsoid(P, [sx - side * 0.004, 0.792, 0.004], [0.019, 0.045, 0.033], hi ? 10 : 7, hi ? 7 : 5, [[fa, 1]], R_SKIN);
    ellipsoid(P, [sx - side * 0.011, 0.81, 0.029], [0.011, 0.023, 0.011], 6, 4, [[fa, 1]], R_SKIN);
  }

  // ---- 腿（髖 → 踝）----
  const legRows = [
    [0.045, 0.06, 0.0], [0.0, 0.086, -0.004], [-0.06, 0.088, 0.0], [-0.18, 0.078, 0.004], [-0.32, 0.063, 0.006],
    [-0.43, 0.053, 0.01], [-0.5, 0.057, -0.004], [-0.58, 0.06, -0.012], [-0.69, 0.046, -0.006], [-0.79, 0.034, 0.0], [-0.83, 0.032, 0.0],
  ];
  for (const side of [1, -1]) {
    const L = side > 0;
    const sx = 0.09 * side;
    const rings = sampleProfile(legRows, hi ? 18 : 11).map(([yr, r, cz]) => ({ y: 0.92 + yr, w: r, d: r * 0.97, cx: sx, cz }));
    loftY(P, rings, hi ? 12 : 8, {
      region: R_LEG,
      along: (y) => THREE.MathUtils.clamp((0.92 - y) / 0.85, 0, 1),
      weights: (y) => {
        const yr = y - 0.92;
        const wp = smoothstep(-0.03, 0.045, yr) * 0.7;
        const ws = smoothstep(-0.39, -0.47, yr);
        const wfoot = smoothstep(-0.78, -0.84, yr) * 0.35;
        return [[B.PEL, wp], [L ? B.TH_L : B.TH_R, Math.max(0, 1 - wp - ws)], [L ? B.SH_L : B.SH_R, ws * (1 - wfoot)], [L ? B.FT_L : B.FT_R, ws * wfoot]];
      },
    });
    // ---- 鞋：沿 z 放樣的圓角方塊 ----
    const ft = L ? B.FT_L : B.FT_R, sh = L ? B.SH_L : B.SH_R;
    const shoeRows = [ // [z, 半寬, 頂高, 底高]（相對腳踝）
      [-0.07, 0.03, -0.015, -0.07], [-0.055, 0.037, 0.0, -0.072], [-0.02, 0.04, 0.005, -0.072], [0.03, 0.044, -0.018, -0.072],
      [0.09, 0.048, -0.034, -0.072], [0.14, 0.044, -0.045, -0.071], [0.17, 0.034, -0.052, -0.068], [0.18, 0.02, -0.058, -0.064],
    ];
    const SS = hi ? 12 : 8;
    const base = P.n;
    for (const [z, w, top, bot] of shoeRows) {
      const cy = (top + bot) / 2, hh = (top - bot) / 2;
      for (let a = 0; a < SS; a++) {
        const t = (a / SS) * Math.PI * 2;
        const sn = Math.sin(t), cs = Math.cos(t);
        // 超橢圓：底部平、上方圓
        const ex = Math.sign(sn) * Math.pow(Math.abs(sn), 0.6), ey = Math.sign(cs) * Math.pow(Math.abs(cs), cs < 0 ? 0.35 : 0.8);
        const x = sx + w * ex, y = 0.07 + cy + hh * ey;
        const wsh = smoothstep(-0.03, 0.005, cy + hh * ey) * (1 - smoothstep(-0.03, 0.03, z)) * 0.45;
        P.vert(x, y, z, [[ft, 1 - wsh], [sh, wsh]], [x, y, z], R_SHOE, 0);
      }
    }
    const NR = shoeRows.length;
    for (let k = 0; k < NR - 1; k++) {
      for (let a = 0; a < SS; a++) {
        const i0 = base + k * SS + a, i1 = base + k * SS + ((a + 1) % SS);
        P.idx.push(i0, i0 + SS, i1, i1, i0 + SS, i1 + SS);
      }
    }
    for (const end of [0, NR - 1]) {
      const [z, , top, bot] = shoeRows[end];
      const c = P.vert(sx, 0.07 + (top + bot) / 2, z + (end ? 0.006 : -0.006), [[ft, 1]], [sx, 0, z], R_SHOE, 0);
      for (let a = 0; a < SS; a++) {
        const i0 = base + end * SS + a, i1 = base + end * SS + ((a + 1) % SS);
        if (end) P.idx.push(i0, c, i1); else P.idx.push(i1, c, i0);
      }
    }
  }

  // ---- 頭：頭顱（下顎收窄、後腦較圓）+ 鼻子 + 耳朵 ----
  {
    const skull = new THREE.SphereGeometry(1, hi ? 24 : 16, hi ? 18 : 12);
    const sp = skull.attributes.position, su = skull.attributes.uv;
    const base = P.n;
    const C = [0, 1.415 + 0.17, 0.012];
    for (let i = 0; i < sp.count; i++) {
      let x = sp.getX(i), y = sp.getY(i), z = sp.getZ(i);
      const jaw = smoothstep(0.05, -0.85, y);
      x *= 1 - 0.24 * jaw;
      z *= 1 - 0.1 * jaw * smoothstep(0.2, -0.6, z);
      z += 0.1 * jaw * Math.max(0, z) * 0.6;
      const back = smoothstep(0.1, -0.9, z) * smoothstep(-0.2, 0.5, y);
      z *= 1 + 0.06 * back;
      P.vert(C[0] + x * 0.09, C[1] + y * 0.112, C[2] + z * 0.1, [[B.HEAD, 1]], C, R_FACE, 0, su.getX(i), su.getY(i));
    }
    const si = skull.index.array;
    for (let i = 0; i < si.length; i++) P.idx.push(base + si[i]);
    // 鼻子：小楔形
    const nb = P.n;
    const ny = 1.415 + 0.158, nz = 0.105;
    const nose = [[0, ny + 0.022, nz - 0.006], [-0.014, ny - 0.012, nz - 0.004], [0.014, ny - 0.012, nz - 0.004], [0, ny - 0.014, nz + 0.024], [0, ny - 0.018, nz]];
    for (const v of nose) P.vert(v[0], v[1], v[2], [[B.HEAD, 1]], v, R_SKIN, 0);
    P.idx.push(nb, nb + 1, nb + 3, nb, nb + 3, nb + 2, nb + 1, nb + 4, nb + 3, nb + 2, nb + 3, nb + 4);
    for (const s of [1, -1]) ellipsoid(P, [s * 0.086, 1.415 + 0.165, 0.0], [0.011, 0.024, 0.017], 6, 5, [[B.HEAD, 1]], R_SKIN);
  }

  return P.geometry();
}

// ------------------------------------------------------------------
// 臉部細節貼圖（乘在膚色上）：眼睛、眉毛、嘴唇、臉頰
// ------------------------------------------------------------------
export function makeFaceTexture() {
  const W = 512, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  // 頭顱 uv：u = 0.25 是臉的正中央，v = 0.5 是赤道（canvas y 由上往下 = 1 - uv.y）
  const cx = 0.25 * W;
  const px = (du) => cx + du * W, py = (v) => v * H;
  for (const s of [-1, 1]) {
    // 眼窩陰影
    g.fillStyle = 'rgba(150,110,100,0.35)';
    g.beginPath(); g.ellipse(px(s * 0.066), py(0.465), 15, 8, 0, 0, Math.PI * 2); g.fill();
    // 眼白
    g.fillStyle = '#f2eee8';
    g.beginPath(); g.ellipse(px(s * 0.066), py(0.47), 10, 5.2, 0, 0, Math.PI * 2); g.fill();
    // 虹膜 / 瞳孔
    g.fillStyle = '#2a1a12';
    g.beginPath(); g.ellipse(px(s * 0.064), py(0.47), 5.2, 5.2, 0, 0, Math.PI * 2); g.fill();
    // 上眼瞼
    g.strokeStyle = 'rgba(40,25,20,0.9)'; g.lineWidth = 2.2;
    g.beginPath(); g.ellipse(px(s * 0.066), py(0.47), 10.5, 5.5, 0, Math.PI * 1.08, Math.PI * 1.92); g.stroke();
    // 眉毛
    g.strokeStyle = 'rgba(55,38,30,0.85)'; g.lineWidth = 4.5; g.lineCap = 'round';
    g.beginPath(); g.moveTo(px(s * 0.035), py(0.418)); g.quadraticCurveTo(px(s * 0.07), py(0.4), px(s * 0.1), py(0.418)); g.stroke();
    // 臉頰微紅
    const gr = g.createRadialGradient(px(s * 0.085), py(0.56), 1, px(s * 0.085), py(0.56), 22);
    gr.addColorStop(0, 'rgba(235,170,160,0.35)'); gr.addColorStop(1, 'rgba(235,170,160,0)');
    g.fillStyle = gr; g.fillRect(px(s * 0.085) - 24, py(0.56) - 24, 48, 48);
  }
  // 嘴唇
  g.fillStyle = 'rgba(190,105,100,0.85)';
  g.beginPath(); g.ellipse(cx, py(0.655), 16, 4.5, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(90,40,40,0.7)'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(cx - 15, py(0.655)); g.quadraticCurveTo(cx, py(0.662), cx + 15, py(0.655)); g.stroke();
  // 鼻翼陰影
  g.fillStyle = 'rgba(160,110,100,0.25)';
  g.beginPath(); g.ellipse(cx, py(0.585), 10, 4, 0, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ------------------------------------------------------------------
// 著色器注入
// ------------------------------------------------------------------
const SKIN_PARS = /* glsl */ `
attribute vec4 aBones; attribute vec4 aWeights; attribute vec3 aAxis; attribute vec2 aRegion;
attribute vec3 iTop; attribute vec3 iBottom; attribute vec3 iSkin; attribute vec3 iShoe;
attribute vec4 iCloth; attribute vec4 iShape;
uniform sampler2D uBones;
mat4 boneMat(float b) {
  int x = int(b + 0.5) * 4;
  return mat4(texelFetch(uBones, ivec2(x, gl_InstanceID), 0), texelFetch(uBones, ivec2(x + 1, gl_InstanceID), 0),
              texelFetch(uBones, ivec2(x + 2, gl_InstanceID), 0), texelFetch(uBones, ivec2(x + 3, gl_InstanceID), 0));
}
mat4 bodySkinMat() {
  mat4 m = aWeights.x * boneMat(aBones.x);
  if (aWeights.y > 0.0) m += aWeights.y * boneMat(aBones.y);
  if (aWeights.z > 0.0) m += aWeights.z * boneMat(aBones.z);
  if (aWeights.w > 0.0) m += aWeights.w * boneMat(aBones.w);
  return m;
}
// 體型：依部位把頂點相對骨軸縮放（肩寬、臀寬、胸厚、四肢粗細）；呼吸時胸腔起伏
vec3 bodyShape(vec3 p) {
  vec3 off = p - aAxis;
  float reg = aRegion.x;
  if (reg > 0.5 && reg < 1.5) {
    float k = smoothstep(0.95, 1.3, p.y);
    off.x *= mix(iShape.y, iShape.x, k);
    off.z *= iShape.z;
    float breath = texelFetch(uBones, ivec2(${NB * 4}, gl_InstanceID), 0).x;
    off.xz *= 1.0 + breath * 0.035 * smoothstep(1.02, 1.2, p.y) * (1.0 - smoothstep(1.32, 1.42, p.y));
  } else if (reg > 1.5 && reg < 3.5) {
    off *= iShape.w;
  }
  return aAxis + off;
}`;

const SKIN_VARYINGS = /* glsl */ `
flat varying vec3 vTopC; flat varying vec3 vBotC; flat varying vec3 vSkinC; flat varying vec3 vShoeC; flat varying vec4 vClothP;
varying vec3 vBodyP; varying vec2 vFaceUv;`;

export function injectBodySkinning(material, uniforms, { color = true } = {}) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    let vs = shader.vertexShader.replace('#include <common>', `#include <common>\n${SKIN_PARS}\n${color ? SKIN_VARYINGS : ''}`);
    if (vs.includes('#include <beginnormal_vertex>') && color) {
      vs = vs.replace('#include <beginnormal_vertex>', `mat4 bSkin = bodySkinMat();\nvec3 objectNormal = normalize(mat3(bSkin) * normal);`)
        .replace('#include <begin_vertex>', `vec3 transformed = (bSkin * vec4(bodyShape(position), 1.0)).xyz;`);
    } else {
      vs = vs.replace('#include <begin_vertex>', `mat4 bSkin = bodySkinMat();\nvec3 transformed = (bSkin * vec4(bodyShape(position), 1.0)).xyz;`);
    }
    if (color) {
      // 部位與「沿著肢體的位置」交給片段著色器，袖口、褲管、領口才是俐落的邊界
      vs = vs.replace('#include <color_vertex>', `
vTopC = iTop; vBotC = iBottom; vSkinC = iSkin; vShoeC = iShoe; vClothP = iCloth;
vBodyP = vec3(aRegion.x, aRegion.y, position.y); vFaceUv = uv;`);
    }
    shader.vertexShader = vs;
    if (color) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${SKIN_VARYINGS}\nuniform sampler2D uFace;`)
        .replace('#include <map_fragment>', `
// 依部位決定顏色：上衣 / 褲子 / 皮膚 / 鞋；vClothP = (袖長, 褲長, 領口高, 腰線高)
float vBodyReg = floor(vBodyP.x + 0.5);
vec3 bc = vSkinC;
if (vBodyReg == 1.0) bc = vBodyP.z > vClothP.z ? vSkinC : (vBodyP.z < vClothP.w ? vBotC : vTopC);
else if (vBodyReg == 2.0) bc = vBodyP.y < vClothP.x ? vTopC : vSkinC;
else if (vBodyReg == 3.0) bc = vBodyP.y < vClothP.y ? vBotC : vSkinC;
else if (vBodyReg == 4.0) bc = vShoeC;
else if (vBodyReg == 5.0) bc *= texture2D(uFace, vFaceUv).rgb;
// 布料邊緣（袖口、褲管、領口）一點點陰影
float hem = 0.0;
if (vBodyReg == 2.0) hem = 1.0 - smoothstep(0.0, 0.025, abs(vBodyP.y - vClothP.x));
else if (vBodyReg == 3.0) hem = 1.0 - smoothstep(0.0, 0.02, abs(vBodyP.y - vClothP.y));
bc *= 1.0 - 0.18 * hem;
diffuseColor.rgb = bc;`)
        .replace('#include <roughnessmap_fragment>', `
float roughnessFactor = roughness;
if (bc == vSkinC || vBodyReg == 5.0) roughnessFactor = 0.55;
else if (vBodyReg == 4.0) roughnessFactor = 0.6;`);
    }
  };
  material.customProgramCacheKey = () => `body-skin-${color}`;
}
