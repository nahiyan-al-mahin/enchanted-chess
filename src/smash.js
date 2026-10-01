// smash.js
// The capture effect: the captured piece bursts into stone chunks that fly
// out, bounce on the board and fade away, with a puff of dust.
//
// This is a tiny hand-made physics simulation. Every chunk has a velocity;
// each frame we add gravity, move it, and bounce it if it hits the board.

import * as THREE from 'three';

const GRAVITY = -14;
const BOARD_Y = 0;
const LIFETIME = 2.4; // seconds before a chunk is removed

// A few chunk shapes, reused for every smash.
const chunkGeometries = [
  new THREE.DodecahedronGeometry(1, 0),
  new THREE.TetrahedronGeometry(1, 0),
  new THREE.BoxGeometry(1.4, 1, 1.2),
  new THREE.IcosahedronGeometry(1, 0),
];

export class SmashEffects {
  constructor(scene) {
    this.scene = scene;
    this.chunks = [];
    this.dustClouds = [];
  }

  // Breaks `piece` (a Group from pieces.js) into pieces and removes it.
  shatter(piece) {
    const box = new THREE.Box3().setFromObject(piece);
    const center = box.getCenter(new THREE.Vector3());

    // Copy the stone material so we can fade just these chunks out.
    const material = piece.children[0].material.clone();
    material.transparent = true;

    const count = 34;
    for (let i = 0; i < count; i++) {
      const size = 0.05 + Math.random() * 0.1;
      const mesh = new THREE.Mesh(chunkGeometries[i % chunkGeometries.length], material);
      mesh.scale.setScalar(size);
      mesh.castShadow = true;

      // Start somewhere inside the piece's outline.
      mesh.position.set(
        THREE.MathUtils.lerp(box.min.x, box.max.x, Math.random()),
        THREE.MathUtils.lerp(box.min.y, box.max.y, Math.random()),
        THREE.MathUtils.lerp(box.min.z, box.max.z, Math.random())
      );
      mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);

      // Fly outward from the centre and upward.
      const out = mesh.position.clone().sub(center).setY(0);
      if (out.lengthSq() < 1e-4) out.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      out.normalize().multiplyScalar(1.5 + Math.random() * 3);

      this.chunks.push({
        mesh,
        size,
        velocity: new THREE.Vector3(out.x, 2 + Math.random() * 4, out.z),
        spin: new THREE.Vector3(Math.random() * 10 - 5, Math.random() * 10 - 5, Math.random() * 10 - 5),
        age: 0,
        material,
      });
      this.scene.add(mesh);
    }

    this.addDust(center);

    // Remove the original piece. Geometry is shared (cached), so we don't dispose it.
    piece.removeFromParent();
  }

  // A soft grey cloud of points that grows and fades.
  addDust(center) {
    const n = 70;
    const positions = new Float32Array(n * 3);
    const velocities = [];
    for (let i = 0; i < n; i++) {
      positions[i * 3] = center.x;
      positions[i * 3 + 1] = 0.2 + Math.random() * 0.5;
      positions[i * 3 + 2] = center.z;
      const a = Math.random() * Math.PI * 2;
      const s = 0.5 + Math.random() * 1.5;
      velocities.push(new THREE.Vector3(Math.cos(a) * s, Math.random() * 0.8, Math.sin(a) * s));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xb8ad98,
      size: 0.12,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    });
    const points = new THREE.Points(geo, mat);
    this.scene.add(points);
    this.dustClouds.push({ points, velocities, age: 0 });
  }

  // Called every frame with the time since the last frame (in seconds).
  update(dt) {
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i];
      c.age += dt;

      c.velocity.y += GRAVITY * dt;
      c.mesh.position.addScaledVector(c.velocity, dt);
      c.mesh.rotation.x += c.spin.x * dt;
      c.mesh.rotation.y += c.spin.y * dt;
      c.mesh.rotation.z += c.spin.z * dt;

      // Bounce on the board: lose energy each time, and slide to a stop.
      const floor = BOARD_Y + c.size * 0.7;
      if (c.mesh.position.y < floor) {
        c.mesh.position.y = floor;
        c.velocity.y *= -0.35;
        c.velocity.x *= 0.7;
        c.velocity.z *= 0.7;
        c.spin.multiplyScalar(0.6);
      }

      // Fade out during the last second.
      c.material.opacity = Math.min(1, (LIFETIME - c.age) / 1.0);

      if (c.age > LIFETIME) {
        c.mesh.removeFromParent();
        this.chunks.splice(i, 1);
        // Last chunk using this material? Free it.
        if (!this.chunks.some((o) => o.material === c.material)) c.material.dispose();
      }
    }

    for (let i = this.dustClouds.length - 1; i >= 0; i--) {
      const d = this.dustClouds[i];
      d.age += dt;
      const pos = d.points.geometry.attributes.position;
      d.velocities.forEach((v, j) => {
        v.multiplyScalar(0.96); // air drag
        pos.setXYZ(j, pos.getX(j) + v.x * dt, pos.getY(j) + v.y * dt, pos.getZ(j) + v.z * dt);
      });
      pos.needsUpdate = true;
      d.points.material.opacity = Math.max(0, 0.7 * (1 - d.age / 1.6));
      d.points.material.size = 0.12 + d.age * 0.15;
      if (d.age > 1.6) {
        d.points.removeFromParent();
        d.points.geometry.dispose();
        d.points.material.dispose();
        this.dustClouds.splice(i, 1);
      }
    }
  }
}
