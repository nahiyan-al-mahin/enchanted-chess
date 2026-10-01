// board.js
// Builds the 8x8 stone board and converts between chess squares ("e4")
// and 3D positions.
//
// Coordinate system (looking down from the camera):
//   x axis = files a..h, left to right
//   z axis = ranks, rank 1 nearest the camera (White's side), rank 8 far away
//   y axis = up. The top of the board is y = 0.

import * as THREE from 'three';
import { makeStoneTexture } from './materials.js';

const FILES = 'abcdefgh';

// "e4" -> { x, z } at the centre of that square.
export function squareToPosition(square) {
  const file = FILES.indexOf(square[0]); // 0..7
  const rank = Number(square[1]) - 1; // 0..7
  return new THREE.Vector3(file - 3.5, 0, 3.5 - rank);
}

// A point on the board -> "e4", or null if the point is off the board.
export function positionToSquare(x, z) {
  const file = Math.floor(x + 4);
  const rank = Math.floor(4 - z);
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return FILES[file] + (rank + 1);
}

// Creates the board, its frame, the floor and the a-h / 1-8 labels.
export function createBoard() {
  const group = new THREE.Group();

  const lightTex = makeStoneTexture('#cfc3a8', 512);
  const darkTex = makeStoneTexture('#4a4252', 512);
  const squareGeo = new THREE.BoxGeometry(1, 0.2, 1);

  for (let file = 0; file < 8; file++) {
    for (let rank = 0; rank < 8; rank++) {
      const isLight = (file + rank) % 2 === 1;
      // Each tile gets its own slice of the texture so no two look identical.
      const tex = (isLight ? lightTex : darkTex).clone();
      tex.repeat.set(0.25, 0.25);
      tex.offset.set(Math.random(), Math.random());
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 });

      const tile = new THREE.Mesh(squareGeo, mat);
      const pos = squareToPosition(FILES[file] + (rank + 1));
      tile.position.set(pos.x, -0.1, pos.z);
      tile.receiveShadow = true;
      group.add(tile);
    }
  }

  // Raised stone frame around the squares.
  const frameMat = new THREE.MeshStandardMaterial({
    map: makeStoneTexture('#2a2430'),
    roughness: 0.95,
  });
  const frame = new THREE.Mesh(new THREE.BoxGeometry(9.2, 0.3, 9.2), frameMat);
  frame.position.y = -0.2; // top surface sits at y = -0.05
  frame.receiveShadow = true;
  group.add(frame);

  // Dark hall floor far below.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.MeshStandardMaterial({ map: makeStoneTexture('#1b1820'), roughness: 1 })
  );
  floor.material.map.repeat.set(12, 12);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.35;
  floor.receiveShadow = true;
  group.add(floor);

  addLabels(group);
  return group;
}

// Every board label, so they can be turned to face whoever is playing.
const labels = [];

// Turns the letters and numbers to read the right way up from Ivory's side
// (side = 1) or Obsidian's side (side = -1).
export function faceLabels(side) {
  for (const label of labels) label.rotation.z = side === 1 ? 0 : Math.PI;
}

// Writes a-h along the near/far edges and 1-8 along the sides.
function addLabels(group) {
  const makeLabel = (text) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#e8c77a';
    ctx.font = 'bold 40px Georgia';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 32, 34);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.4, 0.4),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.8 })
    );
    mesh.rotation.x = -Math.PI / 2; // lie flat on the frame
    mesh.position.y = -0.045;
    labels.push(mesh);
    return mesh;
  };

  for (let i = 0; i < 8; i++) {
    for (const z of [4.3, -4.3]) {
      const l = makeLabel(FILES[i]);
      l.position.x = i - 3.5;
      l.position.z = z;
      group.add(l);
    }
    for (const x of [-4.3, 4.3]) {
      const l = makeLabel(String(i + 1));
      l.position.x = x;
      l.position.z = 3.5 - i;
      group.add(l);
    }
  }
}
