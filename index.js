import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';


const CONFIG = {
  // Rapunzel's tower 
  TOWER_MODEL_URL: './tower/rapunzels_tower_-_lowpoly.glb',
  TOWER_ROTATION_Y: 0,          // rotate the tower around its vertical axis (radians)
  TOWER_HEIGHT: 14,             // the model is scaled to this height (world units)
  // Wooden door on top of the tower, in the tower's LOCAL space AFTER scaling
  // (x/z centred on the tower, y = 0 at the ground). Turn on the marker to tune it.
  TOWER_DOOR_LOCAL: [0, 10.7, 3.05],
  TOWER_DOOR_FACING: [0, 0, 1], // direction the door faces (local space)
  SHOW_DOOR_MARKER: false,      // true = shows a red ball where the camera flies to

  // Boat that already has Rapunzel on it (used in the night lake scene)
  BOAT_MODEL_URL: './night-boat/i_see_the_light.glb',
  BOAT_ROTATION_Y: 0,           // use Math.PI if the boat faces the wrong way
  BOAT_LENGTH: 5.5              // longest horizontal size of the boat in world units
};

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const clamp = THREE.MathUtils.clamp;
const smooth = (a, b, x) => {
  const k = clamp((x - a) / (b - a), 0, 1);
  return k * k * (3 - 2 * k);
};
const ease = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261029);

function canvasTexture(w, h, draw, repeatX = 1, repeatY = 1) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 4;
  return t;
}

const glowCache = {};
function glowTexture(rgb) {
  if (glowCache[rgb]) return glowCache[rgb];
  return (glowCache[rgb] = canvasTexture(128, 128, (g) => {
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, `rgba(${rgb},1)`);
    grad.addColorStop(0.3, `rgba(${rgb},0.45)`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  }));
}

function glowSprite(rgb, scale, opacity = 1) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(rgb), blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false, fog: false, opacity
  }));
  s.scale.set(scale, scale, 1);
  return s;
}

// Gradient sky dome (follows the camera) built from a shader
function createSkyDome(top, mid, bottom) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: new THREE.Color(top) },
      uMid: { value: new THREE.Color(mid) },
      uBottom: { value: new THREE.Color(bottom) }
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uBottom;
      varying vec3 vDir;
      void main() {
        float h = vDir.y;
        vec3 c = mix(uBottom, uMid, smoothstep(-0.25, 0.05, h));
        c = mix(c, uTop, smoothstep(0.02, 0.65, h));
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false, fog: false
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), mat);
  dome.frustumCulled = false;
  dome.renderOrder = -10;
  const group = new THREE.Group();
  group.add(dome);
  return group;
}

function createStars(count = 1400, radius = 380) {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const theta = rand() * Math.PI * 2;
    const y = 0.03 + rand() * 0.97;
    const r = Math.sqrt(1 - y * y);
    pos[i * 3] = Math.cos(theta) * r * radius;
    pos[i * 3 + 1] = y * radius;
    pos[i * 3 + 2] = Math.sin(theta) * r * radius;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xffffff, size: 1.7, sizeAttenuation: false,
    transparent: true, opacity: 0.9, depthWrite: false, fog: false
  }));
}

// Scales a loaded model, centres it on x/z and puts its lowest point at baseY
function fitModel(object, { height = null, length = null, rotationY = 0, baseY = 0 }) {
  const wrapper = new THREE.Group();
  wrapper.add(object);
  wrapper.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(wrapper);
  const size = box.getSize(new THREE.Vector3());
  const k = height ? height / size.y : length / Math.max(size.x, size.z);
  if (isFinite(k) && k > 0) object.scale.multiplyScalar(k);
  wrapper.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(wrapper);
  const c = box.getCenter(new THREE.Vector3());
  object.position.x -= c.x;
  object.position.z -= c.z;
  object.position.y += baseY - box.min.y;
  const holder = new THREE.Group();
  holder.add(wrapper);
  holder.rotation.y = rotationY;
  return holder;
}

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.style.margin = '0';
document.body.style.background = '#05060c';
document.body.appendChild(renderer.domElement);
renderer.domElement.style.display = 'block';

function makeStage({ fov = 60, start, startTarget, orbit = {} }) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(fov, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.copy(start);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(startTarget);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  Object.assign(controls, orbit);
  controls.enabled = false;
  controls.update();
  return {
    scene, camera, controls,
    start: start.clone(), startTarget: startTarget.clone(),
    previewPos: start.clone(), previewTarget: startTarget.clone(), previewFov: fov,
    minTargetY: -Infinity,
    sky: null, portal: null, hint: '', buttonLabel: '',
    animate: () => { }, primary: null, onClick: null
  };
}

const portalMaterials = [];

const PORTAL_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const PORTAL_FRAG = `
  uniform sampler2D tPortal;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    vec4 portalColor = texture2D(tPortal, vUv);
    float wave = sin(vUv.y * 25.0 - uTime * 2.0);
    vec3 glow = vec3(0.05, 0.2, 0.8);
    vec3 finalColor = portalColor.rgb + glow * (wave * 0.5 + 0.5) * 0.18;
    float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
    float alpha = smoothstep(0.0, 0.06, edge);
    gl_FragColor = vec4(finalColor, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const frameMaterial = new THREE.MeshStandardMaterial({
  color: 0x00ccff, emissive: 0x0077ff, emissiveIntensity: 2, metalness: 0.6, roughness: 0.25
});

function createPortal(width, height, targetStage) {
  const rt = new THREE.WebGLRenderTarget(800, Math.round((800 * height) / width), {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat, depthBuffer: true
  });
  const mat = new THREE.ShaderMaterial({
    uniforms: { tPortal: { value: rt.texture }, uTime: { value: 0 } },
    vertexShader: PORTAL_VERT, fragmentShader: PORTAL_FRAG,
    transparent: true, depthWrite: false, side: THREE.DoubleSide
  });
  portalMaterials.push(mat);

  const group = new THREE.Group();
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
  plane.position.z = 0.02;
  group.add(plane);

  const t = 0.15, d = 0.25;
  const part = (w, h, x, y) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), frameMaterial);
    m.position.set(x, y, 0);
    group.add(m);
  };
  part(t, height + t, -(width / 2 + t / 2), 0);
  part(t, height + t, width / 2 + t / 2, 0);
  part(width + 2 * t, t, 0, height / 2 + t / 2);
  part(width + 2 * t, t, 0, -(height / 2 + t / 2));

  // fixed camera that looks into the target stage
  const cam = new THREE.PerspectiveCamera(targetStage.previewFov, width / height, 0.1, 1000);
  cam.position.copy(targetStage.previewPos);
  cam.lookAt(targetStage.previewTarget);

  return { group, rt, mat, cam, target: targetStage };
}

// Renders a stage (and, recursively, the stage visible inside its portal)
function renderStage(stage, camera, target = null) {
  if (stage.sky) stage.sky.position.copy(camera.position);
  if (stage.portal) {
    const p = stage.portal;
    renderStage(p.target, p.cam, p.rt);
  }
  renderer.setRenderTarget(target);
  renderer.render(stage.scene, camera);
  renderer.setRenderTarget(null);
}

function animateChain(stage, t, dt, seen = new Set()) {
  if (seen.has(stage)) return;
  seen.add(stage);
  stage.animate(t, dt);
  if (stage.portal) animateChain(stage.portal.target, t, dt, seen);
}

function buildCastle() {
  const stage = makeStage({
    fov: 55, start: V3(13, 11, 14), startTarget: V3(0, 3, 0),
    orbit: { minDistance: 6, maxDistance: 45, maxPolarAngle: 1.5 }
  });
  stage.previewFov = 55;
  stage.minTargetY = 0.5;
  stage.hint = 'Drag to orbit · scroll to zoom · press R to restart';
  stage.buttonLabel = 'Restart (R)';
  const scene = stage.scene;

  scene.background = canvasTexture(256, 256, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h * 0.45, 5, w / 2, h / 2, w * 0.75);
    gr.addColorStop(0, '#3a3c40');
    gr.addColorStop(1, '#0a0b0c');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  });

  const S = 0.3;   // size of one voxel
  const R = 22;    // island half-size in voxels
  const CX = -2, CZ = -1; // castle centre

  // ---- height map
  const heights = new Int16Array(4 * R * R);
  const hAt = (x, z) => (x < -R || x >= R || z < -R || z >= R ? 0 : heights[(x + R) * 2 * R + (z + R)]);
  for (let x = -R; x < R; x++) {
    for (let z = -R; z < R; z++) {
      const dx = x - CX, dz = z - CZ;
      const d = Math.sqrt(dx * dx + dz * dz);
      let h = 2 + Math.max(0, 10 - d * 0.55);
      h += Math.sin(x * 0.5) * Math.cos(z * 0.45) * 0.9 + Math.sin(x * 0.23 + z * 0.31) * 1.1;
      if (d < 7) h = 11; // flat courtyard plateau
      const edge = Math.max(Math.abs(x + 0.5), Math.abs(z + 0.5));
      if (edge > 18) h = h * ((R - edge) / 4);
      heights[(x + R) * 2 * R + (z + R)] = Math.max(1, Math.round(h));
    }
  }

  // ---- voxel storage
  const vox = new Map();
  const glow = new Map();
  const key = (x, y, z) => x + ',' + y + ',' + z;
  const put = (x, y, z, c) => { vox.set(key(x, y, z), c); };
  const putGlow = (x, y, z, c = 0xffd27a) => { vox.delete(key(x, y, z)); glow.set(key(x, y, z), c); };
  const box = (x0, y0, z0, x1, y1, z1, c) => {
    for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) put(x, y, z, c);
  };
  const disk = (cx, cz, r, y0, y1, c) => {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) {
        if (Math.hypot(x - cx, z - cz) <= r) for (let y = y0; y < y1; y++) put(x, y, z, c);
      }
    }
  };

  // ---- terrain
  for (let x = -R; x < R; x++) {
    for (let z = -R; z < R; z++) {
      const h = hAt(x, z);
      let lo = Math.min(h, hAt(x - 1, z), hAt(x + 1, z), hAt(x, z - 1), hAt(x, z + 1));
      lo = Math.min(lo, h - 1);
      for (let y = Math.max(0, lo); y < h; y++) {
        let c;
        if (h >= 11) c = 0xa89574;
        else if (y === h - 1) c = h >= 7 ? 0x6b5b45 : 0x3d5233;
        else c = 0x4a4038;
        put(x, y, z, c);
      }
    }
  }

  // ---- curtain wall
  for (let x = CX - 10; x <= CX + 10; x++) {
    for (let z = CZ - 10; z <= CZ + 10; z++) {
      const d = Math.hypot(x - CX, z - CZ);
      if (d > 7.6 && d < 8.9) {
        const base = hAt(x, z);
        for (let y = base - 3; y <= base + 3; y++) put(x, y, z, 0xcfb185);
        if ((x + z) % 2 === 0) put(x, base + 4, z, 0xcfb185);
        if ((x * 3 + z * 5) % 11 === 0) putGlow(x, base + 1, z);
      }
    }
  }

  // ---- round towers
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2 + 0.4;
    const tx = Math.round(CX + Math.cos(a) * 8.3);
    const tz = Math.round(CZ + Math.sin(a) * 8.3);
    const base = hAt(tx, tz);
    disk(tx, tz, 2.1, base - 3, base + 8, 0xd8bb8c);
    for (let x = tx - 3; x <= tx + 3; x++) {
      for (let z = tz - 3; z <= tz + 3; z++) {
        const d = Math.hypot(x - tx, z - tz);
        if (d <= 2.1 && d > 1.0 && (x + z) % 2 === 0) put(x, base + 8, z, 0xd8bb8c);
      }
    }
    putGlow(tx, base + 5, tz + 2);
  }

  // ---- keep (main building)
  box(-6, 11, -4, 2, 18, 4, 0xcdb083);
  box(-5, 18, -3, 1, 22, 3, 0xd6ba8c);
  for (let x = -5; x < 1; x++) for (let z = -3; z < 3; z++) {
    if ((x + z) % 2 === 0 && (x === -5 || x === 0 || z === -3 || z === 2)) put(x, 22, z, 0xd6ba8c);
  }
  for (const x of [-5, -3, -1]) for (const y of [13, 15]) putGlow(x, y, 3);
  for (const z of [-2, 0, 2]) for (const y of [13, 15]) putGlow(1, y, z);
  for (const x of [-4, -2]) putGlow(x, 19, 2);
  putGlow(0, 19, 0);

  // ---- tall tower with spire
  const tallBase = Math.max(0, hAt(-8, -5) - 4);
  box(-10, tallBase, -7, -6, 29, -3, 0xc9aa7c);
  for (const y of [18, 22, 26]) { putGlow(-8, y, -3 + 0); putGlow(-6, y, -5); }
  box(-11, 29, -8, -5, 30, -2, 0xb99770);
  box(-10, 30, -7, -6, 32, -3, 0x7d5148);
  box(-9, 32, -6, -7, 35, -4, 0x7d5148);
  put(-8, 35, -5, 0x7d5148);

  // ---- side turret
  box(-12, Math.max(0, hAt(-11, -2) - 3), -4, -9, 24, -1, 0xcdb083);
  box(-11, 24, -3, -10, 26, -2, 0x7d5148);
  putGlow(-10, 20, -1);

  // ---- little houses
  const houses = [[-16, 7], [-12, 11], [-17, 12], [-9, 13], [-14, 16]];
  for (const [hx, hz] of houses) {
    const base = Math.min(hAt(hx, hz), hAt(hx + 3, hz), hAt(hx, hz + 3), hAt(hx + 3, hz + 3));
    box(hx, base - 2, hz, hx + 4, base + 3, hz + 4, 0xd9bf9e);
    for (let l = 0; l < 3; l++) box(hx - 1 + l, base + 3 + l, hz - 1 + l, hx + 5 - l, base + 4 + l, hz + 5 - l, 0x9a5f5a);
    putGlow(hx + 1, base + 1, hz + 4);
  }

  // ---- courtyard lamps
  for (const [lx, lz] of [[CX + 3, CZ + 3], [CX - 3, CZ + 3], [CX + 4, CZ - 2], [CX - 4, CZ - 3]]) {
    put(lx, 11, lz, 0x5b4636);
    putGlow(lx, 12, lz, 0xffe2a0);
  }

  // ---- build the instanced meshes
  const hash = (x, y, z) => ((Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453) % 1 + 1) % 1;
  const cubeGeo = new THREE.BoxGeometry(1, 1, 1);
  function instance(map, material, jitter) {
    const mesh = new THREE.InstancedMesh(cubeGeo, material, Math.max(map.size, 1));
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    let i = 0;
    for (const [k, c] of map) {
      const [x, y, z] = k.split(',').map(Number);
      m.makeScale(S, S, S);
      m.setPosition((x + 0.5) * S, (y + 0.5) * S, (z + 0.5) * S);
      mesh.setMatrixAt(i, m);
      col.setHex(c);
      if (jitter) col.multiplyScalar(0.86 + hash(x, y, z) * 0.28);
      mesh.setColorAt(i, col);
      i++;
    }
    mesh.count = map.size;
    mesh.frustumCulled = false;
    return mesh;
  }
  scene.add(instance(vox, new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 }), true));
  scene.add(instance(glow, new THREE.MeshBasicMaterial(), false));

  // dark slab the island sits on
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(2 * R * S + 0.2, 3 * S, 2 * R * S + 0.2),
    new THREE.MeshStandardMaterial({ color: 0x1b2236, roughness: 0.7, metalness: 0.2 })
  );
  slab.position.y = -1.5 * S;
  scene.add(slab);

  // ---- lights
  scene.add(new THREE.HemisphereLight(0x7a6b88, 0x151018, 1.1));
  const dir = new THREE.DirectionalLight(0xb8b0d8, 1.0);
  dir.position.set(8, 14, 10);
  scene.add(dir);
  const courtyard = new THREE.PointLight(0xffa850, 25, 14, 2);
  courtyard.position.set((CX + 0.5) * S, 12.5 * S + 0.8, (CZ + 0.5) * S);
  scene.add(courtyard);
  const keepLight = new THREE.PointLight(0xffc070, 12, 9, 2);
  keepLight.position.set(-2 * S, 16 * S, 4.5 * S);
  scene.add(keepLight);

  // ---- floating lanterns drifting up to the right
  const lanterns = [];
  const bodyGeo = new THREE.BoxGeometry(0.26, 0.32, 0.26);
  for (let i = 0; i < 70; i++) {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshBasicMaterial({ color: 0xfff1cf });
    g.add(new THREE.Mesh(bodyGeo, bodyMat));
    const halo = glowSprite('255,200,140', 1.3);
    g.add(halo);
    scene.add(g);
    lanterns.push({
      g, halo, bodyMat,
      phase: rand(),
      rate: 0.025 + rand() * 0.035,
      off: V3((rand() - 0.5) * 3.5, 0, (rand() - 0.5) * 3.5),
      sc: 0.7 + rand() * 0.9
    });
  }
  const lanternOrigin = V3((CX + 1) * S, 11 * S, (CZ + 1) * S);
  const lanternDir = V3(9, 9, -1.5);

  stage.animate = (t) => {
    courtyard.intensity = 25 + Math.sin(t * 5.1) * 3 + Math.sin(t * 9.7) * 1.5;
    keepLight.intensity = 12 + Math.sin(t * 4.3 + 1) * 2;
    for (const l of lanterns) {
      const s = (l.phase + t * l.rate) % 1;
      l.g.position.copy(lanternOrigin).addScaledVector(lanternDir, s).add(l.off);
      l.g.position.x += Math.sin(t * 0.7 + l.phase * 20) * 0.15;
      const vis = smooth(0, 0.08, s) * (1 - smooth(0.85, 1, s));
      l.g.scale.setScalar(l.sc * (0.4 + 0.6 * smooth(0, 0.3, s)));
      l.halo.material.opacity = vis;
      l.bodyMat.color.setRGB(vis, vis * 0.95, vis * 0.82);
    }
  };
  return stage;
}

function buildLake(castle) {
  const stage = makeStage({
    fov: 50, start: V3(2.5, 2.4, 8.5), startTarget: V3(0, 1.6, -1),
    orbit: {
      minDistance: 3, maxDistance: 16, minPolarAngle: 0.6, maxPolarAngle: 1.65,
      minAzimuthAngle: -1.3, maxAzimuthAngle: 1.3, enablePan: false
    }
  });
  stage.previewFov = 50;
  stage.hint = 'Drag to look around · scroll to zoom · press E to enter the second portal';
  stage.buttonLabel = 'Enter portal (E)';
  const scene = stage.scene;
  scene.fog = new THREE.FogExp2(0x0b1535, 0.012);

  // sky, stars, moon
  stage.sky = createSkyDome(0x02040f, 0x0f2252, 0x0b1535);
  const stars = createStars();
  stage.sky.add(stars);
  const moonDir = V3(-0.35, 0.32, -0.88).normalize();
  const moon = new THREE.Mesh(
    new THREE.CircleGeometry(14, 48),
    new THREE.MeshBasicMaterial({ color: 0xfdf6e0, fog: false })
  );
  moon.position.copy(moonDir).multiplyScalar(350);
  moon.lookAt(0, 0, 0);
  stage.sky.add(moon);
  const moonGlow = glowSprite('190,210,255', 130, 0.8);
  moonGlow.position.copy(moonDir).multiplyScalar(345);
  stage.sky.add(moonGlow);
  scene.add(stage.sky);

  // water
  const lanternUniform = Array.from({ length: 8 }, () => V3(0, -100, 0));
  const waterMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uMoonDir: { value: moonDir },
      uLanterns: { value: lanternUniform },
      uDeep: { value: new THREE.Color(0x04102a) },
      uSky: { value: new THREE.Color(0x1d3a7a) },
      uFog: { value: new THREE.Color(0x0b1535) }
    },
    vertexShader: `
      uniform float uTime;
      varying vec3 vWorld;
      varying vec3 vNormal;
      float wave(vec2 p) {
        return sin(p.x * 0.35 + uTime * 0.8) * 0.12
             + sin(p.y * 0.5 - uTime * 0.6) * 0.10
             + sin((p.x + p.y) * 0.8 + uTime * 1.3) * 0.04;
      }
      void main() {
        vec3 pos = position;
        float e = 0.15;
        pos.y = wave(pos.xz);
        float hx = wave(pos.xz + vec2(e, 0.0)) - wave(pos.xz - vec2(e, 0.0));
        float hz = wave(pos.xz + vec2(0.0, e)) - wave(pos.xz - vec2(0.0, e));
        vNormal = normalize(vec3(-hx, 2.0 * e, -hz));
        vec4 w = modelMatrix * vec4(pos, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uMoonDir;
      uniform vec3 uLanterns[8];
      uniform vec3 uDeep;
      uniform vec3 uSky;
      uniform vec3 uFog;
      varying vec3 vWorld;
      varying vec3 vNormal;
      void main() {
        vec3 n = normalize(vNormal);
        n.xz += vec2(sin(vWorld.x * 3.1 + uTime * 1.7), cos(vWorld.z * 2.7 - uTime * 1.4)) * 0.03;
        n = normalize(n);
        vec3 v = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
        vec3 col = mix(uDeep, uSky, fres * 0.85);
        vec3 r = reflect(-v, n);
        float md = max(dot(r, normalize(uMoonDir)), 0.0);
        col += vec3(0.75, 0.85, 1.0) * (pow(md, 300.0) * 3.0 + pow(md, 20.0) * 0.15);
        for (int i = 0; i < 8; i++) {
          vec3 L = uLanterns[i];
          float d = distance(vWorld.xz, L.xz);
          float pool = exp(-d * d * 0.05);
          float shimmer = 0.6 + 0.4 * sin(vWorld.x * 4.0 + vWorld.z * 3.0 + uTime * 3.0 + float(i));
          col += vec3(1.0, 0.6, 0.25) * pool * shimmer * 0.45;
        }
        float dist = length(cameraPosition - vWorld);
        col = mix(col, uFog, 1.0 - exp(-dist * 0.006));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`
  });
  const waterGeo = new THREE.PlaneGeometry(600, 600, 200, 200);
  waterGeo.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.frustumCulled = false;
  scene.add(water);

  // lights
  scene.add(new THREE.HemisphereLight(0x4a5fa8, 0x0a1230, 0.9));
  const moonLight = new THREE.DirectionalLight(0x9fb8ff, 0.9);
  moonLight.position.copy(moonDir).multiplyScalar(50);
  scene.add(moonLight);
  const boatLight = new THREE.PointLight(0xffb36b, 14, 8, 2);
  boatLight.position.set(0, 2.4, 1);
  scene.add(boatLight);

  // boat (your GLB replaces the simple placeholder)
  const boatRoot = new THREE.Group();
  scene.add(boatRoot);
  const shape = new THREE.Shape();
  shape.moveTo(0, 2.7);
  shape.lineTo(0.95, 0.9); shape.lineTo(0.95, -1.9); shape.lineTo(0.55, -2.6);
  shape.lineTo(-0.55, -2.6); shape.lineTo(-0.95, -1.9); shape.lineTo(-0.95, 0.9);
  shape.closePath();
  const hullGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.7, bevelEnabled: false });
  hullGeo.rotateX(-Math.PI / 2);
  const placeholderBoat = new THREE.Mesh(hullGeo, new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.9 }));
  placeholderBoat.position.y = -0.25;
  boatRoot.add(placeholderBoat);
  stage.boatRoot = boatRoot;
  stage.placeholderBoat = placeholderBoat;

  // hovering lanterns - the first five carry real spotlights
  const hover = [
    [-3.2, 5.2, 1.5], [3.6, 6.0, -1.0], [0.8, 7.2, 4.2], [-6.2, 4.8, -3.5],
    [6.6, 5.4, 2.8], [-1.5, 8.0, -5], [8.5, 6.5, -4], [-9, 6, 2]
  ];
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0xffb060) }, uStrength: { value: 0.2 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uStrength; varying vec2 vUv;
      void main() {
        float a = pow(vUv.y, 1.6) * uStrength;
        gl_FragColor = vec4(uColor, a);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide, fog: false
  });
  const lanternBody = new THREE.BoxGeometry(0.34, 0.46, 0.34);
  const lanternMat = new THREE.MeshBasicMaterial({ color: 0xffd08a, fog: false });
  const hovering = hover.map(([x, y, z], i) => {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(lanternBody, lanternMat));
    g.add(glowSprite('255,190,100', 2.2));
    const beamH = y;
    const beam = new THREE.Mesh(new THREE.ConeGeometry(beamH * 0.42, beamH, 32, 1, true), beamMat);
    beam.position.y = -beamH / 2;
    g.add(beam);
    g.position.set(x, y, z);
    scene.add(g);

    let spot = null;
    if (i < 5) {
      spot = new THREE.SpotLight(0xffb870, 90, 18, 0.6, 0.6, 2);
      spot.position.set(x, y, z);
      // first two lanterns aim at the boat so Rapunzel is warmly lit
      spot.target.position.set(i < 2 ? 0 : x, i < 2 ? 1 : 0, i < 2 ? 0 : z);
      scene.add(spot, spot.target);
    }
    return { g, spot, base: V3(x, y, z), phase: rand() * 6.28 };
  });

  // distant lanterns drifting upward
  const distant = [];
  for (let i = 0; i < 50; i++) {
    const s = glowSprite('255,200,120', 0.9);
    scene.add(s);
    distant.push({
      s, x: (rand() - 0.5) * 90, z: -8 - rand() * 55,
      y0: rand() * 40, speed: 0.4 + rand() * 0.5, phase: rand() * 6.28
    });
  }

  // second portal at the back of the lake, showing the voxel castle
  const portal = createPortal(4.2, 4.9, castle);
  portal.group.position.set(0, 2.75, -10);
  scene.add(portal.group);
  stage.portal = portal;
  const portalGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 10),
    new THREE.MeshBasicMaterial({
      map: glowTexture('60,170,255'), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity: 0.7, fog: false
    })
  );
  portalGlow.rotation.x = -Math.PI / 2;
  portalGlow.position.set(0, 0.32, -9.5);
  scene.add(portalGlow);
  const portalLight = new THREE.PointLight(0x33aaff, 30, 16, 2);
  portalLight.position.set(0, 3, -8.5);
  scene.add(portalLight);

  let mixer = null;
  stage.setBoatModel = (model, animations) => {
    boatRoot.remove(placeholderBoat);
    const fitted = fitModel(model, { length: CONFIG.BOAT_LENGTH, rotationY: CONFIG.BOAT_ROTATION_Y, baseY: -0.15 });
    boatRoot.add(fitted);
    fitted.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
    if (animations && animations.length) {
      mixer = new THREE.AnimationMixer(model);
      mixer.clipAction(animations[0]).play();
    }
  };

  stage.animate = (t, dt) => {
    waterMat.uniforms.uTime.value = t;
    stars.material.opacity = 0.75 + Math.sin(t * 2) * 0.15;
    boatRoot.position.y = Math.sin(t * 1.1) * 0.06;
    boatRoot.rotation.z = Math.sin(t * 0.9) * 0.03;
    boatRoot.rotation.x = Math.sin(t * 0.7) * 0.02;
    boatLight.intensity = 14 + Math.sin(t * 3.3) * 1.5;
    if (mixer) mixer.update(dt);

    hovering.forEach((l, i) => {
      l.g.position.set(
        l.base.x + Math.sin(t * 0.35 + l.phase) * 0.5,
        l.base.y + Math.sin(t * 0.8 + l.phase) * 0.25,
        l.base.z + Math.cos(t * 0.3 + l.phase) * 0.4
      );
      if (l.spot) l.spot.position.copy(l.g.position);
      lanternUniform[i].copy(l.g.position);
    });
    for (const d of distant) {
      d.s.position.set(d.x + Math.sin(t * 0.4 + d.phase) * 1.2, 2 + ((d.y0 + t * d.speed) % 42), d.z);
    }
  };
  return stage;
}

function buildRoom(lake) {
  const stage = makeStage({
    fov: 65, start: V3(0, 1.65, 2.9), startTarget: V3(0, 1.7, 0),
    orbit: { minDistance: 0.8, maxDistance: 3.1, minPolarAngle: 0.9, maxPolarAngle: 2.0, enablePan: false }
  });
  stage.hint = 'Drag to look around · press E to step through the portal';
  stage.buttonLabel = 'Enter portal (E)';
  const scene = stage.scene;
  scene.background = new THREE.Color(0x0a0710);

  const woodTex = canvasTexture(256, 256, (g, w, h) => {
    const planks = 8;
    for (let i = 0; i < planks; i++) {
      const y = (i * h) / planks;
      const s = 90 + Math.floor(rand() * 40);
      g.fillStyle = `rgb(${s + 30},${s},${Math.floor(s * 0.55)})`;
      g.fillRect(0, y, w, h / planks);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(0, y, w, 2);
      for (let k = 0; k < 30; k++) {
        g.fillStyle = `rgba(0,0,0,${0.03 + rand() * 0.05})`;
        g.fillRect(rand() * w, y + rand() * (h / planks), 20 + rand() * 60, 1);
      }
    }
  }, 3, 3);
  const stoneTex = canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#2a2630';
    g.fillRect(0, 0, w, h);
    const rows = 8;
    for (let r = 0; r < rows; r++) {
      const bh = h / rows;
      let x = -(r % 2) * 20;
      while (x < w) {
        const bw = 40 + rand() * 30;
        const s = 110 + Math.floor(rand() * 50);
        g.fillStyle = `rgb(${s},${s - 6},${s - 14})`;
        g.fillRect(x, r * bh, bw - 2, bh - 2);
        x += bw;
      }
    }
  }, 6, 1.5);

  const woodMat = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.85 });
  const darkWood = new THREE.MeshStandardMaterial({ color: 0x4a2e1a, roughness: 0.9 });

  // floor, walls, roof underside
  const floor = new THREE.Mesh(new THREE.CircleGeometry(3.6, 48), woodMat);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(3.6, 3.6, 4.2, 48, 1, true),
    new THREE.MeshStandardMaterial({ map: stoneTex, roughness: 1, side: THREE.BackSide })
  );
  wall.position.y = 2.1;
  scene.add(wall);
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(3.7, 1.8, 48, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x3a2a40, roughness: 1, side: THREE.BackSide })
  );
  roof.position.y = 5.1;
  scene.add(roof);
  for (const a of [0, Math.PI / 2]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.25, 0.25), darkWood);
    beam.position.y = 4.15;
    beam.rotation.y = a;
    scene.add(beam);
  }

  // wooden door (behind the starting camera)
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.3, 0.12), woodMat);
  door.position.set(0, 1.15, 3.5);
  door.rotation.y = Math.PI;
  scene.add(door);
  for (const [w, h, x, y] of [[0.14, 2.4, -0.77, 1.2], [0.14, 2.4, 0.77, 1.2], [1.68, 0.14, 0, 2.38]]) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.2), darkWood);
    f.position.set(x, y, 3.48);
    scene.add(f);
  }
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.09, 0.02, 8, 20),
    new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.8, roughness: 0.4 })
  );
  ring.position.set(0.4, 1.1, 3.4);
  scene.add(ring);

  // window with a night sky
  const winTex = canvasTexture(128, 192, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#0a1030');
    gr.addColorStop(1, '#2a3f8a');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffffff';
    for (let i = 0; i < 40; i++) g.fillRect(rand() * w, rand() * h, 1.5, 1.5);
  });
  const win = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.8), new THREE.MeshBasicMaterial({ map: winTex }));
  win.position.set(-3.5, 2.4, 0.5);
  win.rotation.y = Math.PI / 2;
  scene.add(win);
  for (const [w, h, y, z] of [[0.1, 1.9, 2.4, 0.5 - 0.65], [0.1, 1.9, 2.4, 0.5 + 0.65], [0.1, 0.1, 3.3, 0.5], [0.1, 0.1, 1.5, 0.5]]) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(0.2, h, w === 0.1 && h === 0.1 ? 1.4 : w), darkWood);
    f.position.set(-3.48, y, z);
    scene.add(f);
  }
  const moonLight = new THREE.PointLight(0x7a9cff, 8, 9, 2);
  moonLight.position.set(-3.0, 2.6, 0.5);
  scene.add(moonLight);

  // rug
  const rug = new THREE.Mesh(new THREE.CircleGeometry(1.7, 40), new THREE.MeshStandardMaterial({ color: 0x7a3f9a, roughness: 1 }));
  rug.rotation.x = -Math.PI / 2;
  rug.position.y = 0.01;
  scene.add(rug);
  const rug2 = new THREE.Mesh(new THREE.RingGeometry(1.2, 1.35, 40), new THREE.MeshStandardMaterial({ color: 0xf0c060, roughness: 1 }));
  rug2.rotation.x = -Math.PI / 2;
  rug2.position.y = 0.02;
  scene.add(rug2);

  // table with candles
  const table = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.45, 0.8, 20), woodMat);
  table.position.set(1.9, 0.4, 1.3);
  scene.add(table);
  const flames = [];
  for (let i = 0; i < 3; i++) {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.28, 10), new THREE.MeshStandardMaterial({ color: 0xf5ecd0 }));
    c.position.set(1.9 + (i - 1) * 0.18, 0.94, 1.3 + (i % 2) * 0.1);
    scene.add(c);
    const f = glowSprite('255,190,90', 0.35);
    f.position.set(c.position.x, 1.15, c.position.z);
    scene.add(f);
    flames.push(f);
  }
  const candleLight = new THREE.PointLight(0xffa24d, 8, 7, 2);
  candleLight.position.set(1.9, 1.25, 1.3);
  scene.add(candleLight);

  // hanging paper lanterns
  for (const [x, z] of [[-1.6, 1.0], [1.2, -1.2], [-0.4, 2.0]]) {
    const string = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 1.0, 4), darkWood);
    string.position.set(x, 3.65, z);
    scene.add(string);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.4, 0.3), new THREE.MeshBasicMaterial({ color: 0xffd08a }));
    body.position.set(x, 3.0, z);
    scene.add(body);
    const g = glowSprite('255,190,100', 1.6);
    g.position.set(x, 3.0, z);
    scene.add(g);
  }

  // lights
  scene.add(new THREE.AmbientLight(0x6b5a7a, 0.9));
  const warm = new THREE.PointLight(0xffb26b, 18, 10, 2);
  warm.position.set(0, 3, 0);
  scene.add(warm);

  // the portal to the night lake
  const portal = createPortal(2.6, 3.0, lake);
  portal.group.position.set(0, 1.85, -2.5);
  scene.add(portal.group);
  stage.portal = portal;
  const portalLight = new THREE.PointLight(0x33aaff, 12, 7, 2);
  portalLight.position.set(0, 1.8, -1.6);
  scene.add(portalLight);

  stage.animate = (t) => {
    const f = Math.sin(t * 9) * 0.5 + Math.sin(t * 13.7) * 0.5;
    candleLight.intensity = 8 + f * 1.2;
    flames.forEach((s, i) => s.scale.setScalar(0.35 + Math.sin(t * 11 + i) * 0.03));
  };
  return stage;
}

function terrainHeight(x, z) {
  const d = Math.hypot(x, z);
  const flat = smooth(12, 40, d);
  const rolling = Math.sin(x * 0.04) * Math.cos(z * 0.05) * 5 + Math.sin(x * 0.09 + z * 0.06) * 2 + Math.cos(z * 0.13 - x * 0.07);
  const mount = smooth(120, 230, d) * 40;
  return flat * (2.5 + rolling) + mount;
}

function buildWorld(room) {
  const stage = makeStage({
    fov: 55, start: V3(18, 9, 26), startTarget: V3(0, 7, 0),
    orbit: { minDistance: 6, maxDistance: 80, maxPolarAngle: Math.PI / 2 - 0.03 }
  });
  stage.minTargetY = 0.5;
  stage.hint = 'Drag to orbit · scroll to zoom · click to enter the tower';
  stage.buttonLabel = 'Enter tower';
  const scene = stage.scene;
  scene.fog = new THREE.Fog(0xf3cfae, 80, 480);

  // sky + sun
  stage.sky = createSkyDome(0x4f7fd0, 0xf6b98e, 0xf3cfae);
  const sunDir = V3(0.55, 0.28, -0.78).normalize();
  const sun = new THREE.Mesh(new THREE.CircleGeometry(18, 40), new THREE.MeshBasicMaterial({ color: 0xfff1c9, fog: false }));
  sun.position.copy(sunDir).multiplyScalar(370);
  sun.lookAt(0, 0, 0);
  stage.sky.add(sun);
  const sunGlow = glowSprite('255,220,160', 170, 0.9);
  sunGlow.position.copy(sunDir).multiplyScalar(365);
  stage.sky.add(sunGlow);
  scene.add(stage.sky);

  // lights
  scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x4a6a3a, 1.0));
  const sunLight = new THREE.DirectionalLight(0xffd9a8, 2.2);
  sunLight.position.copy(sunDir).multiplyScalar(120);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  Object.assign(sunLight.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 300 });
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.05;
  scene.add(sunLight);

  // grass ground
  const groundGeo = new THREE.PlaneGeometry(900, 900, 180, 180);
  groundGeo.rotateX(-Math.PI / 2);
  const gp = groundGeo.attributes.position;
  const gc = new Float32Array(gp.count * 3);
  const colA = new THREE.Color(0x5f9e45), colB = new THREE.Color(0x3f7a35), colR = new THREE.Color(0x6b6a52), tmp = new THREE.Color();
  for (let i = 0; i < gp.count; i++) {
    const x = gp.getX(i), z = gp.getZ(i);
    const h = terrainHeight(x, z);
    gp.setY(i, h);
    const n = (Math.sin(x * 0.21) * Math.cos(z * 0.17) + 1) / 2;
    tmp.copy(colA).lerp(colB, n).lerp(colR, smooth(100, 220, Math.hypot(x, z)));
    gc[i * 3] = tmp.r; gc[i * 3 + 1] = tmp.g; gc[i * 3 + 2] = tmp.b;
  }
  groundGeo.setAttribute('color', new THREE.BufferAttribute(gc, 3));
  groundGeo.computeVertexNormals();
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }));
  ground.receiveShadow = true;
  scene.add(ground);

  // mountains
  const mountMat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 1, flatShading: true });
  const snowMat = new THREE.MeshStandardMaterial({ color: 0xf4f7ff, roughness: 0.9, flatShading: true });
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + rand() * 0.3;
    const r = 190 + rand() * 70;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = 70 + rand() * 60, rad = 55 + rand() * 35;
    const baseY = terrainHeight(x, z) - 8;
    const m = new THREE.Mesh(new THREE.ConeGeometry(rad, h, 6, 1), mountMat(new THREE.Color(0x6c7ba3).lerp(new THREE.Color(0x8a7fa5), rand())));
    m.position.set(x, baseY + h / 2, z);
    m.rotation.y = rand() * 3;
    scene.add(m);
    const hs = h * 0.3;
    const snow = new THREE.Mesh(new THREE.ConeGeometry(rad * 0.3, hs, 6, 1), snowMat);
    snow.position.set(x, baseY + h - hs / 2, z);
    snow.rotation.y = m.rotation.y;
    scene.add(snow);
  }
  for (let i = 0; i < 22; i++) {
    const a = rand() * Math.PI * 2;
    const r = 110 + rand() * 60;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = 22 + rand() * 25, rad = 28 + rand() * 18;
    const m = new THREE.Mesh(new THREE.ConeGeometry(rad, h, 7, 1), mountMat(new THREE.Color(0x4f7a45).lerp(new THREE.Color(0x3d6a45), rand())));
    m.position.set(x, terrainHeight(x, z) - 2 + h / 2, z);
    m.rotation.y = rand() * 3;
    scene.add(m);
  }

  // trees (instanced)
  const dummy = new THREE.Object3D();
  const foliageMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true });
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a3d28, roughness: 1 });
  const PINES = 170, BROAD = 90;
  const pineTrunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.32, 2, 6), trunkMat, PINES);
  const pineA = new THREE.InstancedMesh(new THREE.ConeGeometry(1.9, 3.4, 7), foliageMat, PINES);
  const pineB = new THREE.InstancedMesh(new THREE.ConeGeometry(1.4, 2.8, 7), foliageMat, PINES);
  const broadTrunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.35, 2.4, 6), trunkMat, BROAD);
  const broadTop = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.7, 1), foliageMat, BROAD);
  const col = new THREE.Color();
  const place = (mesh, i, x, y, z, s) => {
    dummy.position.set(x, y, z);
    dummy.scale.setScalar(s);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  };
  for (let i = 0; i < PINES; i++) {
    const a = rand() * Math.PI * 2, r = 16 + Math.sqrt(rand()) * 95;
    const x = Math.cos(a) * r, z = Math.sin(a) * r, h = terrainHeight(x, z), s = 0.9 + rand() * 1.1;
    place(pineTrunk, i, x, h + 1 * s, z, s);
    place(pineA, i, x, h + 3.0 * s, z, s);
    place(pineB, i, x, h + 5.0 * s, z, s);
    col.setHSL(0.33 + rand() * 0.04, 0.45, 0.2 + rand() * 0.08);
    pineA.setColorAt(i, col);
    pineB.setColorAt(i, col);
  }
  for (let i = 0; i < BROAD; i++) {
    const a = rand() * Math.PI * 2, r = 14 + Math.sqrt(rand()) * 70;
    const x = Math.cos(a) * r, z = Math.sin(a) * r, h = terrainHeight(x, z), s = 0.9 + rand() * 0.9;
    place(broadTrunk, i, x, h + 1.2 * s, z, s);
    place(broadTop, i, x, h + 3.4 * s, z, s);
    col.setHSL(0.25 + rand() * 0.06, 0.5, 0.32 + rand() * 0.08);
    broadTop.setColorAt(i, col);
  }
  for (const m of [pineTrunk, pineA, pineB, broadTrunk, broadTop]) {
    m.castShadow = true;
    m.frustumCulled = false;
    scene.add(m);
  }

  // drifting clouds
  const clouds = [];
  const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true, emissive: 0x884433, emissiveIntensity: 0.15 });
  for (let i = 0; i < 12; i++) {
    const c = new THREE.Group();
    for (let k = 0; k < 5; k++) {
      const p = new THREE.Mesh(new THREE.IcosahedronGeometry(5 + rand() * 4, 1), cloudMat);
      p.position.set(k * 6 - 12 + rand() * 3, rand() * 2, rand() * 4);
      p.scale.y = 0.6;
      c.add(p);
    }
    c.position.set((rand() - 0.5) * 500, 70 + rand() * 40, -80 - rand() * 200);
    scene.add(c);
    clouds.push(c);
  }

  // the tower: fallback built from geometry until your GLB loads
  const towerRoot = new THREE.Group();
  towerRoot.rotation.y = CONFIG.TOWER_ROTATION_Y;
  scene.add(towerRoot);
  const fallback = new THREE.Group();
  towerRoot.add(fallback);
  const stone = new THREE.MeshStandardMaterial({ color: 0xc2b095, roughness: 1 });
  const add = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    fallback.add(m);
    return m;
  };
  add(new THREE.CylinderGeometry(2.3, 2.8, 9.5, 24), stone, 0, 4.75, 0);
  add(new THREE.CylinderGeometry(3.4, 3.4, 0.3, 24), stone, 0, 9.65, 0);
  add(new THREE.CylinderGeometry(3.0, 3.0, 2.6, 24), new THREE.MeshStandardMaterial({ color: 0xd2bfa4, roughness: 1 }), 0, 10.95, 0);
  add(new THREE.ConeGeometry(3.8, 2.4, 24), new THREE.MeshStandardMaterial({ color: 0x7a4aa0, roughness: 0.8 }), 0, 13.4, 0);
  add(new THREE.BoxGeometry(1.3, 2.0, 0.18), new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.9 }), 0, 10.7, 3.05);
  const winMat = new THREE.MeshBasicMaterial({ color: 0xffd27a });
  for (const [y, a] of [[4, 0.5], [6.5, 2.2], [3, 3.8], [7, 5.2]]) {
    add(new THREE.BoxGeometry(0.35, 0.6, 0.12), winMat, Math.sin(a) * 2.55, y, Math.cos(a) * 2.55).rotation.y = a;
  }
  if (CONFIG.SHOW_DOOR_MARKER) {
    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 12), new THREE.MeshBasicMaterial({ color: 0xff2222 }));
    marker.position.set(...CONFIG.TOWER_DOOR_LOCAL);
    towerRoot.add(marker);
  }
  stage.towerRoot = towerRoot;
  stage.fallbackTower = fallback;

  // Let the tower doorway show the room itself, so entering feels continuous.
  const doorPortal = createPortal(1.3, 2.15, room);
  const doorPortalPosition = V3(...CONFIG.TOWER_DOOR_LOCAL)
    .addScaledVector(V3(...CONFIG.TOWER_DOOR_FACING).normalize(), 0.07);
  doorPortal.group.position.copy(doorPortalPosition);
  doorPortal.group.rotation.y = Math.atan2(CONFIG.TOWER_DOOR_FACING[0], CONFIG.TOWER_DOOR_FACING[2]);
  towerRoot.add(doorPortal.group);
  stage.portal = doorPortal;

  stage.setTowerModel = (model) => {
    towerRoot.remove(fallback);
    const fitted = fitModel(model, { height: CONFIG.TOWER_HEIGHT, baseY: 0 });
    fitted.traverse(o => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } });
    towerRoot.add(fitted);
  };

  stage.animate = (t, dt) => {
    for (const c of clouds) {
      c.position.x += dt * 1.5;
      if (c.position.x > 280) c.position.x = -280;
    }
  };
  return stage;
}

const castle = buildCastle();
const lake = buildLake(castle);
const room = buildRoom(lake);
const world = buildWorld(room);
let current = world;

// soft image-based lighting so PBR materials in GLBs don't look flat
try {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
  world.scene.environment = env;
  world.scene.environmentIntensity = 0.5;
  lake.scene.environment = env;
  lake.scene.environmentIntensity = 0.15;
  pmrem.dispose();
} catch (err) {
  console.warn('Environment lighting skipped:', err);
}

const hud = document.createElement('div');
hud.style.cssText =
  'position:fixed;left:0;right:0;bottom:22px;display:flex;flex-direction:column;align-items:center;gap:8px;' +
  'pointer-events:none;z-index:10;font-family:system-ui,sans-serif;color:#fff;text-align:center;padding:0 12px;' +
  'text-shadow:0 0 8px rgba(0,0,0,.9),0 0 14px rgba(0,160,255,.7);';
document.body.appendChild(hud);
const statusEl = document.createElement('div');
const hintEl = document.createElement('div');
const mainBtn = document.createElement('button');
mainBtn.style.cssText =
  'pointer-events:auto;cursor:pointer;padding:10px 22px;border-radius:999px;border:1px solid #33bbff;' +
  'background:rgba(0,40,90,.6);color:#e6f6ff;font-size:15px;letter-spacing:.06em;backdrop-filter:blur(4px);';
hud.append(statusEl, hintEl, mainBtn);

const overlay = document.createElement('div');
overlay.style.cssText =
  'position:fixed;inset:0;pointer-events:none;opacity:0;z-index:5;' +
  'background:radial-gradient(circle at center,#e6f8ff 0%,#4cc3ff 45%,#1a3cff 100%);';
document.body.appendChild(overlay);

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#ff9a9a' : '#cfe9ff';
}

const clock = new THREE.Clock();
let state = 'idle'; // 'idle' | 'flying' | 'fading'
let flight = null;
let fade = null;
let overlayValue = 0;

function updateHud() {
  hintEl.textContent = state === 'idle' ? current.hint : '';
  mainBtn.textContent = current.buttonLabel;
  mainBtn.disabled = state !== 'idle';
  mainBtn.style.opacity = state === 'idle' ? '1' : '0.4';
}

function makePath(points) {
  const pts = [];
  for (const v of points) if (!pts.length || pts[pts.length - 1].distanceTo(v) > 0.05) pts.push(v.clone());
  if (pts.length < 2) pts.push(pts[0].clone().add(V3(0, 0, 0.1)));
  return new THREE.CatmullRomCurve3(pts, false, 'centripetal');
}

function fly(t, { stage, points, lookTo, dur, next }) {
  state = 'flying';
  stage.controls.enabled = false;
  flight = {
    stage, start: t, dur, next,
    curve: makePath(points),
    lookFrom: stage.controls.target.clone(),
    lookTo: lookTo.clone()
  };
  updateHud();
}

function arrive(t, stage, withFade = false) {
  current = stage;
  stage.camera.position.copy(stage.start);
  stage.controls.target.copy(stage.startTarget);
  stage.controls.update();

  // Normal scene entry is a direct continuation through the portal, not a screen flash.
  if (withFade) {
    state = 'fading';
    fade = {
      start: t, dur: 1.1, from: overlayValue, to: 0,
      onDone: () => { state = 'idle'; stage.controls.enabled = true; updateHud(); }
    };
  } else {
    state = 'idle';
    fade = null;
    overlayValue = 0;
    stage.controls.enabled = true;
  }
  updateHud();
}

function updateFlight(t) {
  if (flight) {
    const f = flight;
    const p = Math.min((t - f.start) / f.dur, 1);
    const e = ease(p);
    f.stage.camera.position.copy(f.curve.getPoint(e));
    f.stage.camera.lookAt(f.lookFrom.clone().lerp(f.lookTo, e));
    // Keep the view unobstructed while the portal grows to fill the screen.
    overlayValue = 0;
    if (p >= 1) {
      flight = null;
      arrive(t, f.next);
    }
  } else if (fade) {
    const k = clamp((t - fade.start) / fade.dur, 0, 1);
    overlayValue = THREE.MathUtils.lerp(fade.from, fade.to, ease(k));
    if (k >= 1) {
      const done = fade.onDone;
      fade = null;
      if (done) done();
    }
  }
  overlay.style.opacity = overlayValue.toFixed(3);
}

// 1) click: fly up to the wooden door and into the tower room
world.primary = (t) => {
  const tr = world.towerRoot;
  tr.updateMatrixWorld(true);
  const door = V3(...CONFIG.TOWER_DOOR_LOCAL);
  tr.localToWorld(door);
  const facing = V3(...CONFIG.TOWER_DOOR_FACING).transformDirection(tr.matrixWorld).normalize();
  const front = door.clone().addScaledVector(facing, 4);
  const mid = door.clone().addScaledVector(facing, 14).add(V3(0, 1.5, 0));

  const cam = world.camera.position.clone();
  const pts = [cam];
  const toCam = cam.clone().sub(door); toCam.y = 0; toCam.normalize();
  if (toCam.dot(facing) < 0.2) { // camera is on the far side of the tower: go around it
    const side = V3(0, 1, 0).cross(facing).normalize();
    const s = Math.sign(toCam.dot(side)) || 1;
    pts.push(door.clone().addScaledVector(facing, 6).addScaledVector(side, 16 * s).add(V3(0, 3, 0)));
  }
  pts.push(mid, front, door.clone().addScaledVector(facing, 0.2));
  fly(t, { stage: world, points: pts, lookTo: door, dur: 3.4, next: room });
};
world.onClick = world.primary;

// 2) E in the tower room: through the first portal into the night lake
room.primary = (t) => {
  fly(t, {
    stage: room,
    points: [room.camera.position, V3(0, 1.85, -1.3), V3(0, 1.85, -2.35)],
    lookTo: V3(0, 1.85, -3), dur: 2.2, next: lake
  });
};

// 3) E on the lake: over the boat and through the second portal into the castle
lake.primary = (t) => {
  fly(t, {
    stage: lake,
    points: [lake.camera.position, V3(0, 6.5, 1.5), V3(0, 2.75, -9.85)],
    lookTo: V3(0, 2.75, -12), dur: 3.2, next: castle
  });
};

// R: restart from the beginning
castle.primary = () => restart();
function restart() {
  if (state !== 'idle') return;
  state = 'fading';
  current.controls.enabled = false;
  fade = {
    start: clock.getElapsedTime(), dur: 0.5, from: overlayValue, to: 1,
    onDone: () => arrive(clock.getElapsedTime(), world, true)
  };
  updateHud();
}

/* ============================================================
   INPUT
   ============================================================ */
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'KeyR') restart();
  if (e.code === 'KeyE' && state === 'idle' && (current === room || current === lake)) current.primary(clock.getElapsedTime());
});

mainBtn.addEventListener('click', () => {
  if (state === 'idle' && current.primary) current.primary(clock.getElapsedTime());
  mainBtn.blur();
});

// a quick left click (not a drag) in the outside world enters the tower
let downInfo = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  downInfo = { x: e.clientX, y: e.clientY, time: performance.now(), button: e.button };
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downInfo || downInfo.button !== 0 || e.button !== 0) return;
  const moved = Math.hypot(e.clientX - downInfo.x, e.clientY - downInfo.y);
  const dtime = performance.now() - downInfo.time;
  downInfo = null;
  if (moved < 6 && dtime < 500 && state === 'idle' && current.onClick) current.onClick(clock.getElapsedTime());
});

/* ============================================================
   LOADING YOUR GLB MODELS
   ============================================================ */
async function checkUrl(url) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    const type = r.headers.get('content-type') || '';
    if (r.status === 404) return 'file not found (404)';
    if (type.includes('text/html')) return 'the server returned a web page instead of a .glb (wrong path)';
  } catch (_) { /* let the loader report real network errors */ }
  return null;
}

async function loadGLB(loader, url, label) {
  const problem = await checkUrl(url);
  if (problem) throw new Error(problem + ' -> ' + new URL(url, location.href).href);
  return loader.loadAsync(url, (e) => {
    if (e.lengthComputable) setStatus('Loading ' + label + '... ' + Math.round((e.loaded / e.total) * 100) + '%');
  });
}

async function loadAssets() {
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder(MeshoptDecoder);

  const problems = [];
  if (CONFIG.TOWER_MODEL_URL) {
    setStatus('Loading tower...');
    try {
      const gltf = await loadGLB(loader, CONFIG.TOWER_MODEL_URL, 'tower');
      world.setTowerModel(gltf.scene);
    } catch (err) {
      console.error('Tower failed to load:', err);
      problems.push('Tower: ' + (err.message || err));
    }
  }
  if (CONFIG.BOAT_MODEL_URL) {
    setStatus('Loading boat...');
    try {
      const gltf = await loadGLB(loader, CONFIG.BOAT_MODEL_URL, 'boat');
      lake.setBoatModel(gltf.scene, gltf.animations);
    } catch (err) {
      console.error('Boat failed to load:', err);
      problems.push('Boat: ' + (err.message || err));
    }
  }
  if (problems.length) setStatus(problems.join('  |  ') + '  (showing simple stand-ins)', true);
  else setStatus('');
}
//anim loop
let lastT = 0;
function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();
  const dt = Math.min(t - lastT, 0.1);
  lastT = t;

  updateFlight(t);

  const c = current.controls;
  if (c.enabled) {
    c.target.y = Math.max(current.minTargetY, c.target.y);
    c.update();
  }

  animateChain(current, t, dt);
  for (const m of portalMaterials) m.uniforms.uTime.value = t;
  renderStage(current, current.camera, null);
}

updateHud();
loadAssets();
animate();
arrive(0, world); // fade in from the flash at start

window.addEventListener('resize', () => {
  for (const s of [world, room, lake, castle]) {
    s.camera.aspect = window.innerWidth / window.innerHeight;
    s.camera.updateProjectionMatrix();
  }
  renderer.setSize(window.innerWidth, window.innerHeight);
});