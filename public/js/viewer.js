// three.js 3D 미리보기. OpenSCAD처럼 Z축이 위쪽이다.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

export const PLATE = 256; // Bambu Lab P2S / X2D 출력판 크기 (mm)

export class Viewer {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(140, -180, 140);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(100, -150, 250);
    this.scene.add(sun);
    const back = new THREE.DirectionalLight(0xffffff, 0.6);
    back.position.set(-150, 150, 80);
    this.scene.add(back);

    this.addPlate();
    this.mesh = null;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    const loop = () => {
      this.frame = requestAnimationFrame(loop);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  addPlate() {
    const plate = new THREE.Group();
    const grid = new THREE.GridHelper(PLATE, PLATE / 16, 0x9aa7b8, 0xd5dbe3);
    grid.rotation.x = Math.PI / 2;
    plate.add(grid);
    const base = new THREE.Mesh(
      new THREE.PlaneGeometry(PLATE, PLATE),
      new THREE.MeshBasicMaterial({ color: 0xeef1f5, transparent: true, opacity: 0.6, side: THREE.DoubleSide }),
    );
    base.position.z = -0.05;
    plate.add(base);
    this.scene.add(plate);
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // STL 문자열을 화면에 표시하고, 모델 크기 정보를 돌려준다.
  showStl(stlText, { color = 0x5b7cfa } = {}) {
    this.clear();
    const geometry = new STLLoader().parse(stlText);
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    // 출력판 가운데에 놓이도록 X, Y만 이동 (Z는 OpenSCAD 좌표 그대로 보여 줌)
    const cx = (bb.min.x + bb.max.x) / 2;
    const cy = (bb.min.y + bb.max.y) / 2;
    geometry.translate(-cx, -cy, 0);
    geometry.computeVertexNormals();

    this.mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, flatShading: false }),
    );
    this.scene.add(this.mesh);

    const size = new THREE.Vector3();
    bb.getSize(size);
    this.fit(size, bb.min.z);
    return {
      x: size.x,
      y: size.y,
      z: size.z,
      minZ: bb.min.z,
      triangles: geometry.attributes.position.count / 3,
    };
  }

  fit(size, minZ) {
    const radius = Math.max(size.x, size.y, size.z, 20) * 0.6;
    const target = new THREE.Vector3(0, 0, minZ + size.z / 2);
    const dir = new THREE.Vector3(0.75, -1, 0.8).normalize();
    const dist = radius / Math.sin((this.camera.fov * Math.PI) / 360);
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.controls.target.copy(target);
    this.controls.update();
  }

  clear() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.mesh = null;
    }
  }

  // 갤러리용 미리보기 이미지 (작은 JPEG)
  snapshot(width = 360) {
    this.renderer.render(this.scene, this.camera);
    const src = this.renderer.domElement;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.round((width * src.height) / src.width);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f4f6fa";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
