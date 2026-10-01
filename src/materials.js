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

// One shared material per side. Sharing saves memory: all 16 white
// pieces use the same material object.
const stoneTextureLight = makeStoneTexture('#e4dccb');
const stoneTextureDark = makeStoneTexture('#3b3844');

export const pieceMaterials = {
  w: new THREE.MeshStandardMaterial({ map: stoneTextureLight, roughness: 0.85 }),
  b: new THREE.MeshStandardMaterial({ map: stoneTextureDark, roughness: 0.75 }),
};

// Glowing rune ring colours at the base of each piece.
export const runeMaterials = {
  w: new THREE.MeshBasicMaterial({ color: 0x9fd8ff }),
  b: new THREE.MeshBasicMaterial({ color: 0xc46bff }),
};

// Dark material for small details like the bishop's notch.
export const detailMaterial = new THREE.MeshStandardMaterial({ color: 0x15121a, roughness: 1 });
