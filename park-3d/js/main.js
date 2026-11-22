import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createSky, createDistantHills } from './sky.js';
import { buildWorld } from './world.js';
import { clamp, lerp } from './noise.js';

const $ = (id) => document.getElementById(id);
const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || Math.min(innerWidth, innerHeight) < 600;
const params = new URLSearchParams(location.search);
const QUALITY = params.has('q') ? parseFloat(params.get('q')) : isMobile ? 0.55 : 1;

// 照片構圖的相機
const PHOTO_VIEW = { pos: new THREE.Vector3(7, 17.5, 80), target: new THREE.Vector3(0, 9.6, -60), fov: 31 };

const status = (msg) => { const el = $('loading-msg'); if (el) el.textContent = msg; };
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function init() {
  const canvas = $('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: params.has('shot') });
  renderer.setPixelRatio(Math.min(devicePixelRatio, QUALITY < 0.8 ? 1 : 1.75));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const fogColor = new THREE.Color(0.66, 0.76, 0.86);
  scene.fog = new THREE.FogExp2(fogColor, 0.00135);
  scene.background = fogColor.clone();

  const camera = new THREE.PerspectiveCamera(PHOTO_VIEW.fov, innerWidth / innerHeight, 0.25, 7000);
  camera.position.copy(PHOTO_VIEW.pos);

  // ---- 光照：黃昏前的低角度陽光（來自右後方）----
  const sunDir = new THREE.Vector3();
  const sun = new THREE.DirectionalLight(0xffffff, 3.2);
  sun.castShadow = true;
  const smSize = QUALITY < 0.8 ? 2048 : 4096;
  sun.shadow.mapSize.set(smSize, smSize);
  sun.shadow.bias = -0.00025;
  sun.shadow.normalBias = 0.035;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 1200;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0x9cc4ff, 0x5a5a2a, 0.8);
  scene.add(hemi);

  const sky = createSky(sunDir);
  scene.add(sky.mesh);
  scene.add(createDistantHills());

  let sunElev = 17, sunAzim = 58; // 度
  function updateSun() {
    const el = THREE.MathUtils.degToRad(sunElev), az = THREE.MathUtils.degToRad(sunAzim);
    // azimuth 從 +X 往 +Z 量
    sunDir.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
    sky.uniforms.uSunDir.value.copy(sunDir);
    const warm = 1 - clamp((sunElev - 5) / 45, 0, 1);
    sun.color.setRGB(1.0, lerp(0.95, 0.78, warm), lerp(0.88, 0.55, warm));
    sun.intensity = lerp(1.8, 4.2, clamp((sunElev - 2) / 25, 0, 1));
    hemi.intensity = lerp(0.5, 0.9, clamp(sunElev / 40, 0, 1));
    hemi.color.setRGB(lerp(0.75, 0.6, warm), lerp(0.8, 0.76, warm), 1.0);
  }
  updateSun();

  status('生成地形、樹木與人群…');
  await nextFrame();
  const tBuild = performance.now();
  const world = buildWorld(scene, { quality: QUALITY });
  console.info(`world built in ${Math.round(performance.now() - tBuild)} ms`, world.stats);
  const { terrain, physics, crowd, props, veg, grass, birds } = world;

  // ---- 控制 ----
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(PHOTO_VIEW.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 2;
  controls.maxDistance = 600;
  controls.update();

  let follow = null;
  const setPhotoView = () => {
    follow = null;
    camera.position.copy(PHOTO_VIEW.pos);
    controls.target.copy(PHOTO_VIEW.target);
    camera.fov = PHOTO_VIEW.fov; camera.updateProjectionMatrix();
    controls.update();
    $('btn-follow').textContent = '跟隨一個人';
  };

  // ---- UI ----
  $('btn-photo').addEventListener('click', setPhotoView);
  $('btn-follow').addEventListener('click', () => {
    const movers = crowd.people.filter((p) => p.mode === 'move' && p.speed > 0.5 && p.y > 0);
    const pool = movers.length ? movers : crowd.people;
    follow = pool[Math.floor(Math.random() * pool.length)];
    const back = new THREE.Vector3(Math.sin(follow.heading), 0, Math.cos(follow.heading)).multiplyScalar(-6);
    controls.target.set(follow.x, follow.y + 1.1 * follow.s, follow.z);
    camera.position.set(follow.x + back.x + 2, follow.y + 2.8, follow.z + back.z);
    controls.update();
    $('btn-follow').textContent = '換一個人';
  });
  $('btn-gust').addEventListener('click', () => physics.wind.blow(1.8));
  $('btn-clear').addEventListener('click', () => {
    for (const b of [...props.balls]) if (b.userBall) props.removeBall(b);
  });
  const windInput = $('wind'), sunInput = $('sun');
  windInput.addEventListener('input', () => { physics.wind.speed = parseFloat(windInput.value); $('wind-val').textContent = `${parseFloat(windInput.value).toFixed(1)} m/s`; });
  sunInput.addEventListener('input', () => { sunElev = parseFloat(sunInput.value); $('sun-val').textContent = `${sunElev.toFixed(0)}°`; updateSun(); });
  physics.wind.speed = parseFloat(windInput.value);

  // ---- 點擊丟球 ----
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const terrainMesh = scene.getObjectByName('terrain');
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    const dt = performance.now() - downAt.t;
    downAt = null;
    if (moved > 6 || dt > 400) return;
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(terrainMesh, false)[0];
    if (!hit) return;
    const from = camera.position.clone().add(ray.ray.direction.clone().multiplyScalar(1.5));
    from.y -= 0.6;
    const ball = props.addSoccerBall(from.x, from.z);
    ball.userBall = true;
    ball.cooldown = 1.5;
    physics.throwBall(ball, from, hit.point.clone().add(new THREE.Vector3(0, 0.12, 0)));
    // 最多保留 15 顆
    const user = props.balls.filter((b) => b.userBall);
    if (user.length > 15) props.removeBall(user[0]);
    $('hint').classList.add('dim');
  });

  // ---- 視窗 ----
  function resize() {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);

  $('stat-people').textContent = world.stats.people;
  $('stat-trees').textContent = world.stats.trees;
  $('loading').classList.add('done');

  // ---- 陰影相機跟著視野 ----
  const lightSpace = new THREE.Matrix4();
  const tmp = new THREE.Vector3();
  function updateShadowFrustum() {
    const focus = controls.target;
    const dist = camera.position.distanceTo(focus);
    const half = clamp(dist * 1.35, 28, 175);
    const cam = sun.shadow.camera;
    // 以紋素對齊避免陰影閃爍
    const texel = (half * 2) / smSize;
    lightSpace.lookAt(new THREE.Vector3(), sunDir.clone().negate(), new THREE.Vector3(0, 1, 0));
    const inv = lightSpace.clone().invert();
    tmp.copy(focus).applyMatrix4(inv);
    tmp.x = Math.round(tmp.x / texel) * texel;
    tmp.y = Math.round(tmp.y / texel) * texel;
    tmp.applyMatrix4(lightSpace);
    sun.target.position.copy(tmp);
    sun.position.copy(tmp).addScaledVector(sunDir, 500);
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
    cam.updateProjectionMatrix();
    sun.target.updateMatrixWorld();
  }

  // ---- 主迴圈 ----
  const clock = new THREE.Clock();
  let t = 0, fpsAcc = 0, fpsN = 0, fpsT = 0;
  const shotMode = params.has('shot');
  physics.lookTarget.copy(camera.position);
  if (shotMode) {
    // 截圖模式：先快轉模擬幾秒
    for (let i = 0; i < 90; i++) { t += 1 / 30; physics.step(1 / 30); crowd.update(1 / 30, t, camera); }
  }
  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    t += dt;
    physics.lookTarget.copy(camera.position);
    physics.step(dt);
    crowd.update(dt, t, camera);
    props.sync();
    veg.update(t, physics.wind.mean);
    grass.update(camera, t, physics.wind.mean);
    birds.update(t, dt);
    sky.uniforms.uTime.value = t;
    sky.uniforms.uCloudShift.value.set(t * 0.004, t * 0.0015);
    if (follow) {
      const nt = tmp.set(follow.x, follow.y + 1.1 * follow.s, follow.z);
      const d = nt.clone().sub(controls.target);
      camera.position.add(d);
      controls.target.copy(nt);
    }
    controls.update();
    // 相機不鑽進地面
    const gy = terrain.height(camera.position.x, camera.position.z) + 1.2;
    if (camera.position.y < gy) camera.position.y = gy;
    sky.mesh.position.copy(camera.position);
    updateShadowFrustum();
    renderer.render(scene, camera);

    fpsAcc += dt; fpsN++; fpsT += dt;
    if (fpsT > 0.5) {
      $('stat-fps').textContent = Math.round(fpsN / fpsAcc);
      $('stat-bodies').textContent = physics.balls.length + physics.discs.length + physics.ropes.length + physics.cloths.length;
      fpsAcc = 0; fpsN = 0; fpsT = 0;
    }
    requestAnimationFrame(frame);
  }
  frame();
  window.__park = { scene, camera, controls, world, renderer, setPhotoView };
}

init().catch((err) => {
  console.error(err);
  status(`載入失敗：${err.message}`);
});
