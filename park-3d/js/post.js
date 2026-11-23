import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';

// ==================================================================
// 場景渲染 + 環境光遮蔽（GTAO）+ 時間抗鋸齒（TAA）
// 1. 每一幀把相機投影做次像素抖動（Halton 2,3），渲染到帶深度貼圖的 HDR 目標
// 2. 用同一張深度貼圖算 GTAO（半解析度 + Poisson 去噪），不需要再畫一次場景
// 3. TAA：用深度把每個像素重投影到上一幀，取歷史顏色（Catmull-Rom 取樣），
//    再用目前畫面 3×3 鄰域的顏色分佈夾住歷史值，避免移動物體拖影
// 樹葉、草葉的鋸齒與閃爍會被多幀平均掉，AO 的雜訊也一併被平滑。
// ==================================================================

function halton(i, b) {
  let f = 1, r = 0;
  while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
  return r;
}
const JITTER = Array.from({ length: 16 }, (_, i) => [halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5]);

const TAAShader = {
  uniforms: {
    tColor: { value: null },
    tDepth: { value: null },
    tHistory: { value: null },
    tAO: { value: null },
    uInvVP: { value: new THREE.Matrix4() },
    uPrevVP: { value: new THREE.Matrix4() },
    uTexel: { value: new THREE.Vector2() },
    uBlend: { value: 1 },
    uClamp: { value: 1 },
    uAO: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tColor; uniform sampler2D tDepth; uniform sampler2D tHistory; uniform sampler2D tAO;
    uniform mat4 uInvVP; uniform mat4 uPrevVP; uniform vec2 uTexel;
    uniform float uBlend; uniform float uClamp; uniform float uAO;
    varying vec2 vUv;

    // 以最大通道做壓縮權重（Karis），讓亮點不會在平均時主導
    vec3 compress(vec3 c) { return c / (1.0 + max(max(c.r, c.g), c.b)); }
    vec3 uncompress(vec3 c) { return c / max(1e-4, 1.0 - max(max(c.r, c.g), c.b)); }
    vec3 toYCoCg(vec3 c) { return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b); }
    vec3 fromYCoCg(vec3 c) { return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }

    vec3 current(vec2 uv) {
      vec3 c = texture2D(tColor, uv).rgb;
      if (uAO > 0.0) c *= mix(1.0, texture2D(tAO, uv).r, uAO);
      return toYCoCg(compress(max(c, vec3(0.0))));
    }

    // 5 次雙線性取樣近似的 Catmull-Rom，歷史影像不會越疊越糊
    vec3 history(vec2 uv) {
      vec2 size = 1.0 / uTexel;
      vec2 p = uv * size;
      vec2 t1 = floor(p - 0.5) + 0.5;
      vec2 f = p - t1;
      vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
      vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
      vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
      vec2 w3 = f * f * (-0.5 + 0.5 * f);
      vec2 w12 = w1 + w2;
      vec2 t0 = (t1 - 1.0) * uTexel, t3 = (t1 + 2.0) * uTexel, t12 = (t1 + w2 / w12) * uTexel;
      vec3 r = texture2D(tHistory, vec2(t12.x, t0.y)).rgb * (w12.x * w0.y)
             + texture2D(tHistory, vec2(t0.x, t12.y)).rgb * (w0.x * w12.y)
             + texture2D(tHistory, t12).rgb * (w12.x * w12.y)
             + texture2D(tHistory, vec2(t3.x, t12.y)).rgb * (w3.x * w12.y)
             + texture2D(tHistory, vec2(t12.x, t3.y)).rgb * (w12.x * w3.y);
      float ws = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
      return max(r / ws, vec3(0.0));
    }

    void main() {
      vec3 m1 = vec3(0.0), m2 = vec3(0.0), cur = vec3(0.0);
      float dMin = 1.0;
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec2 o = vec2(float(x), float(y)) * uTexel;
          vec3 c = current(vUv + o);
          if (x == 0 && y == 0) cur = c;
          m1 += c; m2 += c * c;
          dMin = min(dMin, texture2D(tDepth, vUv + o).x);
        }
      }
      // 用鄰域中最近的深度做重投影，物體邊緣才不會拖影
      float d = min(dMin, 0.99995);
      vec4 wp = uInvVP * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
      wp /= wp.w;
      vec4 pc = uPrevVP * wp;
      vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
      bool inside = pc.w > 0.0 && all(greaterThanEqual(puv, vec2(0.0))) && all(lessThanEqual(puv, vec2(1.0)));

      vec3 res = cur;
      if (inside && uBlend < 1.0) {
        vec3 h = toYCoCg(compress(history(puv)));
        if (uClamp > 0.5) {
          vec3 mu = m1 / 9.0;
          vec3 sd = sqrt(abs(m2 / 9.0 - mu * mu));
          h = clamp(h, mu - 1.25 * sd, mu + 1.25 * sd);
        }
        // 移動得越快，越相信目前這一幀
        float vel = length((puv - vUv) / uTexel);
        float a = mix(uBlend, max(uBlend, 0.3), clamp(vel / 24.0, 0.0, 1.0));
        res = mix(h, cur, a);
      }
      gl_FragColor = vec4(uncompress(fromYCoCg(res)), 1.0);
    }`,
};

const CopyShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: TAAShader.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; varying vec2 vUv;
    void main() { gl_FragColor = texture2D(tDiffuse, vUv); }`,
};

export class TemporalScenePass extends Pass {
  constructor(scene, camera, { ao = true, aoScale = 0.5, aoAmount = 0.8 } = {}) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = true;
    this.useAO = ao;
    this.aoScale = aoScale;
    this.aoAmount = aoAmount;
    this.minBlend = 0.1;
    this.frame = 0;
    this.sinceReset = 0;
    this.static = false; // true：場景靜止時做完整的超取樣平均（截圖用）

    const rtOpts = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.sceneRT.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
    this.history = [new THREE.WebGLRenderTarget(1, 1, rtOpts), new THREE.WebGLRenderTarget(1, 1, rtOpts)];
    this.cur = 0;

    this.taa = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(TAAShader.uniforms),
      vertexShader: TAAShader.vertexShader,
      fragmentShader: TAAShader.fragmentShader,
      depthTest: false, depthWrite: false,
    });
    this.copy = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(null);

    if (ao) {
      // 先讓 GTAOPass 建好自己的 G-buffer，再換成場景渲染的深度貼圖（法線由深度重建）
      this.gtao = new GTAOPass(scene, camera, 2, 2);
      this.gtao.setGBuffer(this.sceneRT.depthTexture);
      this.gtao.updateGtaoMaterial({ radius: 1.1, distanceExponent: 1.6, thickness: 2.0, distanceFallOff: 1.0, scale: 1.0, samples: 12 });
      this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, radiusExponent: 1.5, rings: 2, samples: 12 });
    }

    this.vp = new THREE.Matrix4();
    this.prevVP = new THREE.Matrix4();
    this.invVP = new THREE.Matrix4();
    this.savedProj = new THREE.Matrix4();
  }

  reset() { this.sinceReset = 0; }

  setSize(w, h) {
    this.sceneRT.setSize(w, h);
    for (const rt of this.history) rt.setSize(w, h);
    if (this.gtao) {
      const aw = Math.max(1, Math.round(w * this.aoScale)), ah = Math.max(1, Math.round(h * this.aoScale));
      this.gtao.setSize(aw, ah);
    }
    this.taa.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.reset();
  }

  render(renderer, writeBuffer) {
    const cam = this.camera;
    cam.updateMatrixWorld();
    this.vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const W = this.sceneRT.width, H = this.sceneRT.height;

    // ---- 次像素抖動後渲染場景 ----
    const j = JITTER[this.frame % JITTER.length];
    this.savedProj.copy(cam.projectionMatrix);
    cam.projectionMatrix.elements[8] += (j[0] * 2) / W;
    cam.projectionMatrix.elements[9] += (j[1] * 2) / H;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    renderer.setRenderTarget(this.sceneRT);
    renderer.clear();
    renderer.render(this.scene, cam);

    // ---- GTAO（用剛剛的深度）----
    const aoOn = this.gtao && this.aoAmount > 0;
    if (aoOn) {
      const g = this.gtao, u = g.gtaoMaterial.uniforms;
      u.cameraNear.value = cam.near; u.cameraFar.value = cam.far;
      u.cameraProjectionMatrix.value.copy(cam.projectionMatrix);
      u.cameraProjectionMatrixInverse.value.copy(cam.projectionMatrixInverse);
      u.cameraWorldMatrix.value.copy(cam.matrixWorld);
      g.renderPass(renderer, g.gtaoMaterial, g.gtaoRenderTarget, 0xffffff, 1.0);
      g.pdMaterial.uniforms.cameraProjectionMatrixInverse.value.copy(cam.projectionMatrixInverse);
      g.renderPass(renderer, g.pdMaterial, g.pdRenderTarget, 0xffffff, 1.0);
    }
    cam.projectionMatrix.copy(this.savedProj);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();

    // ---- TAA ----
    const prev = this.history[this.cur], next = this.history[1 - this.cur];
    const U = this.taa.uniforms;
    U.tColor.value = this.sceneRT.texture;
    U.tDepth.value = this.sceneRT.depthTexture;
    U.tHistory.value = prev.texture;
    U.tAO.value = aoOn ? this.gtao.pdRenderTarget.texture : null;
    U.uAO.value = aoOn ? this.aoAmount : 0;
    U.uInvVP.value.copy(this.vp).invert();
    U.uPrevVP.value.copy(this.sinceReset === 0 ? this.vp : this.prevVP);
    // 剛重設時用累積平均（1/n）快速收斂，之後維持固定權重
    const n = this.sinceReset + 1;
    U.uBlend.value = this.static ? 1 / n : Math.max(1 / n, this.minBlend);
    U.uClamp.value = this.static ? 0 : 1;
    this.quad.material = this.taa;
    renderer.setRenderTarget(next);
    this.quad.render(renderer);

    this.copy.uniforms.tDiffuse.value = next.texture;
    this.quad.material = this.copy;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);

    this.prevVP.copy(this.vp);
    this.cur = 1 - this.cur;
    this.frame++;
    this.sinceReset++;
  }

  dispose() {
    this.sceneRT.dispose();
    for (const rt of this.history) rt.dispose();
    this.taa.dispose(); this.copy.dispose(); this.quad.dispose();
    if (this.gtao) this.gtao.dispose();
  }
}
