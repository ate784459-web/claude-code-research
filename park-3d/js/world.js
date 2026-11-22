import * as THREE from 'three';
import { RNG, clamp } from './noise.js';
import { Terrain } from './terrain.js';
import { Vegetation } from './vegetation.js';
import { createGrass } from './grass.js';
import { PhysicsWorld } from './physics.js';
import { Props } from './props.js';
import {
  Crowd, PicnicGroup, WalkGroup, PathGroup, SoccerGroup, GiantBallGroup, ChatGroup, BenchGroup, FrisbeeGroup, TagGroup,
} from './people.js';

// ==================================================================
// 依照片佈置整個公園：地形 → 樹木 → 道具 → 人群 → 物理
// ==================================================================
export function buildWorld(scene, opts = {}) {
  const Q = opts.quality ?? 1;
  const terrain = new Terrain(7);
  scene.add(terrain.createMesh());
  scene.add(terrain.createPathMesh());

  const veg = new Vegetation(terrain, { quality: Q });
  veg.plan();
  scene.add(veg.build());

  const grass = createGrass(terrain.uniforms, Math.round(170000 * Q), 70);
  if (Q > 0.4) scene.add(grass.mesh);

  const physics = new PhysicsWorld(terrain);
  physics.setTrunks(veg.colliders);

  const crowd = new Crowd(terrain, physics, { seed: 31 });
  const props = new Props(terrain, physics, crowd);
  const rng = new RNG(1234);

  // ---------------- 野餐區（左側斜坡，步道與草坪中央之間）----------------
  // 照片左下：沿步道右側密集的野餐人群（位置由照片配準）
  const picnicZones = [
    { z0: 20, z1: 45, n: 22, x0: 0.2, x1: 12, gap: 2.7 },
    { z0: 0, z1: 20, n: 14, x0: 0.2, x1: 10, gap: 2.9 },
    { z0: -24, z1: 0, n: 7, x0: 0.5, x1: 12, gap: 4.2 },
    { z0: -48, z1: -24, n: 4, x0: 1, x1: 12, gap: 4.6 },
    { z0: -95, z1: -55, n: 7, x0: 0.5, x1: 14, gap: 4.6 },
    { z0: -150, z1: -100, n: 2, x0: 1, x1: 10, gap: 5 },
  ];
  const blanketSpots = [];
  for (const zn of picnicZones) {
    let made = 0, tries = 0;
    while (made < zn.n && tries < 400) {
      tries++;
      const z = rng.range(zn.z0, zn.z1);
      const x = terrain.lawnLeft(z) + rng.range(zn.x0, zn.x1);
      if (terrain.bunkerWeight(x, z) > 0 || terrain.distToPath(x, z) < 3) continue;
      if (blanketSpots.some((b) => Math.hypot(b.x - x, b.z - z) < zn.gap)) continue;
      blanketSpots.push({ x, z });
      made++;
    }
  }
  // 草坪右側也有少數幾組
  for (const [x, z] of [[22, -36], [19, -10], [21, -90], [12, -128]]) blanketSpots.push({ x, z });

  // 帳篷（依照片：前景棕色圓頂、左側遠處白色與藍色帳篷、白色遮陽棚）
  const tents = [
    { x: -6.8, z: 30.4, ry: 0.4, color: '#6e4b3a', size: 1.0 },
    { x: -14, z: -66, ry: -0.3, color: '#f2f2ee', size: 0.9 },
    { x: -20.5, z: -61, ry: 0.2, color: '#2f86c9', size: 0.8 },
    { x: -12, z: -88, ry: 0.1, color: '#e9e9e4', size: 0.9 },
  ];
  for (const t of tents) {
    props.addDomeTent(t.x, t.z, t.ry, t.color, t.size);
    for (let i = blanketSpots.length - 1; i >= 0; i--) if (Math.hypot(blanketSpots[i].x - t.x, blanketSpots[i].z - t.z) < 3.4) blanketSpots.splice(i, 1);
  }
  props.addCanopy(-17, -76, 0.2);
  crowd.obstacles.push({ x: -17, z: -76, r: 2.2 });

  let picnicPeople = 0;
  blanketSpots.forEach((spot, i) => {
    const w = rng.range(1.6, 2.3), h = rng.range(1.5, 2.1);
    const rot = rng.range(-0.6, 0.6);
    const b = props.addBlanket(spot.x, spot.z, rot, w, h, i);
    const n = spot.z > 0 ? rng.int(3, 7) : rng.int(2, 6);
    const members = [];
    const kids = rng.chance(0.55) ? rng.int(1, 2) : 0;
    for (let k = 0; k < n; k++) members.push(crowd.createPerson({ child: k >= n - kids && n > 2 }));
    const g = crowd.addGroup(new PicnicGroup(crowd, b, members, rng));
    picnicPeople += n;
    // 坐的位置壓住布料
    g.slots.forEach((s) => b.cloth.pinNear(s.x, s.z, 0.45));
    props.addPicnicItems(b, rng);
    b.cloth.pinNear(spot.x, spot.z, 0.35);
    crowd.obstacles.push({ x: spot.x, z: spot.z, r: Math.max(w, h) * 0.55, owner: g });
    // 部分家庭有推車 / 嬰兒車 / 椅子
    const c = Math.cos(rot), s = Math.sin(rot);
    if (rng.chance(0.3)) props.addWagon(spot.x + (w / 2 + 0.6) * c, spot.z + (w / 2 + 0.6) * s, rot + rng.range(-0.5, 0.5), rng);
    else if (rng.chance(0.2)) props.addStroller(spot.x - (w / 2 + 0.5) * c, spot.z - (w / 2 + 0.5) * s, rot + 1.2);
    if (rng.chance(0.18)) props.addChair(spot.x + (h / 2 + 0.5) * -s, spot.z + (h / 2 + 0.5) * c, rot + Math.PI);
  });

  // ---------------- 大顆充氣足球（照片前景）----------------
  const giant = props.addSoccerBall(0.6, 28.8, { radius: 0.62, mass: 1.1, restitution: 0.55, rolling: 0.06, cd: 0.47, kind: 'giant' });
  {
    const kids = [crowd.createPerson({ child: true, height: 1.0 }), crowd.createPerson({ child: true, height: 1.1 }), crowd.createPerson({ child: true, height: 1.25 })];
    const adults = [crowd.createPerson({ female: true }), crowd.createPerson({ female: false })];
    crowd.addGroup(new GiantBallGroup(crowd, kids, adults, giant, { x: 0.6, z: 28.8 }, rng));
  }
  {
    const giant2 = props.addSoccerBall(9, -40, { radius: 0.62, mass: 1.1, restitution: 0.55, rolling: 0.06, cd: 0.47, kind: 'giant' });
    const kids = [crowd.createPerson({ child: true }), crowd.createPerson({ child: true })];
    const adults = [crowd.createPerson({})];
    crowd.addGroup(new GiantBallGroup(crowd, kids, adults, giant2, { x: 9, z: -40 }, rng));
  }

  // ---------------- 踢足球 ----------------
  const soccerSpots = [
    { x: 10, z: 8, n: 3, r: 6 }, { x: 14, z: -48, n: 4, r: 8 }, { x: 2, z: -112, n: 3, r: 7 },
    { x: 8, z: -165, n: 4, r: 8 }, { x: -2, z: -205, n: 2, r: 6 },
  ];
  for (const sp of soccerSpots) {
    const ball = props.addSoccerBall(sp.x, sp.z);
    const members = [];
    for (let i = 0; i < sp.n; i++) members.push(crowd.createPerson({ child: rng.chance(0.35) }));
    crowd.addGroup(new SoccerGroup(crowd, members, ball, sp, rng, { radius: sp.r }));
  }

  // ---------------- 飛盤 ----------------
  for (const [a, b] of [[{ x: 3, z: 18 }, { x: 17, z: 12 }], [{ x: -2, z: -62 }, { x: 12, z: -72 }], [{ x: 0, z: -140 }, { x: 10, z: -152 }]]) {
    const disc = props.addDisc(a.x, a.z);
    const members = [crowd.createPerson({}), crowd.createPerson({})];
    crowd.addGroup(new FrisbeeGroup(crowd, members, disc, a, b, rng));
  }

  // ---------------- 鬼抓人 ----------------
  for (const c of [{ x: 4, z: -22 }, { x: -6, z: -128 }]) {
    const kids = [];
    for (let i = 0; i < rng.int(3, 5); i++) kids.push(crowd.createPerson({ child: true }));
    crowd.addGroup(new TagGroup(crowd, kids, c, rng));
  }

  // ---------------- 站著聊天 ----------------
  for (let i = 0; i < 7; i++) {
    const p = crowd.randomLawnPoint(rng, -190, 40, 4);
    const n = rng.int(2, 4);
    const members = [];
    for (let k = 0; k < n; k++) members.push(crowd.createPerson({ allowSkirt: true }));
    crowd.addGroup(new ChatGroup(crowd, members, p, rng));
  }

  // ---------------- 草坪上散步 ----------------
  const walkRegions = [
    { z0: -40, z1: 45, n: 13 }, { z0: -120, z1: -30, n: 12 }, { z0: -240, z1: -110, n: 10 },
  ];
  for (const r of walkRegions) {
    for (let i = 0; i < Math.round(r.n * Math.max(0.6, Q)); i++) {
      const roll = rng.next();
      const members = [];
      if (roll < 0.35) members.push(crowd.createPerson({ allowSkirt: true }));
      else if (roll < 0.7) { members.push(crowd.createPerson({ allowSkirt: true, female: true }), crowd.createPerson({ allowSkirt: true, female: false })); }
      else {
        members.push(crowd.createPerson({ allowSkirt: true }), crowd.createPerson({ allowSkirt: true }));
        for (let k = 0; k < rng.int(1, 2); k++) members.push(crowd.createPerson({ child: true }));
      }
      crowd.addGroup(new WalkGroup(crowd, members, rng, r));
    }
  }

  // ---------------- 步道上的行人 ----------------
  for (let i = 0; i < Math.round(16 * Math.max(0.6, Q)); i++) {
    const members = [];
    const n = rng.chance(0.45) ? 2 : rng.chance(0.2) ? 3 : 1;
    for (let k = 0; k < n; k++) members.push(crowd.createPerson({ allowSkirt: true, child: k === 2 }));
    crowd.addGroup(new PathGroup(crowd, members, rng, rng.range(0.05, 0.7), rng.chance(0.5) ? 1 : -1));
  }

  // ---------------- 右側紅土區：長椅、白色樁 ----------------
  const benches = [
    props.addBench(45.1, -4.4, -Math.PI / 2 - 0.3),
    props.addBench(41.5, -12, -Math.PI / 2 + 0.1),
    props.addBench(39, -46, -Math.PI / 2),
  ];
  benches.forEach((b, i) => {
    const members = [];
    for (let k = 0; k < (i === 1 ? 1 : 2); k++) members.push(crowd.createPerson({}));
    crowd.addGroup(new BenchGroup(crowd, members, b, rng));
  });
  props.addPost(33, -5.1);
  props.addPost(terrain.lawnRight(-120) + 1.5, -120);

  // 綠色角錐（照片中散落在草坪上）
  for (const [x, z] of [[14.8, -7.9], [-8, -40], [16, -66], [2, -96]]) props.addCone(x, z);

  // ---------------- 樹上的巨大眼球 ----------------
  for (const a of veg.eyeAnchors) {
    const anchor = new THREE.Vector3(a.x, a.y, a.z);
    if (a.pair) { props.addEyeBalloon(anchor, -a.pair, a.look); props.addEyeBalloon(anchor, a.pair, a.look); }
    else props.addEyeBalloon(anchor, 0, a.look);
  }

  props.finalize();
  scene.add(props.group);
  scene.add(crowd.build());

  // ---------------- 鳥 ----------------
  const birds = createBirds(scene, 7);

  return {
    terrain, veg, grass, physics, crowd, props, birds,
    stats: { people: crowd.people.length, picnicPeople, trees: veg.stats.trees, blankets: props.blankets.length },
  };
}

// 遠處飛翔的鳥（簡單翅膀拍動 + 盤旋）
function createBirds(scene, n) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0.25, -0.9, 0, -0.1, 0, 0, -0.2,
    0, 0, 0.25, 0, 0, -0.2, 0.9, 0, -0.1,
  ], 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({ color: 0x2a2a2a, side: THREE.DoubleSide, fog: true });
  const birds = [];
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(geo.clone(), mat);
    m.scale.setScalar(0.7 + Math.random() * 0.4);
    scene.add(m);
    birds.push({
      mesh: m, cx: -10 + Math.random() * 60, cz: -150 - Math.random() * 120, cy: 45 + Math.random() * 35,
      r: 20 + Math.random() * 40, w: (0.08 + Math.random() * 0.08) * (Math.random() < 0.5 ? -1 : 1), a: Math.random() * 6.28, f: 6 + Math.random() * 4,
    });
  }
  return {
    update(t, dt) {
      for (const b of birds) {
        b.a += b.w * dt;
        const x = b.cx + Math.cos(b.a) * b.r, z = b.cz + Math.sin(b.a) * b.r;
        const y = b.cy + Math.sin(t * 0.3 + b.r) * 3;
        b.mesh.position.set(x, y, z);
        b.mesh.rotation.set(0, -b.a + (b.w > 0 ? 0 : Math.PI), Math.sin(b.a * 3) * 0.2);
        const flap = Math.sin(t * b.f + b.r) * 0.6;
        const pos = b.mesh.geometry.attributes.position;
        pos.setY(1, flap); pos.setY(5, flap);
        pos.needsUpdate = true;
      }
    },
  };
}
