import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let renderer, camera, scene, controls, meshGroup, ambientLight, dirLight1, dirLight2, grid;
let currentMesh = null;
let gizmoScene, gizmoCamera;

const GIZMO_PX     = 90;  // gizmo viewport size in CSS pixels
const GIZMO_MARGIN = 14;

function buildGizmo() {
  gizmoScene  = new THREE.Scene();
  gizmoCamera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
  gizmoCamera.position.set(0, 0, 3);

  const addAxis = (dir, hex, label) => {
    // Shaft line
    const shaft = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      dir.clone().multiplyScalar(0.78),
    ]);
    gizmoScene.add(new THREE.Line(
      shaft,
      new THREE.LineBasicMaterial({ color: hex, depthTest: false }),
    ));

    // Arrow-head cone
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.10, 0.24, 8),
      new THREE.MeshBasicMaterial({ color: hex, depthTest: false }),
    );
    cone.position.copy(dir.clone().multiplyScalar(0.92));
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    gizmoScene.add(cone);

    // Text label sprite
    const c   = document.createElement('canvas');
    c.width   = c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = `#${hex.toString(16).padStart(6, '0')}`;
    ctx.font      = 'bold 46px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 32, 32);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }),
    );
    sprite.position.copy(dir.clone().multiplyScalar(1.26));
    sprite.scale.set(0.42, 0.42, 1);
    gizmoScene.add(sprite);
  };

  addAxis(new THREE.Vector3(1, 0, 0), 0xff4040, 'X');
  addAxis(new THREE.Vector3(0, 1, 0), 0x44dd44, 'Y');
  addAxis(new THREE.Vector3(0, 0, 1), 0x5599ff, 'Z');
}

export function initViewer(canvas) {
  // Renderer
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111114);

  // Grid helper (subtle)
  grid = new THREE.GridHelper(200, 40, 0x222228, 0x1e1e24);
  grid.position.y = 0;
  scene.add(grid);

  // Camera
  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
  camera.position.set(0, 80, 120);
  camera.lookAt(0, 0, 0);

  // Lights
  ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambientLight);

  dirLight1 = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight1.position.set(80, 120, 60);
  dirLight1.castShadow = true;
  dirLight1.shadow.mapSize.set(1024, 1024);
  scene.add(dirLight1);

  dirLight2 = new THREE.DirectionalLight(0x8899ff, 0.4);
  dirLight2.position.set(-60, -20, -80);
  scene.add(dirLight2);

  // Group to hold the mesh
  meshGroup = new THREE.Group();
  scene.add(meshGroup);

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1;
  controls.maxDistance = 3000;
  controls.screenSpacePanning = true;

  buildGizmo();

  // Resize observer
  const resizeObserver = new ResizeObserver(() => onResize());
  resizeObserver.observe(canvas.parentElement);
  onResize();

  // Render loop
  (function animate() {
    requestAnimationFrame(animate);
    controls.update();

    const cw = renderer.domElement.clientWidth;
    const ch = renderer.domElement.clientHeight;

    // 1. Main scene — full viewport
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, cw, ch);
    renderer.render(scene, camera);

    // 2. Gizmo overlay — upper-right corner
    //    WebGL y=0 is at bottom, so upper-right means large y.
    const gx = cw - GIZMO_PX - GIZMO_MARGIN;
    const gy = ch - GIZMO_PX - GIZMO_MARGIN;
    gizmoCamera.quaternion.copy(camera.quaternion);
    renderer.setScissorTest(true);
    renderer.setScissor(gx, gy, GIZMO_PX, GIZMO_PX);
    renderer.setViewport(gx, gy, GIZMO_PX, GIZMO_PX);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(gizmoScene, gizmoCamera);
    renderer.autoClear = true;
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, cw, ch);
  })();
}

function onResize() {
  const el = renderer.domElement.parentElement;
  const w = el.clientWidth;
  const h = el.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

/**
 * Replace the mesh in the scene with new geometry.
 * @param {THREE.BufferGeometry} geometry
 * @param {THREE.Material} [material] – if omitted, a default material is used
 */
export function loadGeometry(geometry, material) {
  // Clear previous mesh
  while (meshGroup.children.length) {
    const old = meshGroup.children[0];
    old.geometry.dispose();
    if (old.material && old.material.dispose) old.material.dispose();
    meshGroup.remove(old);
  }

  const mat = material || new THREE.MeshStandardMaterial({
    color: 0xaaaacc,
    roughness: 0.6,
    metalness: 0.1,
    side: THREE.DoubleSide,
  });

  if (!geometry.attributes.normal) geometry.computeVertexNormals();

  currentMesh = new THREE.Mesh(geometry, mat);
  currentMesh.castShadow = true;
  currentMesh.receiveShadow = true;
  meshGroup.add(currentMesh);

  // Position grid at mesh bottom
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const centerY = (box.min.y + box.max.y) / 2;
  grid.position.y = box.min.y - 0.01;

  // Fit camera
  const sphere = new THREE.Sphere();
  geometry.computeBoundingSphere();
  sphere.copy(geometry.boundingSphere);
  fitCamera(sphere);
}

/**
 * Update only the material on the current mesh.
 * @param {THREE.Material} material
 */
export function setMeshMaterial(material) {
  if (!currentMesh) return;
  if (currentMesh.material && currentMesh.material.dispose) {
    currentMesh.material.dispose();
  }
  currentMesh.material = material || new THREE.MeshStandardMaterial({
    color: 0xaaaacc,
    roughness: 0.6,
    metalness: 0.1,
    side: THREE.DoubleSide,
  });
}

/**
 * Get the grid object so callers can adjust position.
 */
export function getGrid() { return grid; }

function fitCamera(sphere) {
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const dist = (sphere.radius * 2.2) / Math.tan(fov / 2);
  const dir = camera.position.clone().sub(controls.target).normalize();
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).addScaledVector(dir, dist);
  controls.update();
  camera.near = dist * 0.001;
  camera.far  = dist * 10;
  camera.updateProjectionMatrix();
}

export function getRenderer() { return renderer; }
export function getCamera()   { return camera; }
export function getScene()    { return scene; }
export function getCurrentMesh() { return currentMesh; }
