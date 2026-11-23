import * as THREE from 'three';
import { setAtmosphere } from './atmosphere.js'; // 必須最先載入：替換霧的 shader chunk
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { LOOK, GradeShader, applyLook } from './look.js';
import { createSky, createDistantHills } from './sky.js';
import { buildWorld } from './world.js';
import { clamp, lerp } from './noise.js';
import { TemporalScenePass } from './post.js';
import { SkyEnvironment } from './lighting.js';

const $ = (id) => document.getElementById(id);
const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || Math.min(innerWidth, innerHeight) < 600;
const params = new URLSearchParams(location.search);
const QUALITY = params.has('q') ? parseFloat(params.get('q')) : isMobile ? 0.55 : 1;
// 高畫質：環境光遮蔽與光暈（手機版關閉，時間抗鋸齒則一律開啟）
const HIGH = QUALITY >= 0.8 && !params.has('lite');

// 照片構圖的相機
const PHOTO_VIEW = { pos: new THREE.Vector3(7, 17.5, 80), target: new THREE.Vector3(4.9, 7.5, -60), fov: 31 };

const status = (msg) => { const el = $('loading-msg'); if (el) el.textContent = msg; };
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function init() {
  const canvas = $('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: params.has('shot') });
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
  const look = LOOK;
  scene.add(hemi);

  const sky = createSky(sunDir);
  scene.add(sky.mesh);
  scene.add(createDistantHills());

  let sunElev = look.sunElev; // 度（方位角由 look.sunAzim 決定）
  function updateSun() {
    const el = THREE.MathUtils.degToRad(sunElev), az = THREE.MathUtils.degToRad(look.sunAzim);
    // azimuth 從 +X 往 +Z 量
    sunDir.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
    sky.uniforms.uSunDir.value.copy(sunDir);
    // 仰角越低越暖、越暗；以 17° 時的照片色調為基準
    const warm = 1 - clamp((sunElev - 5) / 45, 0, 1);
    const w0 = 1 - clamp((look.sunElev - 5) / 45, 0, 1);
    const k = clamp(warm / w0, 0, 1.4);
    const sw = look.sunWarm;
    sun.color.setRGB(lerp(1.0, sw[0], k), lerp(0.97, sw[1], k), lerp(0.93, sw[2], k));
    sun.intensity = lerp(1.9, 3.3, clamp((sunElev - 2) / 15, 0, 1)) * look.sunPower;
    hemi.intensity = lerp(0.5, 0.9, clamp(sunElev / 40, 0, 1)) * look.hemiPower;
    hemi.color.setRGB(...look.hemiSky);
    hemi.groundColor.setRGB(...look.hemiGround);
    // 自動曝光：像相機一樣，太陽升高時收一點曝光，維持照片的明暗
    const ref = Math.sin(THREE.MathUtils.degToRad(look.sunElev));
    renderer.toneMappingExposure = look.exposure * clamp(Math.pow(ref / Math.max(0.05, Math.sin(el)), 0.6), 0.55, 1.3);
    // 大氣：朝太陽的前向散射用和天空光暈相同的顏色
    const g = look.atmGlow;
    setAtmosphere(sunDir, [1.0 * g, 0.75 * g, 0.45 * g], look.atm);
    envDirty = true;
  }
  let envDirty = true;

  status('生成地形、樹木與人群…');
  await nextFrame();
  const tBuild = performance.now();
  const world = buildWorld(scene, { quality: QUALITY });
  console.info(`world built in ${Math.round(performance.now() - tBuild)} ms`, world.stats);
  const { terrain, physics, crowd, props, veg, grass, birds } = world;

  // ---- 後製：場景 + AO + TAA（HDR）→ 光暈 → 色調映射 → 調色 ----
  const pr = renderer.getPixelRatio();
  const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, depthBuffer: false });
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(pr);
  const scenePass = new TemporalScenePass(scene, camera, { ao: HIGH, aoScale: 0.5, aoAmount: look.ao });
  composer.addPass(scenePass);
  let bloom = null;
  if (HIGH) {
    bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth * pr, innerHeight * pr), look.bloom[0], look.bloom[1], look.bloom[2]);
    composer.addPass(bloom);
  }
  composer.addPass(new OutputPass());
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  grade.uniforms.uAspect.value = innerWidth / innerHeight;
  // 照片視角的投影矩陣（16:9）交給天空著色器，用來放置照片中的雲
  {
    const pc = new THREE.PerspectiveCamera(PHOTO_VIEW.fov, 16 / 9, 1, 10);
    pc.position.copy(PHOTO_VIEW.pos); pc.lookAt(PHOTO_VIEW.target); pc.updateMatrixWorld();
    sky.uniforms.uPhotoVP.value.multiplyMatrices(pc.projectionMatrix, pc.matrixWorldInverse);
  }
  // ---- 天空環境光（IBL）：天空 + 被照亮的草地 → 預先濾波的環境貼圖 ----
  const skyEnv = new SkyEnvironment(renderer, sky.mesh.material);
  let envAt = -1e9;
  function refreshEnv() {
    const la = look.lawnA, lb = look.lawnB;
    const sunE = sun.intensity * Math.max(0, sunDir.y) * 0.7; // 約七成草地照得到太陽
    const sc = [sun.color.r, sun.color.g, sun.color.b];
    const skyE = [0.35, 0.55, 0.8].map((v) => v * Math.PI * look.envPower);
    const ground = [0, 1, 2].map((i) => (0.5 * (la[i] + lb[i]) * (sc[i] * sunE + skyE[i])) / Math.PI);
    scene.environment = skyEnv.update(ground);
    envDirty = false;
    envAt = performance.now();
  }
  function applyExtras(lk) {
    scene.traverse((o) => {
      const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of ms) if (m.isMeshStandardMaterial) m.envMapIntensity = lk.envPower;
    });
    scenePass.aoAmount = lk.ao;
    if (bloom) { bloom.strength = lk.bloom[0]; bloom.radius = lk.bloom[1]; bloom.threshold = lk.bloom[2]; }
    veg.uniforms.uTransl.value.set(...lk.leafTransl, 1);
    grass.uniforms.uTransl.value.set(...lk.grassTransl, 1);
  }
  const lookCtx = { renderer, scene, sky, terrainU: terrain.uniforms, veg, grade, updateSun, onApply: applyExtras };
  applyLook(look, lookCtx);

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
    composer.setSize(innerWidth, innerHeight);
    grade.uniforms.uAspect.value = innerWidth / innerHeight;
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

  // 相機不鑽進地面；天空穹頂與陰影範圍跟著視野
  function updateView() {
    controls.update();
    const gy = terrain.height(camera.position.x, camera.position.z) + 1.2;
    if (camera.position.y < gy) camera.position.y = gy;
    sky.mesh.position.copy(camera.position);
    updateShadowFrustum();
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
  const lastCam = camera.position.clone();
  let lastFov = camera.fov, paused = false;
  function frame() {
    if (paused) { requestAnimationFrame(frame); return; }
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
    updateView();
    if (envDirty && performance.now() - envAt > 120) refreshEnv();
    // 相機瞬間移動（回到照片視角、跟隨）時重設 TAA 歷史
    if (camera.position.distanceToSquared(lastCam) > 16 || camera.fov !== lastFov) scenePass.reset();
    lastCam.copy(camera.position); lastFov = camera.fov;
    composer.render();

    fpsAcc += dt; fpsN++; fpsT += dt;
    if (fpsT > 0.5) {
      $('stat-fps').textContent = Math.round(fpsN / fpsAcc);
      $('stat-bodies').textContent = physics.balls.length + physics.discs.length + physics.ropes.length + physics.cloths.length;
      fpsAcc = 0; fpsN = 0; fpsT = 0;
    }
    requestAnimationFrame(frame);
  }
  frame();
  // 截圖用：凍結模擬，對靜止畫面做 n 幀完整的超取樣平均
  const settle = (n = 16) => {
    paused = true;
    updateView();
    if (envDirty) refreshEnv();
    scenePass.static = true; scenePass.reset();
    for (let i = 0; i < n; i++) composer.render();
    scenePass.static = false;
  };
  window.__park = { scene, camera, controls, world, renderer, setPhotoView, look, scenePass, settle, renderOnce: () => composer.render(), resume: () => { paused = false; clock.getDelta(); }, tune: (patch) => applyLook(look, lookCtx, patch) };
}

init().catch((err) => {
  console.error(err);
  status(`載入失敗：${err.message}`);
});
