import * as THREE from 'three';

// ==================================================================
// 裙子：Verlet 布料模擬
// 每條裙子是 7 圈 × 16 點的布料圓筒：腰帶那一圈釘在骨盆上，其餘質點受重力與風，
// 以結構 / 剪切 / 彎曲距離約束維持布料，並與臀部、大腿、小腿（膠囊體）及地面碰撞。
// 走路時裙襬會被腿踢動，坐下時會攤在腿上和地上，起風時會飄。
// 靜止形狀帶一點百褶起伏，模擬出來會有自然的布紋。
// ==================================================================

const NR = 7, NS = 16;
const G = -9.81;

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3();

// 點到線段最近點，把點推出膠囊體外（半徑沿線段由 r 線性變到 r2）
function pushOutCapsule(pos, i, ax, ay, az, bx, by, bz, r, r2 = r) {
  const px = pos[i], py = pos[i + 1], pz = pos[i + 2];
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  let t = len2 > 1e-8 ? ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t, cy = ay + dy * t, cz = az + dz * t;
  let ox = px - cx, oy = py - cy, oz = pz - cz;
  const d2 = ox * ox + oy * oy + oz * oz;
  r = r + (r2 - r) * t;
  if (d2 >= r * r) return;
  const d = Math.sqrt(d2);
  if (d < 1e-6) { ox = 0; oy = 0; oz = 1; } else { ox /= d; oy /= d; oz /= d; }
  pos[i] = cx + ox * r; pos[i + 1] = cy + oy * r; pos[i + 2] = cz + oz * r;
}

// 三角形上離點最近的點（Ericson, Real-Time Collision Detection 5.1.5）
const _cp = { x: 0, y: 0, z: 0 };
function closestOnTri(px, py, pz, a, b, c) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z, acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
  const apx = px - a.x, apy = py - a.y, apz = pz - a.z;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const set = (x, y, z) => { _cp.x = x; _cp.y = y; _cp.z = z; return _cp; };
  if (d1 <= 0 && d2 <= 0) return set(a.x, a.y, a.z);
  const bpx = px - b.x, bpy = py - b.y, bpz = pz - b.z;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set(b.x, b.y, b.z);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return set(a.x + abx * v, a.y + aby * v, a.z + abz * v); }
  const cpx = px - c.x, cpy = py - c.y, cpz = pz - c.z;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set(c.x, c.y, c.z);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return set(a.x + acx * w, a.y + acy * w, a.z + acz * w); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return set(b.x + (c.x - b.x) * w, b.y + (c.y - b.y) * w, b.z + (c.z - b.z) * w);
  }
  const dn = 1 / (va + vb + vc), v = vb * dn, w = vc * dn;
  return set(a.x + abx * v + acx * w, a.y + aby * v + acy * w, a.z + abz * v + acz * w);
}

// 把點推出「四邊形 (a,b,c,d) 外擴半徑 r」的外殼：兩條腿的凸包
function pushOutQuad(pos, i, a, b, c, d, r) {
  const px = pos[i], py = pos[i + 1], pz = pos[i + 2];
  let q = closestOnTri(px, py, pz, a, b, c);
  let qx = q.x, qy = q.y, qz = q.z;
  let d2 = (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
  q = closestOnTri(px, py, pz, a, c, d);
  const e2 = (px - q.x) ** 2 + (py - q.y) ** 2 + (pz - q.z) ** 2;
  if (e2 < d2) { d2 = e2; qx = q.x; qy = q.y; qz = q.z; }
  if (d2 >= r * r || d2 < 1e-12) return;
  const k = r / Math.sqrt(d2);
  pos[i] = qx + (px - qx) * k; pos[i + 1] = qy + (py - qy) * k; pos[i + 2] = qz + (pz - qz) * k;
}

export class SkirtSystem {
  constructor(terrain, wind) {
    this.terrain = terrain;
    this.wind = wind;
    this.skirts = [];
    this.mesh = null;
    this.acc = 0;
  }

  // p：人物（需要 p.pelM、p.legJ、p.s、p.shape）
  add(p, color, rng) {
    const s = p.s;
    const len = rng.range(0.42, 0.56);
    const flare = rng.range(0.04, 0.12);
    const hipW = p.shape[1];
    const local = new Float32Array(NR * NS * 3);
    for (let k = 0; k < NR; k++) {
      const t = k / (NR - 1);
      const y = 0.06 - len * t;
      // 腰圍 → 臀圍（越過臀部最寬處）→ 往下微張
      const hip = Math.min(1, t * 3.2);
      const w = (0.148 + (0.19 * hipW - 0.148) * (hip * hip * (3 - 2 * hip)) + flare * Math.max(0, t - 0.3)) * 1.0;
      const d = w * 0.74;
      for (let a = 0; a < NS; a++) {
        const th = (a / NS) * Math.PI * 2;
        const pleat = 1 + 0.06 * t * Math.sin(th * 8);
        const o = (k * NS + a) * 3;
        local[o] = Math.sin(th) * w * pleat;
        local[o + 1] = y;
        local[o + 2] = Math.cos(th) * d * pleat - 0.006;
      }
    }
    const n = NR * NS;
    const pos = new Float32Array(n * 3), prev = new Float32Array(n * 3);
    const sk = { p, local, pos, prev, cons: null, color: new THREE.Color(color), s };
    this._pin(sk, true);
    for (let i = 0; i < n; i++) {
      _v.set(local[i * 3], local[i * 3 + 1], local[i * 3 + 2]).applyMatrix4(p.pelM);
      pos[i * 3] = prev[i * 3] = _v.x; pos[i * 3 + 1] = prev[i * 3 + 1] = _v.y; pos[i * 3 + 2] = prev[i * 3 + 2] = _v.z;
    }
    // 約束：[i, j, 靜止長度, 剛度]
    const cons = [];
    const id = (k, a) => k * NS + ((a + NS) % NS);
    const dist = (i, j) => Math.hypot(pos[i * 3] - pos[j * 3], pos[i * 3 + 1] - pos[j * 3 + 1], pos[i * 3 + 2] - pos[j * 3 + 2]);
    const add = (i, j, k) => cons.push(i, j, dist(i, j), k);
    for (let k = 0; k < NR; k++) {
      for (let a = 0; a < NS; a++) {
        if (k < NR - 1) { add(id(k, a), id(k + 1, a), 1); add(id(k, a), id(k + 1, a + 1), 0.5); add(id(k, a + 1), id(k + 1, a), 0.5); }
        add(id(k, a), id(k, a + 1), 1);
        if (k < NR - 2) add(id(k, a), id(k + 2, a), 0.25);
        add(id(k, a), id(k, a + 2), 0.2);
      }
    }
    sk.cons = new Float32Array(cons);
    this.skirts.push(sk);
    return sk;
  }

  // 腰帶那一圈跟著骨盆
  _pin(sk, init = false) {
    const { local, pos, prev } = sk;
    const M = sk.p.pelM;
    for (let a = 0; a < NS; a++) {
      const o = a * 3;
      _v.set(local[o], local[o + 1], local[o + 2]).applyMatrix4(M);
      if (!init) { prev[o] = pos[o]; prev[o + 1] = pos[o + 1]; prev[o + 2] = pos[o + 2]; }
      pos[o] = _v.x; pos[o + 1] = _v.y; pos[o + 2] = _v.z;
    }
  }

  build() {
    const n = this.skirts.length * NR * NS;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(3, n * 3)), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(Math.max(3, n * 3)), 3).setUsage(THREE.DynamicDrawUsage));
    const col = new Float32Array(Math.max(3, n * 3));
    const idx = [];
    this.skirts.forEach((sk, si) => {
      const base = si * NR * NS;
      for (let i = 0; i < NR * NS; i++) {
        // 內側與裙襬略暗（布料內部的自身遮蔽）
        const k = Math.floor(i / NS);
        const f = 1 - 0.08 * (k / (NR - 1));
        col[(base + i) * 3] = sk.color.r * f; col[(base + i) * 3 + 1] = sk.color.g * f; col[(base + i) * 3 + 2] = sk.color.b * f;
      }
      for (let k = 0; k < NR - 1; k++) {
        for (let a = 0; a < NS; a++) {
          const i0 = base + k * NS + a, i1 = base + k * NS + ((a + 1) % NS);
          idx.push(i0, i0 + NS, i1, i1, i0 + NS, i1 + NS);
        }
      }
    });
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = 'skirts';
    this.mesh = mesh;
    this.sync();
    return mesh;
  }

  // cam：相機位置。只模擬 30 m 內的裙子，遠的直接以靜止形狀跟著骨盆（看不出差別，省下大部分計算）
  update(dt, cam = null) {
    if (!this.skirts.length) return;
    for (const sk of this.skirts) {
      const e = sk.p.pelM.elements;
      const near = !cam || Math.hypot(e[12] - cam.x, e[13] - cam.y, e[14] - cam.z) < 30;
      if (!near) { this.reset(sk); sk.last = null; }
      sk.active = near;
    }
    this.acc = Math.min(this.acc + dt, 0.1);
    const h = 1 / 80;
    let steps = 0;
    while (this.acc >= h && steps < 5) { this._step(h); this.acc -= h; steps++; }
    this.sync();
  }

  _step(h) {
    const T = this.terrain;
    for (const sk of this.skirts) {
      if (sk.active === false) continue;
      const { pos, prev, cons, p } = sk;
      const n = NR * NS;
      // 人被瞬間移動（群組重新安排位置）時，裙子直接重設回靜止形狀，避免纏在身上
      const e = p.pelM.elements;
      if (sk.last && Math.hypot(e[12] - sk.last[0], e[13] - sk.last[1], e[14] - sk.last[2]) > 0.4) this.reset(sk);
      sk.last = [e[12], e[13], e[14]];
      this._pin(sk);
      // 風：每條裙子在裙襬中心取樣一次
      const hc = (NR - 1) * NS * 3;
      this.wind.sample(pos[hc], pos[hc + 1], pos[hc + 2], _w);
      const damp = 0.985;
      for (let i = NS; i < n; i++) {
        const o = i * 3;
        const vx = (pos[o] - prev[o]) * damp, vy = (pos[o + 1] - prev[o + 1]) * damp, vz = (pos[o + 2] - prev[o + 2]) * damp;
        prev[o] = pos[o]; prev[o + 1] = pos[o + 1]; prev[o + 2] = pos[o + 2];
        // 空氣阻力朝向風速（相對速度）
        const kd = 1.0;
        const ax = kd * (_w.x - vx / h), ay = G + kd * (-vy / h), az = kd * (_w.z - vz / h);
        pos[o] += vx + ax * h * h; pos[o + 1] += vy + ay * h * h; pos[o + 2] += vz + az * h * h;
      }
      // 約束
      for (let it = 0; it < 4; it++) {
        for (let c = 0; c < cons.length; c += 4) {
          const i = cons[c], j = cons[c + 1], rest = cons[c + 2], k = cons[c + 3];
          const oi = i * 3, oj = j * 3;
          const dx = pos[oj] - pos[oi], dy = pos[oj + 1] - pos[oi + 1], dz = pos[oj + 2] - pos[oi + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
          // 布料：拉伸很硬、壓縮很軟（會起皺、會被風吹動，而不是一個硬殼）
          const diff = ((d - rest) / d) * (d < rest ? k * 0.15 : k);
          const wi = i < NS ? 0 : 1, wj = j < NS ? 0 : 1;
          const ws = wi + wj;
          if (ws === 0) continue;
          const fi = (diff * wi) / ws, fj = (diff * wj) / ws;
          pos[oi] += dx * fi; pos[oi + 1] += dy * fi; pos[oi + 2] += dz * fi;
          pos[oj] -= dx * fj; pos[oj + 1] -= dy * fj; pos[oj + 2] -= dz * fj;
        }
      }
      // 碰撞：臀部、大腿、小腿
      const J = p.legJ, s = p.s, limb = p.shape[3];
      _a.set(0.06, -0.035, -0.01).applyMatrix4(p.pelM);
      _b.set(-0.06, -0.035, -0.01).applyMatrix4(p.pelM);
      // 兩條腿的凸包（髖-膝-膝-髖、膝-踝-踝-膝 兩個四邊形外擴腿的半徑）：
      // 布料永遠被往身體外推，不會卡進兩腿之間、被推到錯的那一側
      const rHip = 0.105 * s * p.shape[1], rTh = 0.088 * s * limb, rSh = 0.062 * s * limb;
      for (let i = NS; i < n; i++) {
        const o = i * 3;
        pushOutCapsule(pos, o, _a.x, _a.y, _a.z, _b.x, _b.y, _b.z, rHip);
        pushOutQuad(pos, o, J[0], J[1], J[4], J[3], rTh);
        pushOutQuad(pos, o, J[1], J[2], J[5], J[4], rSh);
      }
      // 地面（含摩擦）
      for (let i = NS; i < n; i++) {
        const o = i * 3;
        const gy = T.height(pos[o], pos[o + 2]) + 0.012;
        if (pos[o + 1] < gy) {
          pos[o + 1] = gy;
          prev[o] += (pos[o] - prev[o]) * 0.6; prev[o + 2] += (pos[o + 2] - prev[o + 2]) * 0.6;
        }
      }
    }
  }

  // 瞬移（例如人物被重新放置）後把整條裙子重設回靜止形狀
  reset(sk) {
    this._pin(sk, true);
    const { local, pos, prev, p } = sk;
    for (let i = 0; i < NR * NS; i++) {
      _v.set(local[i * 3], local[i * 3 + 1], local[i * 3 + 2]).applyMatrix4(p.pelM);
      pos[i * 3] = prev[i * 3] = _v.x; pos[i * 3 + 1] = prev[i * 3 + 1] = _v.y; pos[i * 3 + 2] = prev[i * 3 + 2] = _v.z;
    }
  }

  sync() {
    if (!this.mesh) return;
    const P = this.mesh.geometry.attributes.position.array;
    let o = 0;
    for (const sk of this.skirts) { P.set(sk.pos, o); o += sk.pos.length; }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
  }
}
