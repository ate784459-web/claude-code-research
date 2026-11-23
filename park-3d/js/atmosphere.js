import * as THREE from 'three';

// ==================================================================
// 大氣透視：取代 three.js 內建的指數平方霧（全域替換 fog 的 shader chunk）
// - 依波長散射：藍光散射得多，遠景偏藍，紅光衰減較少
// - 朝太陽方向的前向散射：逆光看遠景時泛金黃，和天空的太陽光暈用同一組係數
// - 高度衰減：霧集中在低處，樹梢與坡頂比較清楚
// 這個模組必須在任何材質編譯前載入（main.js 第一個 import）。
// ==================================================================

// 這三個值用一般物件（不是 THREE.Vector3），UniformsUtils.clone 會保留參照，
// 所以所有內建材質共用同一份 uniform，改一次就全場景生效。
export const ATM = {
  sunDir: { x: 0, y: 1, z: 0 },
  sunColor: { x: 0, y: 0, z: 0 },
  // x：高度衰減（1/m），y：霧的基準高度（m），z：依波長散射強度（0–1）
  params: { x: 1 / 70, y: 0, z: 1 },
};

const C = THREE.ShaderChunk;

C.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogRay;
#endif`;

C.fog_vertex = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	// 相機 → 頂點的世界座標向量（viewMatrix 是剛體變換，左乘轉置即為逆旋轉）
	vFogRay = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz;
#endif`;

C.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogRay;
	uniform vec3 atmSunDir;
	uniform vec3 atmSunColor;
	uniform vec3 atmParams;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif`;

C.fog_fragment = /* glsl */ `
#ifdef USE_FOG
	float fogDist = length( vFogRay );
	vec3 fogDir = vFogRay / max( fogDist, 1e-4 );
	#ifdef FOG_EXP2
		// 光程：沿視線的平均高度越高，空氣越稀薄
		float fogH = max( cameraPosition.y + vFogRay.y * 0.5 - atmParams.y, 0.0 );
		float fogOd = fogDensity * fogDist * exp( - fogH * atmParams.x * 0.5 );
		vec3 fogFactor = 1.0 - exp( - fogOd * fogOd * mix( vec3( 1.0 ), vec3( 0.78, 1.0, 1.32 ), atmParams.z ) );
	#else
		vec3 fogFactor = vec3( smoothstep( fogNear, fogFar, vFogDepth ) );
	#endif
	float fogMu = max( dot( fogDir, atmSunDir ), 0.0 );
	vec3 fogCol = fogColor + atmSunColor * ( pow( fogMu, 6.0 ) * 0.18 + pow( fogMu, 60.0 ) * 0.4 );
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogCol, fogFactor );
#endif`;

function addAtmUniforms(u) {
  if (!u || !u.fogColor) return;
  u.atmSunDir = { value: ATM.sunDir };
  u.atmSunColor = { value: ATM.sunColor };
  u.atmParams = { value: ATM.params };
}
addAtmUniforms(THREE.UniformsLib.fog);
for (const k of Object.keys(THREE.ShaderLib)) addAtmUniforms(THREE.ShaderLib[k].uniforms);

export function setAtmosphere(sunDir, glowColor, params) {
  ATM.sunDir.x = sunDir.x; ATM.sunDir.y = sunDir.y; ATM.sunDir.z = sunDir.z;
  ATM.sunColor.x = glowColor[0]; ATM.sunColor.y = glowColor[1]; ATM.sunColor.z = glowColor[2];
  if (params) { ATM.params.x = params[0]; ATM.params.y = params[1]; ATM.params.z = params[2]; }
}
