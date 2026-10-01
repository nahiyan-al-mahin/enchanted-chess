// pieces.js
// Builds the carved stone pieces out of simple shapes, so there are no
// model files to load. Most pieces are "lathed": we draw half of the
// outline as a list of [radius, height] points, and Three.js spins it
// around the vertical axis like clay on a potter's wheel.

import * as THREE from 'three';
import { pieceMaterials, runeMaterials, detailMaterial } from './materials.js';

// The same plinth (stone base) for every piece.
const BASE = [
  [0, 0],
  [0.38, 0],
  [0.38, 0.08],
  [0.32, 0.12],
  [0.3, 0.18],
];

function lathe(points) {
  const v = [...BASE, ...points].map(([r, h]) => new THREE.Vector2(r, h));
  return new THREE.LatheGeometry(v, 40);
}

// Geometry is built once per piece type and then reused (cached).
const cache = {};
function cached(key, build) {
  if (!cache[key]) cache[key] = build();
  return cache[key];
}

// Each builder returns a list of [geometry, position, rotation?, useDetailMaterial?]
const builders = {
  // Pawn: a hooded acolyte. Short body, round head.
  p: () => [
    [cached('p-body', () => lathe([[0.2, 0.26], [0.13, 0.5], [0.21, 0.55], [0.21, 0.58], [0.1, 0.62], [0, 0.62]])), [0, 0, 0]],
    [cached('p-head', () => new THREE.SphereGeometry(0.15, 24, 16)), [0, 0.74, 0]],
  ],

  // Rook: a watchtower with battlements.
  r: () => {
    const parts = [
      [cached('r-body', () => lathe([[0.25, 0.3], [0.22, 0.82], [0.31, 0.86], [0.31, 1.0], [0, 1.0]])), [0, 0, 0]],
    ];
    const merlon = cached('r-merlon', () => new THREE.BoxGeometry(0.13, 0.14, 0.13));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      parts.push([merlon, [Math.cos(a) * 0.24, 1.07, Math.sin(a) * 0.24], [0, -a, 0]]);
    }
    return parts;
  },

  // Knight: a horse-head silhouette, extruded into 3D.
  n: () => [
    [cached('n-body', () => lathe([[0.26, 0.28], [0, 0.28]])), [0, 0, 0]],
    [cached('n-head', makeHorseHead), [0, 0.26, 0], [0, -Math.PI / 2, 0]],
  ],

  // Bishop: a tall seer with a notched mitre.
  b: () => [
    [cached('b-body', () => lathe([[0.15, 0.36], [0.11, 0.76], [0.22, 0.8], [0.22, 0.84], [0.1, 0.88], [0, 0.88]])), [0, 0, 0]],
    [cached('b-mitre', () => new THREE.SphereGeometry(0.17, 24, 16).scale(1, 1.5, 1)), [0, 1.08, 0]],
    [cached('b-tip', () => new THREE.SphereGeometry(0.05, 12, 8)), [0, 1.36, 0]],
    [cached('b-notch', () => new THREE.BoxGeometry(0.03, 0.22, 0.4)), [0.05, 1.16, 0], [0, 0, 0.5], true],
  ],

  // Queen: a sorceress crowned with orbs.
  q: () => {
    const parts = [
      [cached('q-body', () => lathe([[0.16, 0.4], [0.12, 0.96], [0.25, 1.02], [0.25, 1.06], [0.14, 1.1], [0.21, 1.24], [0, 1.18]])), [0, 0, 0]],
      [cached('q-top', () => new THREE.SphereGeometry(0.08, 16, 12)), [0, 1.3, 0]],
    ];
    const orb = cached('q-orb', () => new THREE.SphereGeometry(0.045, 12, 8));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      parts.push([orb, [Math.cos(a) * 0.19, 1.26, Math.sin(a) * 0.19]]);
    }
    return parts;
  },

  // King: the tallest, topped with a carved cross.
  k: () => [
    [cached('k-body', () => lathe([[0.17, 0.4], [0.13, 1.02], [0.26, 1.08], [0.26, 1.12], [0.15, 1.16], [0.2, 1.3], [0, 1.3]])), [0, 0, 0]],
    [cached('k-cross-v', () => new THREE.BoxGeometry(0.08, 0.32, 0.08)), [0, 1.46, 0]],
    [cached('k-cross-h', () => new THREE.BoxGeometry(0.24, 0.08, 0.08)), [0, 1.5, 0]],
  ],
};

// A horse-head outline (facing +x), extruded and bevelled.
function makeHorseHead() {
  const outline = [
    [-0.2, 0], [0.22, 0], [0.18, 0.18], [0.08, 0.32], [0.34, 0.38], [0.38, 0.48],
    [0.3, 0.58], [0.1, 0.72], [0.04, 0.84], [-0.02, 0.9], [-0.08, 0.76],
    [-0.2, 0.66], [-0.26, 0.4], [-0.24, 0.15],
  ];
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.2,
    bevelEnabled: true,
    bevelThickness: 0.04,
    bevelSize: 0.03,
    bevelSegments: 3,
  });
  geo.translate(0, 0, -0.1); // centre it so it sits in the middle of the base
  return geo;
}

// Creates one piece. `type` is a chess.js letter (p n b r q k),
// `color` is 'w' or 'b'.
export function createPiece(type, color) {
  const group = new THREE.Group();

  for (const [geo, pos, rot, isDetail] of builders[type]()) {
    const mesh = new THREE.Mesh(geo, isDetail ? detailMaterial : pieceMaterials[color]);
    mesh.position.set(...pos);
    if (rot) mesh.rotation.set(...rot);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // Glowing rune ring around the base: blue for White, violet for Black.
  const ring = new THREE.Mesh(
    cached('rune', () => new THREE.TorusGeometry(0.36, 0.015, 8, 48).rotateX(Math.PI / 2)),
    runeMaterials[color]
  );
  ring.position.y = 0.1;
  group.add(ring);

  // Pieces face the enemy: White looks toward -z, Black toward +z.
  // (Only the knight shows it, but this keeps every piece consistent.)
  group.rotation.y = color === 'w' ? Math.PI : 0;

  // Remember what this is, so clicks on any part can find the piece.
  group.userData = { isPiece: true, type, color };
  return group;
}
