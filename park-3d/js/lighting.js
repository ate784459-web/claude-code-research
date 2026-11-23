import * as THREE from 'three';

// ==================================================================
// 葉片與草葉的透光
// 薄的葉子在陽光從背面照過來時會透出黃綠色的光：
// - 背面穿透：直射光落在葉片背面（法線背向太陽）時，部分光穿過葉肉
// - 前向散射：視線朝向太陽、隔著葉子看時最亮
// 直射光已經乘過陰影，所以被樹冠擋住的葉子不會發亮。
// uniform（vec4）：x 背面穿透、y 前向散射、z 前向散射的集中程度、w 開關
// ==================================================================
export function translucentLightsChunk(uniformName, tint = [1, 1, 1], scaleExpr = '1.0') {
  const src = THREE.ShaderChunk.lights_fragment_begin;
  const dirBlock = src.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
  const call = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
  const at = dirBlock < 0 ? -1 : src.indexOf(call, dirBlock);
  if (at < 0) {
    console.warn('translucency: lights_fragment_begin layout changed, skipped');
    return src;
  }
  const t = tint.map((v) => Number(v).toFixed(3)).join(', ');
  const add = /* glsl */ `
		{
			float trBack = saturate( - dot( geometryNormal, directLight.direction ) );
			float trFwd = pow( saturate( dot( - geometryViewDir, directLight.direction ) ), ${uniformName}.z );
			reflectedLight.directDiffuse += directLight.color * BRDF_Lambert( material.diffuseColor ) * vec3( ${t} )
				* ( ${uniformName}.x * trBack + ${uniformName}.y * trFwd ) * ( ${scaleExpr} ) * ${uniformName}.w;
		}`;
  return src.slice(0, at + call.length) + add + src.slice(at + call.length);
}

// ==================================================================
// 天空環境光（IBL）
// 把程式生成的天空（含雲與太陽光暈）和被陽光照亮的草地，渲染成預先濾波的環境貼圖。
// 所有 MeshStandardMaterial 都會從它得到：
// - 方向性的環境光：朝太陽那側的天空較亮較暖，背光側較藍
// - 地面反射的綠色反光（樹冠底部、人的下巴）
// - 光滑表面（眼球氣球、足球）上的天空倒影
// ==================================================================
export class SkyEnvironment {
  constructor(renderer, skyMaterial) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.scene = new THREE.Scene();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), skyMaterial);
    dome.renderOrder = -10;
    this.groundMat = new THREE.MeshBasicMaterial({ color: 0x404020, fog: false, toneMapped: false, side: THREE.DoubleSide });
    const ground = new THREE.Mesh(new THREE.CircleGeometry(880, 64), this.groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -4;
    this.scene.add(dome, ground);
    this.target = null;
  }

  // groundRadiance：被照亮的草地平均輻射亮度（線性 RGB）
  update(groundRadiance) {
    this.groundMat.color.setRGB(groundRadiance[0], groundRadiance[1], groundRadiance[2]);
    const rt = this.pmrem.fromScene(this.scene, 0, 0.5, 2000);
    if (this.target) this.target.dispose();
    this.target = rt;
    return rt.texture;
  }
}
