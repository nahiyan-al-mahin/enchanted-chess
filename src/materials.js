// materials.js
// Makes the "stone" look. Instead of loading image files, we paint a small
// speckled texture on an HTML canvas. That keeps the project free of
// copyrighted art and means there are no assets to download.

import * as THREE from 'three';

// Paints a grainy stone texture in the given base colour.
export function makeStoneTexture(baseColor, size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, size, size);

  // Thousands of tiny light and dark dots give the surface grain.
  for (let i = 0; i < size * size * 0.15; i++) {
    const shade = Math.random() < 0.5 ? 0 : 255;
    ctx.fillStyle = `rgba(${shade},${shade},${shade},${Math.random() * 0.08})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2);
  }

  // A few faint wandering lines look like veins in the rock.
  for (let v = 0; v < 6; v++) {
    ctx.strokeStyle = `rgba(0,0,0,${0.05 + Math.random() * 0.07})`;
    ctx.lineWidth = 1 + Math.random() * 1.5;
    ctx.beginPath();
    let x = Math.random() * size;
    let y = Math.random() * size;
    ctx.moveTo(x, y);
    for (let s = 0; s < 12; s++) {
      x += (Math.random() - 0.5) * 50;
      y += (Math.random() - 0.5) * 50;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

// Pale marble for the Ivory pieces: a creamy base, soft cloudy patches,
// and thin grey veins that wander across the stone.
function makeMarbleTexture(size = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#eee8dc';
  ctx.fillRect(0, 0, size, size);

  // Cloudy patches: big, very faint circles of warm grey.
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 30 + Math.random() * 90;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(150,140,125,${Math.random() * 0.08})`);
    g.addColorStop(1, 'rgba(150,140,125,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Veins: long wobbly lines, drawn twice (a soft blurry one, then a sharp
  // thin one on top) so they look like they sit inside the stone.
  for (let v = 0; v < 9; v++) {
    const points = [];
    let x = Math.random() * size;
    let y = Math.random() * size;
    let angle = Math.random() * Math.PI * 2;
    for (let s = 0; s < 40; s++) {
      angle += (Math.random() - 0.5) * 0.6;
      x += Math.cos(angle) * 14;
      y += Math.sin(angle) * 14;
      points.push([x, y]);
    }
    for (const [width, alpha] of [[4, 0.06], [1, 0.22]]) {
      ctx.strokeStyle = `rgba(110,105,100,${alpha})`;
      ctx.lineWidth = width;
      ctx.beginPath();
      points.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      ctx.stroke();
    }
  }

  return finishTexture(canvas);
}

// Dark granite for the Obsidian pieces: near-black stone full of tiny
// grey, white and faintly violet crystal flecks.
function makeGraniteTexture(size = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#2b2930';
  ctx.fillRect(0, 0, size, size);

  const flecks = [
    ['#151318', 0.12], // black grains
    ['#5d5866', 0.05], // grey grains
    ['#a9a3b4', 0.012], // bright crystals
    ['#6b4f86', 0.008], // violet crystals
  ];
  for (const [color, density] of flecks) {
    ctx.fillStyle = color;
    for (let i = 0; i < size * size * density * 0.25; i++) {
      const s = 1 + Math.random() * 2.5;
      ctx.globalAlpha = 0.4 + Math.random() * 0.6;
      ctx.fillRect(Math.random() * size, Math.random() * size, s, s);
    }
  }
  ctx.globalAlpha = 1;

  return finishTexture(canvas);
}

function finishTexture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4; // keeps the pattern crisp on surfaces seen at an angle
  return texture;
}

// One shared material per side. Sharing saves memory: all 16 white
// pieces use the same material object. Marble is a little shinier
// (lower roughness) than granite.
export const pieceMaterials = {
  w: new THREE.MeshStandardMaterial({ map: makeMarbleTexture(), roughness: 0.5 }),
  b: new THREE.MeshStandardMaterial({ map: makeGraniteTexture(), roughness: 0.6 }),
};

// Glowing rune ring colours at the base of each piece.
export const runeMaterials = {
  w: new THREE.MeshBasicMaterial({ color: 0x9fd8ff }),
  b: new THREE.MeshBasicMaterial({ color: 0xc46bff }),
};

// Near-black material for shadowy recesses: eye slits, hood openings, doorways.
export const detailMaterial = new THREE.MeshStandardMaterial({ color: 0x15121a, roughness: 1 });
