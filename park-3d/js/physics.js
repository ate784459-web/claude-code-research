import * as THREE from 'three';
import { clamp, lerp } from './noise.js';

// ==================================================================
// 自製物理引擎：剛體球（重力、空氣阻力、馬格努斯力、地形碰撞、滾動摩擦）、
// 飛盤空氣動力學、Verlet 繩索（眼球氣球）、Verlet 布料（野餐墊）、風場。
// 固定時間步長 1/120 秒子步進。
// ==================================================================

const G = 9.81;
const RHO = 1.2; // 空氣密度
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _n = new THREE.Vector3(), _w = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class WindField {
  constructor() {
    this.dir = new THREE.Vector3(-0.82, 0, -0.57).normalize(); // 從右後方吹向左前方
    this.speed = 2.6; // m/s
    this.gust = 0;
    this.t = 0;
    this.mean = new THREE.Vector3();
  }
  update(dt) {
    this.t += dt;
    this.gust *= Math.exp(-dt * 0.45);
    const g = this.gustFactor(0, 0);
    this.mean.copy(this.dir).multiplyScalar(this.speed * g);
  }
  gustFactor(x, z) {
    const t = this.t;
    return 0.7 + 0.3 * Math.sin(t * 0.37 + x * 0.021 + z * 0.017) * Math.sin(t * 0.83 + z * 0.031) + this.gust;
  }
  sample(x, y, z, out) {
    const h = clamp(0.45 + Math.max(0, y) * 0.07, 0.45, 1.4); // 越高風越大
    return out.copy(this.dir).multiplyScalar(this.speed * this.gustFactor(x, z) * h);
  }
  blow(amount = 1.6) { this.gust = Math.min(this.gust + amount, 3); }
}

// ------------------------------------------------------------------
// 剛體球
// ------------------------------------------------------------------
export class Ball {
  constructor({ radius = 0.11, mass = 0.43, restitution = 0.72, rolling = 0.11, cd = 0.25, mesh = null, kind = 'soccer' } = {}) {
    this.radius = radius;
    this.mass = mass;
    this.restitution = restitution;
    this.rolling = rolling;
    this.cd = cd;
    this.area = Math.PI * radius * radius;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.angVel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.mesh = mesh;
    this.kind = kind;
    this.sleeping = false;
    this.sleepT = 0;
    this.onGround = false;
    this.owner = null; // 由哪個群組在玩
    this.lastTouch = 0;
    this.age = 0;
  }
  wake() { this.sleeping = false; this.sleepT = 0; }
  get speed() { return this.vel.length(); }
}

// ------------------------------------------------------------------
// 飛盤（Hummel 簡化空氣動力模型：升力 + 阻力）
// ------------------------------------------------------------------
export class Disc {
  constructor(mesh) {
    this.mesh = mesh;
    this.mass = 0.175;
    this.area = 0.057;
    this.radius = 0.135;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.spin = 0;
    this.angle = 0;
    this.held = null;
    this.onGround = false;
    this.flying = false;
    this.alpha0 = 0.12;
    this.tilt = new THREE.Vector3(0, 1, 0);
  }
}

// ------------------------------------------------------------------
// Verlet 繩索 + 掛在末端的大型充氣眼球
// ------------------------------------------------------------------
export class RopeBalloon {
  constructor(anchor, length, segments, radius, mass) {
    this.anchor = anchor.clone();
    this.n = segments + 1;
    this.seg = length / segments;
    this.radius = radius;
    this.mass = mass;
    this.p = []; this.prev = [];
    for (let i = 0; i < this.n; i++) {
      const v = anchor.clone(); v.y -= this.seg * i;
      this.p.push(v); this.prev.push(v.clone());
    }
    // 末端到氣球中心
    this.center = this.p[this.n - 1].clone(); this.center.y -= radius;
    this.centerPrev = this.center.clone();
    this.yaw = Math.random() * Math.PI * 2;
    this.yawVel = 0;
    this.quat = new THREE.Quaternion();
    this.impulse = new THREE.Vector3();
  }
}

// ------------------------------------------------------------------
// Verlet 布料（野餐墊）
// ------------------------------------------------------------------
export class Cloth {
  constructor(terrain, cx, cz, rot, w, h, nx, ny) {
    this.terrain = terrain;
    this.nx = nx; this.ny = ny;
    this.count = nx * ny;
    this.p = new Float32Array(this.count * 3);
    this.prev = new Float32Array(this.count * 3);
    this.inv = new Float32Array(this.count).fill(1);
    this.edge = new Float32Array(this.count);
    const c = Math.cos(rot), s = Math.sin(rot);
    this.cx = cx; this.cz = cz; this.rot = rot; this.w = w; this.h = h;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const lx = (i / (nx - 1) - 0.5) * w, lz = (j / (ny - 1) - 0.5) * h;
        const x = cx + lx * c - lz * s, z = cz + lx * s + lz * c;
        const k = j * nx + i;
        const y = terrain.height(x, z) + 0.02;
        this.p[k * 3] = x; this.p[k * 3 + 1] = y; this.p[k * 3 + 2] = z;
        const e = Math.min(i, nx - 1 - i, j, ny - 1 - j);
        this.edge[k] = e === 0 ? 1 : e === 1 ? 0.45 : 0.12;
      }
    }
    this.prev.set(this.p);
    // 約束：結構 + 剪切 + 彎曲
    const cons = [];
    const add = (a, b) => {
      const dx = this.p[a * 3] - this.p[b * 3], dy = this.p[a * 3 + 1] - this.p[b * 3 + 1], dz = this.p[a * 3 + 2] - this.p[b * 3 + 2];
      // 靜止長度用平面距離（布料平放時的尺寸）
      cons.push(a, b, Math.hypot(dx, dz) + Math.abs(dy) * 0.2);
    };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (i < nx - 1) add(k, k + 1);
      if (j < ny - 1) add(k, k + nx);
      if (i < nx - 1 && j < ny - 1) { add(k, k + nx + 1); add(k + 1, k + nx); }
      if (i < nx - 2) add(k, k + 2);
      if (j < ny - 2) add(k, k + 2 * nx);
    }
    this.cons = new Float32Array(cons);
    this.geometry = null;
    this.phase = Math.random() * 100;
  }
  pinNear(x, z, r) {
    for (let k = 0; k < this.count; k++) {
      if (Math.hypot(this.p[k * 3] - x, this.p[k * 3 + 2] - z) < r) this.inv[k] = 0;
    }
  }
}

// ------------------------------------------------------------------
// 物理世界
// ------------------------------------------------------------------
export class PhysicsWorld {
  constructor(terrain) {
    this.terrain = terrain;
    this.wind = new WindField();
    this.balls = [];
    this.discs = [];
    this.ropes = [];
    this.cloths = [];
    this.trunks = [];
    this.statics = []; // {type:'sphere'|'box', ...}
    this.crowd = null;
    this.fixed = 1 / 120;
    this.acc = 0;
    this.time = 0;
    this.trunkGrid = new Map();
    this.cell = 8;
    this.events = []; // 碰撞事件（給 UI / 行為使用）
    this.lookTarget = new THREE.Vector3();
    this.stats = { substeps: 0 };
  }

  setTrunks(list) {
    this.trunks = list;
    this.trunkGrid.clear();
    for (const t of list) {
      const key = this._key(t.x, t.z);
      if (!this.trunkGrid.has(key)) this.trunkGrid.set(key, []);
      this.trunkGrid.get(key).push(t);
    }
  }
  _key(x, z) { return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`; }
  forTrunksNear(x, z, cb) {
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const arr = this.trunkGrid.get(`${cx + i},${cz + j}`);
      if (arr) for (const t of arr) cb(t);
    }
  }

  addBall(ball) { this.balls.push(ball); return ball; }
  removeBall(ball) {
    const i = this.balls.indexOf(ball);
    if (i >= 0) this.balls.splice(i, 1);
  }

  // 由 from 拋向 target：解拋物線初速度（飛行時間依距離決定）
  throwBall(ball, from, target, flightTime) {
    const d = Math.hypot(target.x - from.x, target.z - from.z);
    const T = flightTime ?? clamp(d / 16, 0.7, 2.6);
    ball.pos.copy(from);
    ball.vel.set((target.x - from.x) / T, (target.y - from.y) / T + 0.5 * G * T, (target.z - from.z) / T);
    // 補償空氣阻力造成的距離損失
    ball.vel.multiplyScalar(1 + 0.012 * d * (ball.cd * ball.area / ball.mass));
    ball.angVel.set(Math.random() * 6 - 3, Math.random() * 6 - 3, Math.random() * 6 - 3);
    ball.wake();
  }

  kick(ball, dirX, dirZ, speed, loft = 0.15, spin = 0) {
    const l = Math.hypot(dirX, dirZ) || 1;
    ball.vel.set((dirX / l) * speed, speed * loft, (dirZ / l) * speed);
    ball.angVel.set(0, spin, 0);
    ball.wake();
  }

  step(dt) {
    dt = Math.min(dt, 0.05);
    this.acc += dt;
    let n = 0;
    while (this.acc >= this.fixed && n < 8) {
      this._substep(this.fixed);
      this.acc -= this.fixed;
      this.time += this.fixed;
      n++;
    }
    if (n === 8) this.acc = 0;
    this.stats.substeps = n;
    // 布料與繩索用較低頻率
    this._stepRopes(dt);
    this._stepCloths(dt);
  }

  _substep(h) {
    this.wind.update(h);
    for (const b of this.balls) this._stepBall(b, h);
    // 球與球
    const B = this.balls;
    for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) this._ballBall(B[i], B[j]);
    for (const d of this.discs) this._stepDisc(d, h);
  }

  _stepBall(b, h) {
    b.age += h;
    if (b.sleeping) return;
    const T = this.terrain;
    // ---- 力 ----
    this.wind.sample(b.pos.x, b.pos.y - T.height(b.pos.x, b.pos.z), b.pos.z, _w);
    _v.subVectors(b.vel, _w); // 相對風速
    const sp = _v.length();
    const k = (0.5 * RHO * b.cd * b.area * sp) / b.mass;
    b.vel.addScaledVector(_v, -k * h);
    // 馬格努斯力 F = S (ω × v)
    _v2.crossVectors(b.angVel, _v).multiplyScalar((0.5 * RHO * b.area * b.radius * 0.35) / b.mass * h);
    b.vel.add(_v2);
    b.vel.y -= G * h;
    b.pos.addScaledVector(b.vel, h);

    // ---- 地形碰撞 ----
    const gy = T.height(b.pos.x, b.pos.z);
    T.normal(b.pos.x, b.pos.z, _n);
    const dist = (b.pos.y - gy) * _n.y;
    b.onGround = false;
    if (dist < b.radius + 0.002) {
      b.pos.addScaledVector(_n, b.radius - dist);
      const vn = b.vel.dot(_n);
      if (vn < 0) {
        const e = vn < -1.2 ? b.restitution : 0;
        b.vel.addScaledVector(_n, -(1 + e) * vn);
        // 撞擊時切向摩擦（草地吃掉部分速度）
        if (vn < -1.2) {
          _v.copy(b.vel).addScaledVector(_n, -b.vel.dot(_n));
          b.vel.addScaledVector(_v, -0.18);
        }
        if (vn < -2.5) this.events.push({ type: 'bounce', ball: b, strength: -vn });
      }
      b.onGround = true;
      // 滾動阻力（草地）
      _v.copy(b.vel).addScaledVector(_n, -b.vel.dot(_n));
      const vt = _v.length();
      const dec = (b.rolling * G + 0.25 * vt * b.rolling) * h;
      if (vt > dec) b.vel.addScaledVector(_v, -dec / vt);
      else b.vel.sub(_v);
      // 滾動不打滑：ω = n × v / r
      _v2.crossVectors(_n, b.vel).multiplyScalar(1 / b.radius);
      b.angVel.lerp(_v2, Math.min(1, 25 * h));
      // 休眠判斷
      if (b.vel.lengthSq() < 0.0025) {
        b.sleepT += h;
        if (b.sleepT > 0.6) { b.sleeping = true; b.vel.set(0, 0, 0); b.angVel.set(0, 0, 0); }
      } else b.sleepT = 0;
    }

    // ---- 樹幹 ----
    this.forTrunksNear(b.pos.x, b.pos.z, (t) => {
      const dx = b.pos.x - t.x, dz = b.pos.z - t.z;
      const d = Math.hypot(dx, dz), m = t.r + b.radius;
      if (d < m && d > 1e-5 && b.pos.y < T.height(t.x, t.z) + t.h) {
        const nx = dx / d, nz = dz / d;
        b.pos.x = t.x + nx * m; b.pos.z = t.z + nz * m;
        const vd = b.vel.x * nx + b.vel.z * nz;
        if (vd < 0) {
          b.vel.x -= 1.55 * vd * nx; b.vel.z -= 1.55 * vd * nz;
          if (vd < -2) this.events.push({ type: 'tree', ball: b, strength: -vd });
        }
      }
    });

    // ---- 靜態物件（帳篷、長椅、冰桶…）----
    for (const s of this.statics) this._ballStatic(b, s);

    // ---- 人物（膠囊體）----
    if (this.crowd) this._ballAgents(b);

    // ---- 眼球氣球 ----
    for (const r of this.ropes) {
      _v.subVectors(b.pos, r.center);
      const d = _v.length(), m = r.radius + b.radius;
      if (d < m && d > 1e-5) {
        _v.multiplyScalar(1 / d);
        b.pos.copy(r.center).addScaledVector(_v, m);
        const vn = b.vel.dot(_v);
        if (vn < 0) {
          // 衝量分給氣球（質量比）
          const jImp = (-(1 + 0.6) * vn) / (1 / b.mass + 1 / r.mass);
          b.vel.addScaledVector(_v, jImp / b.mass);
          r.impulse.addScaledVector(_v, -jImp / r.mass);
          r.yawVel += (Math.random() - 0.5) * jImp * 0.6;
          this.events.push({ type: 'eye', ball: b, strength: -vn });
        }
      }
    }

    // ---- 世界邊界 ----
    if (b.pos.y < -50) { b.pos.set(0, 30, 0); b.vel.set(0, 0, 0); }

    // ---- 旋轉積分 ----
    const w = b.angVel.length();
    if (w > 1e-4) {
      _q.setFromAxisAngle(_v.copy(b.angVel).multiplyScalar(1 / w), w * h);
      b.quat.premultiply(_q).normalize();
    }
  }

  _ballStatic(b, s) {
    if (s.type === 'sphere') {
      _v.subVectors(b.pos, s.c);
      const d = _v.length(), m = s.r + b.radius;
      if (d < m && d > 1e-5) {
        _v.multiplyScalar(1 / d);
        b.pos.copy(s.c).addScaledVector(_v, m);
        const vn = b.vel.dot(_v);
        if (vn < 0) b.vel.addScaledVector(_v, -(1 + (s.e ?? 0.3)) * vn);
      }
    } else if (s.type === 'box') {
      // 轉到盒子的區域座標（只繞 Y 軸旋轉）
      const c = Math.cos(-s.rot), sn = Math.sin(-s.rot);
      const dx = b.pos.x - s.c.x, dy = b.pos.y - s.c.y, dz = b.pos.z - s.c.z;
      const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
      const qx = clamp(lx, -s.hx, s.hx), qy = clamp(dy, -s.hy, s.hy), qz = clamp(lz, -s.hz, s.hz);
      let ex = lx - qx, ey = dy - qy, ez = lz - qz;
      const d = Math.hypot(ex, ey, ez);
      if (d < b.radius && d > 1e-5) {
        ex /= d; ey /= d; ez /= d;
        // 轉回世界
        const c2 = Math.cos(s.rot), s2 = Math.sin(s.rot);
        _n.set(ex * c2 - ez * s2, ey, ex * s2 + ez * c2);
        b.pos.addScaledVector(_n, b.radius - d);
        const vn = b.vel.dot(_n);
        if (vn < 0) b.vel.addScaledVector(_n, -(1 + (s.e ?? 0.35)) * vn);
      }
    }
  }

  _ballAgents(b) {
    const crowd = this.crowd;
    crowd.forNear(b.pos.x, b.pos.z, 2.5, (p) => {
      for (let c = 0; c < 2; c++) {
        const A = p.capA;
        const Bp = c === 0 ? p.capB : p.capFeet;
        const R = (c === 0 ? 0.17 : 0.12) * p.s;
        // 線段上最近點
        _v.subVectors(Bp, A);
        const L2 = _v.lengthSq();
        let t = L2 > 1e-6 ? _v2.subVectors(b.pos, A).dot(_v) / L2 : 0;
        t = clamp(t, 0, 1);
        _v2.copy(A).addScaledVector(_v, t);
        _n.subVectors(b.pos, _v2);
        const d = _n.length(), m = R + b.radius;
        if (d < m && d > 1e-5) {
          _n.multiplyScalar(1 / d);
          b.pos.copy(_v2).addScaledVector(_n, m);
          // 相對速度
          const rvx = b.vel.x - p.vx, rvz = b.vel.z - p.vz;
          const vn = rvx * _n.x + b.vel.y * _n.y + rvz * _n.z;
          if (vn < 0) {
            const e = 0.45;
            const jImp = (-(1 + e) * vn) / (1 / b.mass + 1 / p.mass);
            b.vel.addScaledVector(_n, jImp / b.mass);
            // 人被推一下
            p.vx -= (_n.x * jImp) / p.mass;
            p.vz -= (_n.z * jImp) / p.mass;
            if (-vn > 1.5 && b.lastTouch < this.time - 0.3) {
              crowd.onHit(p, b, -vn, _n);
              this.events.push({ type: 'hit', ball: b, person: p, strength: -vn });
            }
            b.lastTouch = this.time;
          }
          b.wake();
        }
      }
    });
  }

  _ballBall(a, b) {
    _v.subVectors(b.pos, a.pos);
    const d = _v.length(), m = a.radius + b.radius;
    if (d >= m || d < 1e-6) return;
    _v.multiplyScalar(1 / d);
    const ia = 1 / a.mass, ib = 1 / b.mass;
    const pen = m - d;
    a.pos.addScaledVector(_v, (-pen * ia) / (ia + ib));
    b.pos.addScaledVector(_v, (pen * ib) / (ia + ib));
    const rv = _v2.subVectors(b.vel, a.vel).dot(_v);
    if (rv < 0) {
      const e = Math.min(a.restitution, b.restitution);
      const j = (-(1 + e) * rv) / (ia + ib);
      a.vel.addScaledVector(_v, -j * ia);
      b.vel.addScaledVector(_v, j * ib);
      a.wake(); b.wake();
    }
  }

  _stepDisc(d, h) {
    if (d.held) return;
    if (!d.flying && d.onGround) return;
    const T = this.terrain;
    this.wind.sample(d.pos.x, d.pos.y - T.height(d.pos.x, d.pos.z), d.pos.z, _w);
    _v.subVectors(d.vel, _w);
    const sp = _v.length();
    if (sp > 0.05) {
      const vh = Math.hypot(_v.x, _v.z);
      const alpha = d.alpha0 + Math.atan2(-_v.y, vh);
      const CL = 0.15 + 1.4 * alpha;
      const CD = 0.08 + 2.72 * (alpha + 0.04) * (alpha + 0.04);
      const q = 0.5 * RHO * d.area * sp * sp;
      // 升力方向：在垂直面上與速度垂直、朝上
      const vx = _v.x / sp, vy = _v.y / sp, vz = _v.z / sp;
      let lx = -vy * vx, ly = 1 - vy * vy, lz = -vy * vz;
      const ll = Math.hypot(lx, ly, lz) || 1;
      lx /= ll; ly /= ll; lz /= ll;
      const ax = (q * (CL * lx - CD * vx)) / d.mass;
      const ay = (q * (CL * ly - CD * vy)) / d.mass;
      const az = (q * (CL * lz - CD * vz)) / d.mass;
      d.vel.x += ax * h; d.vel.y += ay * h; d.vel.z += az * h;
      d.tilt.set(lx * 0.3, 1, lz * 0.3).normalize();
    }
    d.vel.y -= G * h;
    d.pos.addScaledVector(d.vel, h);
    d.angle += d.spin * h;
    d.spin *= 1 - 0.2 * h;
    const gy = T.height(d.pos.x, d.pos.z);
    if (d.pos.y < gy + 0.02) {
      d.pos.y = gy + 0.02;
      if (d.vel.y < 0) d.vel.y *= -0.15;
      d.vel.x *= 1 - 6 * h; d.vel.z *= 1 - 6 * h;
      d.spin *= 1 - 8 * h;
      if (Math.hypot(d.vel.x, d.vel.z) < 0.1) { d.onGround = true; d.flying = false; d.vel.set(0, 0, 0); }
      d.tilt.lerp(T.normal(d.pos.x, d.pos.z, _n), 0.2);
    }
    this.forTrunksNear(d.pos.x, d.pos.z, (t) => {
      const dx = d.pos.x - t.x, dz = d.pos.z - t.z;
      const dd = Math.hypot(dx, dz);
      if (dd < t.r + d.radius && d.pos.y < T.height(t.x, t.z) + t.h) {
        d.vel.x = (dx / dd) * 1.5; d.vel.z = (dz / dd) * 1.5; d.vel.y = 0;
      }
    });
  }

  _stepRopes(dt) {
    const h = Math.min(dt, 1 / 30);
    if (h <= 1e-5) return;
    const sub = 3;
    const hs = h / sub;
    for (const r of this.ropes) {
      for (let s = 0; s < sub; s++) {
        // 繩索質點（輕）
        for (let i = 1; i < r.n; i++) {
          const p = r.p[i], pr = r.prev[i];
          _v.subVectors(p, pr).multiplyScalar(0.985);
          pr.copy(p);
          p.add(_v);
          p.y -= G * hs * hs;
        }
        // 氣球中心（重、受風）
        this.wind.sample(r.center.x, r.center.y - 1, r.center.z, _w);
        _v.subVectors(r.center, r.centerPrev).multiplyScalar(0.992);
        const vel = _v2.copy(_v).multiplyScalar(1 / hs);
        r.centerPrev.copy(r.center);
        _w.sub(vel);
        const ws = _w.length();
        const drag = (0.5 * RHO * 0.5 * Math.PI * r.radius * r.radius * ws) / r.mass;
        _v.addScaledVector(_w, drag * hs * hs);
        // 淨重力（充氣物：自重 - 浮力）
        _v.y -= G * 0.55 * hs * hs;
        // 外部衝量（被球打中）：Δv 轉成位移
        if (s === 0) _v.addScaledVector(r.impulse, hs);
        r.center.add(_v);
        // 約束
        for (let it = 0; it < 6; it++) {
          r.p[0].copy(r.anchor);
          for (let i = 0; i < r.n - 1; i++) this._dist(r.p[i], r.p[i + 1], r.seg, i === 0 ? 0 : 1, 1);
          // 繩尾與氣球頂端：氣球遠重於繩段
          this._dist(r.p[r.n - 1], r.center, r.radius, 1, 0.04);
        }
      }
      r.impulse.set(0, 0, 0);
    }
    // 氣球互撞
    const R = this.ropes;
    for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) {
      _v.subVectors(R[j].center, R[i].center);
      const d = _v.length(), m = R[i].radius + R[j].radius;
      if (d < m && d > 1e-5) {
        _v.multiplyScalar((m - d) / d * 0.5);
        R[i].center.sub(_v); R[j].center.add(_v);
      }
    }
    // 方向：眼睛慢慢轉向觀看者（扭轉彈簧 + 阻尼）
    for (const r of this.ropes) {
      const dx = this.lookTarget.x - r.center.x, dz = this.lookTarget.z - r.center.z;
      const target = Math.atan2(dx, dz) + (r.lookAway ? Math.PI * 0.85 : 0);
      let diff = target - r.yaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      r.yawVel += (diff * 0.9 - r.yawVel * 1.1 + (Math.sin(this.time * 0.7 + r.anchor.x) * 0.15) * this.wind.gustFactor(r.center.x, r.center.z)) * h;
      r.yaw += r.yawVel * h;
      const up = _v.subVectors(r.p[r.n - 1], r.center).normalize();
      const tiltQ = _q.setFromUnitVectors(_n.set(0, 1, 0), up);
      r.quat.setFromAxisAngle(_n.set(0, 1, 0), r.yaw).premultiply(tiltQ);
    }
  }

  _dist(a, b, rest, wa, wb) {
    _v.subVectors(b, a);
    const d = _v.length();
    if (d < 1e-6) return;
    const diff = (d - rest) / d;
    const sum = wa + wb;
    if (sum === 0) return;
    a.addScaledVector(_v, (diff * wa) / sum);
    b.addScaledVector(_v, (-diff * wb) / sum);
  }

  _stepCloths(dt) {
    const h = Math.min(dt, 1 / 30);
    if (h <= 1e-5) return;
    const T = this.terrain;
    const h2 = h * h;
    const windStrength = this.wind.speed;
    for (const cl of this.cloths) {
      const P = cl.p, Pr = cl.prev, inv = cl.inv;
      cl.phase += h;
      this.wind.sample(cl.cx, 0.3, cl.cz, _w);
      const gf = this.wind.gustFactor(cl.cx, cl.cz);
      for (let k = 0; k < cl.count; k++) {
        if (inv[k] === 0) continue;
        const i3 = k * 3;
        const x = P[i3], y = P[i3 + 1], z = P[i3 + 2];
        let vx = (x - Pr[i3]) * 0.97, vy = (y - Pr[i3 + 1]) * 0.97, vz = (z - Pr[i3 + 2]) * 0.97;
        Pr[i3] = x; Pr[i3 + 1] = y; Pr[i3 + 2] = z;
        // 陣風掀起邊緣（伯努利效應的簡化）
        const flutter = Math.max(0, Math.sin(cl.phase * 3.1 + x * 1.7 + z * 1.3) * 0.6 + Math.sin(cl.phase * 1.3 + k * 0.37) * 0.4);
        const lift = cl.edge[k] * Math.max(0, gf - 0.75) * windStrength * windStrength * 0.55 * flutter;
        const ay = -G + lift;
        const ax = _w.x * cl.edge[k] * 0.35 * gf, az = _w.z * cl.edge[k] * 0.35 * gf;
        P[i3] = x + vx + ax * h2;
        P[i3 + 1] = y + vy + ay * h2;
        P[i3 + 2] = z + vz + az * h2;
      }
      // 約束
      const C = cl.cons;
      for (let it = 0; it < 4; it++) {
        for (let c = 0; c < C.length; c += 3) {
          const a = C[c], b = C[c + 1], rest = C[c + 2];
          const wa = inv[a], wb = inv[b];
          const ws = wa + wb;
          if (ws === 0) continue;
          const a3 = a * 3, b3 = b * 3;
          const dx = P[b3] - P[a3], dy = P[b3 + 1] - P[a3 + 1], dz = P[b3 + 2] - P[a3 + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < 1e-6) continue;
          const f = (d - rest) / (d * ws);
          P[a3] += dx * f * wa; P[a3 + 1] += dy * f * wa; P[a3 + 2] += dz * f * wa;
          P[b3] -= dx * f * wb; P[b3 + 1] -= dy * f * wb; P[b3 + 2] -= dz * f * wb;
        }
        // 地面碰撞 + 摩擦
        for (let k = 0; k < cl.count; k++) {
          const i3 = k * 3;
          const gy = T.height(P[i3], P[i3 + 2]) + 0.018;
          if (P[i3 + 1] < gy) {
            P[i3 + 1] = gy;
            Pr[i3] = lerp(Pr[i3], P[i3], 0.6);
            Pr[i3 + 2] = lerp(Pr[i3 + 2], P[i3 + 2], 0.6);
          }
        }
      }
      // 被球壓到
      for (const b of this.balls) {
        if (Math.abs(b.pos.x - cl.cx) > cl.w + 1 || Math.abs(b.pos.z - cl.cz) > cl.w + 1) continue;
        for (let k = 0; k < cl.count; k++) {
          const i3 = k * 3;
          const dx = P[i3] - b.pos.x, dy = P[i3 + 1] - b.pos.y, dz = P[i3 + 2] - b.pos.z;
          const d2 = dx * dx + dy * dy + dz * dz, r = b.radius + 0.03;
          if (d2 < r * r && inv[k] > 0) {
            const d = Math.sqrt(d2) || 1;
            P[i3] = b.pos.x + (dx / d) * r; P[i3 + 1] = b.pos.y + (dy / d) * r; P[i3 + 2] = b.pos.z + (dz / d) * r;
          }
        }
      }
      if (cl.geometry) {
        const pa = cl.geometry.attributes.position;
        pa.array.set(P);
        pa.needsUpdate = true;
        cl.geometry.computeVertexNormals();
        cl.geometry.computeBoundingSphere();
      }
    }
  }
}
