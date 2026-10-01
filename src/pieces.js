// pieces.js
// Builds the carved stone statues out of simple Three.js shapes (boxes,
// spheres, cylinders, cones, rings...), so there are no model files to load.
//
// How a statue is made:
//  1. Every piece stands on the same thick, eight-sided carved plinth.
//  2. A "builder" for each piece type adds shapes one by one: a robe, arms,
//     a helmet, a sword... Each shape is moved and turned into place.
//  3. All the stone shapes are welded together into ONE geometry, and all
//     the dark detail shapes (eye slits, doorways) into another. Drawing one
//     big shape is much faster for the graphics card than drawing 40 small
//     ones, and we only do this welding once per piece type (it's cached).
//
// Directions, seen from the piece itself: +y is up, +z is the way the
// statue faces, and its right hand is on the -x side.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { pieceMaterials, runeMaterials, detailMaterial } from './materials.js';

const P = 0.32; // height of the top of the plinth: figures stand here

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

// Moves, turns and stretches a shape. `rot` is [x, y, z] in radians, applied
// in that order: first around x, then y, then z.
function place(geo, at = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1]) {
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...at),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot, 'ZYX')),
    new THREE.Vector3(...scale)
  );
  return geo.applyMatrix4(matrix);
}

// "Lathe": draw half an outline as [radius, height] points from bottom to
// top, and Three.js spins it around the vertical axis like clay on a
// potter's wheel. Great for robes, towers and torsos.
const lathe = (points, segments = 32) =>
  new THREE.LatheGeometry(points.map(([r, h]) => new THREE.Vector2(r, h)), segments);

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const ball = (r, w = 20, h = 14) => new THREE.SphereGeometry(r, w, h);
const halfBall = (r) => new THREE.SphereGeometry(r, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2);
const cone = (r, h, sides = 8) => new THREE.ConeGeometry(r, h, sides);
const cyl = (rTop, rBottom, h, sides = 20) => new THREE.CylinderGeometry(rTop, rBottom, h, sides);
// A ring lying flat (like a belt). TorusGeometry stands upright by default.
const flatRing = (r, tube) => new THREE.TorusGeometry(r, tube, 8, 40).rotateX(Math.PI / 2);
// The back half of a cone: used for cloaks and veils that hang behind a figure.
const backHalf = (rTop, rBottom, h) =>
  new THREE.CylinderGeometry(rTop, rBottom, h, 24, 1, false, Math.PI / 2, Math.PI);

// A rounded limb (arm, leg, spear shaft...) running from point a to point b.
// With two radii it becomes a tapered tube, like a wide sleeve.
function limb(a, b, r1, r2 = r1) {
  const start = new THREE.Vector3(...a);
  const end = new THREE.Vector3(...b);
  const dir = end.clone().sub(start);
  const length = dir.length();
  const geo = r1 === r2 ? new THREE.CapsuleGeometry(r1, length, 4, 12) : new THREE.CylinderGeometry(r2, r1, length, 14);
  // Shapes are made pointing up (+y); turn this one to point from a to b.
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  const mid = start.add(end).multiplyScalar(0.5);
  return geo.translate(mid.x, mid.y, mid.z);
}

// Carved vertical folds in a robe: thin ridges running down its surface,
// from radius r0 at height y0 to radius r1 at height y1.
function folds(count, y0, r0, y1, r1, thickness = 0.025) {
  const ridges = [];
  for (let i = 0; i < count; i++) {
    const a = ((i + 0.5) / count) * Math.PI * 2;
    const at = (r, y) => [Math.sin(a) * (r - thickness * 0.4), y, Math.cos(a) * (r - thickness * 0.4)];
    ridges.push(limb(at(r0, y0), at(r1, y1), thickness, thickness * 0.5));
  }
  return ridges;
}

// A crown: a band with a ring of spikes, each topped with a small orb.
function crown(y, r, spikes, spikeHeight) {
  const parts = [cyl(r, r * 0.92, 0.09, 24).translate(0, y, 0), flatRing(r, 0.018).translate(0, y - 0.04, 0)];
  for (let i = 0; i < spikes; i++) {
    const a = (i / spikes) * Math.PI * 2;
    const h = i % 2 ? spikeHeight * 0.7 : spikeHeight; // tall and short spikes alternate
    const x = Math.sin(a) * r * 0.95;
    const z = Math.cos(a) * r * 0.95;
    parts.push(cone(0.03, h, 6).translate(x, y + 0.045 + h / 2, z));
    parts.push(ball(0.024, 10, 8).translate(x, y + 0.05 + h, z));
  }
  return parts;
}

// Gives a shape sharp, chiselled edges instead of smooth shading.
function chiselled(geo) {
  const flat = geo.index ? geo.toNonIndexed() : geo;
  flat.computeVertexNormals();
  return flat;
}

// ---------------------------------------------------------------------------
// The plinth: a thick eight-sided base with a groove for the rune ring
// ---------------------------------------------------------------------------
function plinth() {
  const profile = [
    [0, 0], [0.43, 0], [0.43, 0.09], // heavy foot
    [0.4, 0.11], [0.35, 0.12], [0.35, 0.2], [0.4, 0.21], // groove the rune ring sits in
    [0.4, 0.27], [0.36, 0.29], [0.34, 0.31], [0.32, P], [0, P], // bevelled top
  ];
  // 8 segments makes it octagonal; phiStart turns a flat side to the front.
  const geo = new THREE.LatheGeometry(profile.map(([r, h]) => new THREE.Vector2(r, h)), 8, Math.PI / 8);
  return chiselled(geo);
}

// ---------------------------------------------------------------------------
// The six statues. Each builder returns { stone: [...shapes], detail: [...shapes] }.
// ---------------------------------------------------------------------------
const builders = {
  // Pawn: a helmeted foot soldier with a round shield and a short spear.
  p() {
    const stone = [];
    const detail = [];
    for (const s of [-1, 1]) {
      stone.push(limb([0.09 * s, P + 0.05, 0], [0.09 * s, P + 0.42, 0], 0.075)); // legs
      stone.push(place(box(0.12, 0.08, 0.2), [0.09 * s, P + 0.04, 0.03])); // boots
      stone.push(place(ball(0.085), [0.19 * s, P + 0.92, 0], [0, 0, 0], [1, 0.8, 1])); // shoulder guards
    }
    stone.push(
      lathe([[0.22, P + 0.28], [0.2, P + 0.4], [0.16, P + 0.62], [0, P + 0.62]]), // tunic skirt
      lathe([[0.15, P + 0.58], [0.18, P + 0.78], [0.19, P + 0.9], [0.15, P + 0.98], [0.07, P + 1.0], [0, P + 1.0]]), // body
      flatRing(0.165, 0.025).translate(0, P + 0.6, 0), // belt
      cyl(0.06, 0.06, 0.1).translate(0, P + 1.02, 0), // neck
      // Helmet: a dome with a rim, a nose guard and a crest along the top.
      ball(0.14).translate(0, P + 1.12, 0),
      flatRing(0.14, 0.025).translate(0, P + 1.07, 0),
      box(0.035, 0.14, 0.04).translate(0, P + 1.08, 0.14),
      box(0.04, 0.08, 0.26).translate(0, P + 1.27, 0)
    );
    for (const s of [-1, 1]) {
      detail.push(place(box(0.07, 0.025, 0.05), [0.05 * s, P + 1.12, 0.125], [0, 0.35 * s, 0])); // eye slits
    }

    // Right arm holds the spear upright.
    stone.push(
      limb([-0.19, P + 0.9, 0], [-0.24, P + 0.7, 0.06], 0.055),
      limb([-0.24, P + 0.7, 0.06], [-0.24, P + 0.62, 0.17], 0.05),
      ball(0.05).translate(-0.24, P + 0.62, 0.19),
      cyl(0.022, 0.022, 1.45, 10).translate(-0.24, P + 0.745, 0.19), // shaft
      flatRing(0.03, 0.012).translate(-0.24, P + 1.46, 0.19), // collar
      cone(0.05, 0.2, 6).translate(-0.24, P + 1.57, 0.19) // spearhead
    );

    // Left arm holds the round shield, angled out to the front-left.
    const shieldTurn = 0.4;
    const shieldAt = [0.2, P + 0.62, 0.16];
    const facing = [Math.sin(shieldTurn), 0, Math.cos(shieldTurn)];
    const inFront = (d) => shieldAt.map((v, i) => v + facing[i] * d);
    stone.push(
      limb([0.19, P + 0.9, 0], [0.24, P + 0.7, 0.08], 0.055),
      place(cyl(0.24, 0.24, 0.05, 28), shieldAt, [Math.PI / 2, shieldTurn, 0]),
      place(new THREE.TorusGeometry(0.24, 0.025, 8, 36), shieldAt, [0, shieldTurn, 0]), // rim
      place(new THREE.TorusGeometry(0.14, 0.012, 6, 32), inFront(0.025), [0, shieldTurn, 0]), // carved ring
      ball(0.06).translate(...inFront(0.03)) // boss in the middle
    );
    return { stone, detail };
  },

  // Rook: a squat stone fortress tower with an arched door and battlements.
  r() {
    const stone = [];
    const detail = [];
    // Tower outline: flared foot, slightly tapering walls, an overhanging
    // parapet, and a sunken roof inside the battlements.
    stone.push(
      lathe([
        [0.37, P], [0.34, P + 0.08], [0.32, P + 1.18], [0.37, P + 1.26],
        [0.385, P + 1.38], [0.3, P + 1.38], [0.3, P + 1.3], [0, P + 1.3],
      ])
    );
    // Raised bands of masonry around the walls.
    for (const y of [0.45, 0.85]) {
      const r = 0.34 - (0.02 * (y - 0.08)) / 1.1;
      stone.push(flatRing(r, 0.014).translate(0, P + y, 0));
    }
    // Eight battlements (merlons) around the top.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      stone.push(place(box(0.15, 0.2, 0.1), [Math.sin(a) * 0.335, P + 1.48, Math.cos(a) * 0.335], [0, a, 0]));
    }
    // Arched doorway: a dark arch shape, framed by stone pillars and an arch.
    const door = new THREE.Shape();
    door.moveTo(-0.09, 0);
    door.lineTo(0.09, 0);
    door.lineTo(0.09, 0.22);
    door.absarc(0, 0.22, 0.09, 0, Math.PI, false);
    door.lineTo(-0.09, 0);
    detail.push(new THREE.ExtrudeGeometry(door, { depth: 0.06, bevelEnabled: false }).translate(0, P, 0.29));
    stone.push(
      place(new THREE.TorusGeometry(0.115, 0.025, 8, 20, Math.PI), [0, P + 0.22, 0.335]),
      box(0.05, 0.22, 0.05).translate(-0.115, P + 0.11, 0.33),
      box(0.05, 0.22, 0.05).translate(0.115, P + 0.11, 0.33)
    );
    // Arrow slits: one above the door, and one on each other side.
    for (const [a, y] of [[0, 0.78], [Math.PI / 2, 0.85], [Math.PI, 0.85], [-Math.PI / 2, 0.85]]) {
      detail.push(place(box(0.045, 0.16, 0.06), [Math.sin(a) * 0.315, P + y, Math.cos(a) * 0.315], [0, a, 0]));
    }
    return { stone, detail };
  },

  // Knight: a large armoured horse head and neck with a carved mane.
  n() {
    // Built "side-on": x is forward (toward the muzzle), y is up, z is
    // across the horse's width. At the end everything is turned to face +z.
    const stone = [];
    const detail = [];
    const extrude = (points, depth, bevel) => {
      const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
      const geo = new THREE.ExtrudeGeometry(shape, {
        depth,
        bevelEnabled: true,
        bevelThickness: bevel,
        bevelSize: bevel * 0.8,
        bevelSegments: 2,
        curveSegments: 4,
      });
      return geo.translate(0, 0, -depth / 2); // centre it across the width
    };

    // Side outline of the head and neck, going around clockwise from the back of the base.
    const headAndNeck = [
      [-0.38, 0], [0.22, 0], [0.18, 0.2], [0.1, 0.45], [0.06, 0.7], // chest and throat
      [0.12, 0.82], [0.3, 0.86], [0.44, 0.9], [0.48, 1.0], [0.44, 1.1], // jaw and muzzle
      [0.22, 1.28], [0.1, 1.45], [0.02, 1.58], [-0.13, 1.56], // face and top of the head
      [-0.24, 1.42], [-0.32, 1.15], [-0.38, 0.85], [-0.42, 0.5], [-0.42, 0.2], // back of the neck
    ];
    stone.push(extrude(headAndNeck, 0.3, 0.05));

    // Armour plate over the face, slightly wider than the head so it stands out.
    const facePlate = [
      [0.0, 1.5], [0.12, 1.47], [0.24, 1.3], [0.46, 1.1], [0.47, 1.02],
      [0.36, 1.0], [0.18, 1.12], [0.04, 1.3], [-0.04, 1.44],
    ];
    stone.push(extrude(facePlate, 0.36, 0.03));
    detail.push(place(box(0.1, 0.035, 0.44), [0.13, 1.37, 0], [0, 0, -0.5])); // eye holes in the plate
    detail.push(place(box(0.14, 0.02, 0.42), [0.38, 0.94, 0], [0, 0, 0.25])); // mouth line

    // Ears, tilted back.
    for (const s of [-1, 1]) stone.push(place(cone(0.055, 0.2), [-0.03, 1.64, 0.1 * s], [0.15 * s, 0, 0.35]));

    // Mane: two staggered rows of carved locks flowing down the back of the neck.
    const mane = [
      [-0.14, 1.53], [-0.22, 1.42], [-0.27, 1.28], [-0.31, 1.14],
      [-0.35, 0.98], [-0.38, 0.83], [-0.41, 0.66],
    ];
    mane.forEach(([x, y], i) => {
      stone.push(place(cone(0.075, 0.24, 5), [x, y, i % 2 ? 0.06 : -0.06], [0, 0, Math.PI / 3]));
    });

    // Armoured collar bands around the neck.
    stone.push(place(box(0.6, 0.07, 0.44), [-0.15, 0.36, 0]));
    stone.push(place(box(0.56, 0.07, 0.44), [-0.17, 0.6, 0], [0, 0, 0.08]));

    // Stretch it a little taller, lift it onto the plinth and turn it to face forward.
    for (const geo of [...stone, ...detail]) geo.scale(1, 1.12, 1).translate(0, P, 0).rotateY(-Math.PI / 2);
    return { stone, detail };
  },

  // Bishop: a tall hooded robed figure holding a staff.
  b() {
    const stone = [
      // Long robe, widening toward the floor, with carved folds.
      lathe([
        [0.31, P], [0.29, P + 0.08], [0.24, P + 0.5], [0.2, P + 1.0],
        [0.19, P + 1.22], [0.22, P + 1.38], [0.15, P + 1.52], [0, P + 1.54],
      ]),
      ...folds(10, P + 0.06, 0.29, P + 1.0, 0.2),
      flatRing(0.2, 0.025).translate(0, P + 1.0, 0), // rope belt
      limb([0.05, P + 0.98, 0.19], [0.07, P + 0.62, 0.23], 0.018), // hanging rope end
      place(halfBall(0.25), [0, P + 1.3, 0], [0, 0, 0], [1, 0.7, 0.95]), // short cape over the shoulders
      // Tall pointed hood.
      lathe([[0.17, P + 1.42], [0.19, P + 1.6], [0.17, P + 1.78], [0.11, P + 1.94], [0.04, P + 2.04], [0, P + 2.06]]),
      place(new THREE.TorusGeometry(0.1, 0.03, 8, 24), [0, P + 1.66, 0.175], [0, 0, 0], [1, 1.3, 1]), // hood rim
      // Wide sleeves: the right hand grips the staff, the left rests on the chest.
      limb([-0.21, P + 1.32, 0], [-0.27, P + 1.05, 0.12], 0.07, 0.1),
      ball(0.045).translate(-0.29, P + 1.0, 0.17),
      limb([0.21, P + 1.32, 0], [0.12, P + 1.08, 0.2], 0.07, 0.1),
      ball(0.045).translate(0.1, P + 1.06, 0.24),
      // Staff, topped with an orb inside a ring.
      cyl(0.026, 0.03, 2.0, 10).translate(-0.29, P + 1.02, 0.17),
      new THREE.TorusGeometry(0.07, 0.018, 8, 24).translate(-0.29, P + 2.1, 0.17),
      ball(0.05).translate(-0.29, P + 2.1, 0.17),
    ];
    // The face is hidden: just a dark hollow inside the hood.
    const detail = [place(ball(0.1), [0, P + 1.66, 0.15], [0, 0, 0], [1, 1.25, 0.6])];
    return { stone, detail };
  },

  // Queen: a tall crowned figure in a long flowing robe, holding a sceptre.
  q() {
    const stone = [
      // Gown that pools at the feet, with lots of folds.
      lathe(
        [
          [0.36, P], [0.34, P + 0.06], [0.28, P + 0.45], [0.21, P + 0.95], [0.15, P + 1.35],
          [0.17, P + 1.5], [0.2, P + 1.68], [0.12, P + 1.84], [0, P + 1.86],
        ],
        36
      ),
      ...folds(12, P + 0.04, 0.34, P + 0.95, 0.21),
      backHalf(0.21, 0.37, 1.7).translate(0, P + 0.85, -0.02), // long cloak down the back
      flatRing(0.155, 0.022).translate(0, P + 1.35, 0), // girdle
      ball(0.085).translate(-0.19, P + 1.66, 0), // shoulders
      ball(0.085).translate(0.19, P + 1.66, 0),
      flatRing(0.13, 0.03).translate(0, P + 1.83, 0), // collar
      cyl(0.05, 0.06, 0.1).translate(0, P + 1.9, 0), // neck
      // Head covered by a veil that drapes down the back.
      place(ball(0.14, 24, 16), [0, P + 2.02, 0], [0, 0, 0], [1, 1.1, 1]),
      backHalf(0.14, 0.22, 0.55).translate(0, P + 1.8, -0.01),
      place(new THREE.TorusGeometry(0.085, 0.022, 8, 24), [0, P + 2.0, 0.135], [0, 0, 0], [1, 1.2, 1]), // veil opening
      ...crown(P + 2.15, 0.12, 7, 0.11),
      ball(0.04).translate(0, P + 2.25, 0),
      new THREE.OctahedronGeometry(0.05).translate(0, P + 2.32, 0), // gem on top
      // Right arm holds the sceptre; the left hand rests at the waist.
      limb([-0.2, P + 1.64, 0], [-0.27, P + 1.38, 0.06], 0.055),
      limb([-0.27, P + 1.38, 0.06], [-0.24, P + 1.28, 0.2], 0.06, 0.09), // flared sleeve
      ball(0.04).translate(-0.23, P + 1.26, 0.23),
      cyl(0.018, 0.022, 0.85, 10).translate(-0.23, P + 1.425, 0.23),
      flatRing(0.035, 0.012).translate(-0.23, P + 1.86, 0.23),
      new THREE.OctahedronGeometry(0.065).translate(-0.23, P + 1.95, 0.23),
      limb([0.2, P + 1.64, 0], [0.25, P + 1.4, 0.08], 0.055),
      limb([0.25, P + 1.4, 0.08], [0.12, P + 1.3, 0.2], 0.06, 0.09),
      ball(0.04).translate(0.1, P + 1.29, 0.21),
    ];
    const detail = [place(ball(0.085), [0, P + 2.0, 0.11], [0, 0, 0], [1, 1.2, 0.6])]; // shadowed face
    return { stone, detail };
  },

  // King: the largest piece. A crowned figure in armour and a cloak,
  // resting both hands on a sword planted point-down in front of him.
  k() {
    const stone = [];
    const detail = [];
    for (const s of [-1, 1]) {
      stone.push(
        limb([0.11 * s, P + 0.05, 0], [0.11 * s, P + 0.85, 0], 0.085), // armoured legs
        box(0.14, 0.1, 0.24).translate(0.11 * s, P + 0.05, 0.04), // armoured boots
        ball(0.06).translate(0.11 * s, P + 0.5, 0.07), // knee guards
        place(ball(0.13, 20, 12), [0.27 * s, P + 1.82, 0], [0, 0, 0], [1, 0.8, 1]), // big shoulder plates
        // Arms bend forward so both gauntlets meet on the sword's grip.
        limb([0.27 * s, P + 1.74, 0], [0.31 * s, P + 1.45, 0.12], 0.07),
        limb([0.31 * s, P + 1.45, 0.12], [0.055 * s, P + 1.26, 0.28], 0.062),
        ball(0.06).translate(0.05 * s, P + 1.26, 0.29)
      );
      detail.push(place(box(0.08, 0.028, 0.05), [0.045 * s, P + 2.12, 0.12], [0, 0.33 * s, 0])); // visor slits
    }
    stone.push(
      // Armoured skirt with two plate edges.
      lathe([[0.26, P + 0.65], [0.25, P + 0.8], [0.22, P + 1.2], [0, P + 1.2]]),
      flatRing(0.25, 0.015).translate(0, P + 0.8, 0),
      flatRing(0.24, 0.015).translate(0, P + 0.95, 0),
      backHalf(0.27, 0.42, 1.85).translate(0, P + 0.945, -0.03), // royal cloak
      // Breastplate with a ridge down the middle, a belt and a buckle.
      lathe([[0.21, P + 1.15], [0.25, P + 1.45], [0.26, P + 1.65], [0.23, P + 1.84], [0.12, P + 1.92], [0, P + 1.92]]),
      box(0.03, 0.45, 0.03).translate(0, P + 1.5, 0.245),
      flatRing(0.22, 0.03).translate(0, P + 1.18, 0),
      box(0.08, 0.07, 0.04).translate(0, P + 1.18, 0.23),
      flatRing(0.15, 0.045).translate(0, P + 1.92, 0), // fur collar of the cloak
      // Great helm (a closed helmet) with a ridge down the face.
      cyl(0.13, 0.14, 0.26, 24).translate(0, P + 2.08, 0),
      halfBall(0.13).translate(0, P + 2.21, 0),
      box(0.025, 0.24, 0.03).translate(0, P + 2.08, 0.135),
      ...crown(P + 2.25, 0.145, 8, 0.14),
      // A small orb and cross on top.
      ball(0.05).translate(0, P + 2.38, 0),
      box(0.04, 0.2, 0.04).translate(0, P + 2.5, 0),
      box(0.14, 0.04, 0.04).translate(0, P + 2.53, 0),
      // The sword: a flat diamond-shaped blade, crossguard, grip and pommel.
      chiselled(place(cyl(0.05, 0.012, 1.05, 4), [0, P + 0.545, 0.29], [0, 0, 0], [1, 1, 0.3])),
      box(0.34, 0.045, 0.06).translate(0, P + 1.09, 0.29),
      cyl(0.025, 0.025, 0.2, 10).translate(0, P + 1.21, 0.29),
      ball(0.045).translate(0, P + 1.34, 0.29)
    );
    return { stone, detail };
  },
};

// ---------------------------------------------------------------------------
// Welding shapes together (done once per piece type, then reused)
// ---------------------------------------------------------------------------

// Shapes can only be welded if they're stored the same way, so convert each
// one to the simple "list of triangles" form and keep only the parts every
// shape has: position, normal (lighting direction) and uv (texture mapping).
function weld(shapes) {
  if (!shapes.length) return null;
  return mergeGeometries(
    shapes.map((geo) => {
      const g = geo.index ? geo.toNonIndexed() : geo;
      const clean = new THREE.BufferGeometry();
      for (const name of ['position', 'normal', 'uv']) clean.setAttribute(name, g.getAttribute(name));
      return clean;
    })
  );
}

const cache = {};
function pieceGeometry(type) {
  if (!cache[type]) {
    const { stone, detail } = builders[type]();
    cache[type] = { stone: weld([plinth(), ...stone]), detail: weld(detail) };
  }
  return cache[type];
}

const runeRing = new THREE.TorusGeometry(0.375, 0.02, 8, 48).rotateX(Math.PI / 2).translate(0, 0.16, 0);

// Creates one piece. `type` is a chess.js letter (p n b r q k),
// `color` is 'w' or 'b'.
export function createPiece(type, color) {
  const group = new THREE.Group();
  const { stone, detail } = pieceGeometry(type);

  // The stone body must be the first child: smash.js copies its material.
  const body = new THREE.Mesh(stone, pieceMaterials[color]);
  body.castShadow = body.receiveShadow = true;
  group.add(body);

  if (detail) group.add(new THREE.Mesh(detail, detailMaterial));

  // Glowing rune ring sitting in the plinth's groove: blue for Ivory, violet for Obsidian.
  group.add(new THREE.Mesh(runeRing, runeMaterials[color]));

  // Statues face the enemy: White looks toward -z, Black toward +z.
  group.rotation.y = color === 'w' ? Math.PI : 0;

  // Remember what this is, so clicks on any part can find the piece.
  group.userData = { isPiece: true, type, color };
  return group;
}
