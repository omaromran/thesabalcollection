const MODEL_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21";
const WASM_BASE = `${MODEL_BASE}/wasm`;
const SEGMENT_MODEL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";
const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.tflite";

const assetCache = new Map();
let segmenterPromise;
let facePromise;

function loadImage(src) {
  if (assetCache.has(src)) return assetCache.get(src);
  const promise = new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${src}`));
    image.src = src;
  });
  assetCache.set(src, promise);
  return promise;
}

async function loadVision() {
  const mod = await import(`${MODEL_BASE}/vision_bundle.mjs`);
  return mod.FilesetResolver.forVisionTasks(WASM_BASE);
}

async function createVisionTask(createFromOptions, fileset, options) {
  try {
    return await createFromOptions(fileset, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: "GPU" },
    });
  } catch {
    return createFromOptions(fileset, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: "CPU" },
    });
  }
}

function getSegmenter() {
  if (!segmenterPromise) {
    segmenterPromise = loadVision().then(async (fileset) => {
      const mod = await import(`${MODEL_BASE}/vision_bundle.mjs`);
      return createVisionTask(mod.ImageSegmenter.createFromOptions.bind(mod.ImageSegmenter), fileset, {
        baseOptions: { modelAssetPath: SEGMENT_MODEL },
        runningMode: "IMAGE",
        outputCategoryMask: true,
      });
    });
  }
  return segmenterPromise;
}

function getFaceLandmarker() {
  if (!facePromise) {
    facePromise = loadVision().then(async (fileset) => {
      const mod = await import(`${MODEL_BASE}/vision_bundle.mjs`);
      return createVisionTask(mod.FaceLandmarker.createFromOptions.bind(mod.FaceLandmarker), fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL },
        runningMode: "IMAGE",
        numFaces: 2,
      });
    });
  }
  return facePromise;
}

export async function preloadComposer() {
  await Promise.allSettled([
    getSegmenter(),
    getFaceLandmarker(),
    loadImage("assets/candle.png"),
    loadImage("assets/logo-gold.png"),
    loadImage("assets/props/beanie.png"),
    loadImage("assets/props/scarf.png"),
    loadImage("assets/props/sunglasses.png"),
    loadImage("assets/props/sunhat.png"),
    loadImage("assets/props/autumn-scarf.png"),
  ]);
}

function maskBounds(maskBytes, width, height) {
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let count = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (maskBytes[y * width + x] > 20) {
        count += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (count < 80) return null;
  return { minX, minY, maxX, maxY, count };
}

function blurMask(src, width, height, radius = 3) {
  const out = new Uint8ClampedArray(src.length);
  const area = (radius * 2 + 1) ** 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const yy = Math.min(height - 1, Math.max(0, y + dy));
        for (let dx = -radius; dx <= radius; dx += 1) {
          const xx = Math.min(width - 1, Math.max(0, x + dx));
          sum += src[yy * width + xx];
        }
      }
      out[y * width + x] = sum / area;
    }
  }
  return out;
}

function cutoutFromMask(image, maskBytes, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const soft = blurMask(maskBytes, width, height, 2);
  for (let y = 0; y < canvas.height; y += 1) {
    const my = Math.min(height - 1, Math.floor((y * height) / canvas.height));
    for (let x = 0; x < canvas.width; x += 1) {
      const mx = Math.min(width - 1, Math.floor((x * width) / canvas.width));
      const i = (y * canvas.width + x) * 4;
      let alpha = soft[my * width + mx];
      const lum = 0.3 * pixels.data[i] + 0.59 * pixels.data[i + 1] + 0.11 * pixels.data[i + 2];
      if (alpha < 250 && lum > 205) alpha *= 0.12;
      else if (alpha < 220 && lum > 175) alpha *= 0.45;
      pixels.data[i + 3] = Math.min(pixels.data[i + 3], alpha);
    }
  }
  ctx.putImageData(pixels, 0, 0);
  const rawBounds = maskBounds(soft, width, height);
  if (!rawBounds) return { canvas, bounds: null };
  const sx = canvas.width / width;
  const sy = canvas.height / height;
  return {
    canvas,
    bounds: {
      minX: Math.max(0, rawBounds.minX * sx - 8),
      minY: Math.max(0, rawBounds.minY * sy - 8),
      maxX: Math.min(canvas.width, rawBounds.maxX * sx + 8),
      maxY: Math.min(canvas.height, rawBounds.maxY * sy + 8),
      count: rawBounds.count,
    },
  };
}

function ovalCutout(image) {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, width, height);
  const cx = width * 0.5;
  const cy = height * 0.52;
  const rx = width * 0.38;
  const ry = height * 0.46;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      const d = nx * nx + ny * ny;
      const i = (y * width + x) * 4;
      const alpha = d > 1.08 ? 0 : d > 0.82 ? Math.round(255 * (1.08 - d) / 0.26) : 255;
      pixels.data[i + 3] = Math.min(pixels.data[i + 3], alpha);
    }
  }
  ctx.putImageData(pixels, 0, 0);
  return {
    canvas,
    bounds: { minX: cx - rx, minY: cy - ry, maxX: cx + rx, maxY: cy + ry, count: 1000 },
  };
}

async function segmentSubject(image) {
  try {
    const segmenter = await getSegmenter();
    const result = segmenter.segment(image);
    const mask = result.categoryMask;
    if (!mask) throw new Error("No mask");
    const width = mask.width;
    const height = mask.height;
    const raw = mask.getAsUint8Array ? mask.getAsUint8Array() : new Uint8Array(mask.getAsFloat32Array().map((v) => (v > 0.4 ? 255 : 0)));
    // Selfie segmenter: person is typically 0 or 1 depending on model. Keep the non-majority class.
    const hist = [0, 0];
    for (let i = 0; i < raw.length; i += 8) {
      hist[raw[i] > 0 ? 1 : 0] += 1;
    }
    const personIsZero = hist[0] < hist[1];
    const bytes = new Uint8ClampedArray(raw.length);
    for (let i = 0; i < raw.length; i += 1) {
      const isPerson = personIsZero ? raw[i] === 0 : raw[i] > 0;
      bytes[i] = isPerson ? 255 : 0;
    }
    const cut = cutoutFromMask(image, bytes, width, height);
    if (!cut.bounds) throw new Error("Empty mask");
    return cut;
  } catch {
    return ovalCutout(image);
  }
}

async function detectFaces(image) {
  try {
    const landmarker = await getFaceLandmarker();
    const result = landmarker.detect(image);
    return result.faceLandmarks || [];
  } catch {
    return [];
  }
}

function drawProp(ctx, image, cx, cy, width, rotation = 0) {
  const height = (image.height / image.width) * width;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);
  ctx.drawImage(image, -width / 2, -height / 2, width, height);
  ctx.restore();
}

function toDestPoint(point, layout) {
  if (!point) return null;
  return {
    x: layout.destX + (point.x * layout.photoW - layout.bounds.minX) * layout.scale,
    y: layout.destY + (point.y * layout.photoH - layout.bounds.minY) * layout.scale,
  };
}

async function drawClothing(ctx, theme, faces, layout) {
  if (!theme.props?.length || !faces.length) return;
  const face = faces[0];
  const forehead = toDestPoint(face[10], layout);
  const chin = toDestPoint(face[152], layout);
  const leftEye = toDestPoint(face[33], layout);
  const rightEye = toDestPoint(face[263], layout);
  const leftCheek = toDestPoint(face[234], layout);
  const rightCheek = toDestPoint(face[454], layout);
  if (!forehead || !chin) return;

  const faceWidth = leftCheek && rightCheek
    ? Math.hypot(rightCheek.x - leftCheek.x, rightCheek.y - leftCheek.y)
    : layout.destW * 0.28;
  const eyeCenter = leftEye && rightEye
    ? { x: (leftEye.x + rightEye.x) / 2, y: (leftEye.y + rightEye.y) / 2 }
    : { x: forehead.x, y: forehead.y + faceWidth * 0.35 };

  if (theme.props.includes("sunhat")) {
    const hat = await loadImage("assets/props/sunhat.png");
    drawProp(ctx, hat, forehead.x, forehead.y - faceWidth * 0.55, faceWidth * 2.15);
  }
  if (theme.props.includes("beanie")) {
    const beanie = await loadImage("assets/props/beanie.png");
    drawProp(ctx, beanie, forehead.x, forehead.y - faceWidth * 0.42, faceWidth * 1.7);
  }
  if (theme.props.includes("sunglasses")) {
    const glasses = await loadImage("assets/props/sunglasses.png");
    drawProp(ctx, glasses, eyeCenter.x, eyeCenter.y, faceWidth * 1.35);
  }
  if (theme.props.includes("scarf")) {
    const scarf = await loadImage("assets/props/scarf.png");
    drawProp(ctx, scarf, chin.x, chin.y + faceWidth * 0.28, faceWidth * 2.1);
  }
  if (theme.props.includes("autumn-scarf")) {
    const scarf = await loadImage("assets/props/autumn-scarf.png");
    drawProp(ctx, scarf, chin.x, chin.y + faceWidth * 0.3, faceWidth * 2.15);
  }
}

function drawVignette(ctx, width, height) {
  const gradient = ctx.createRadialGradient(
    width * 0.5,
    height * 0.45,
    width * 0.2,
    width * 0.5,
    height * 0.5,
    width * 0.72,
  );
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(1, "rgba(8,6,4,0.55)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function drawGrade(ctx, theme, width, height) {
  const [r, g, b] = theme.grade.tint;
  ctx.save();
  ctx.globalCompositeOperation = "soft-light";
  ctx.fillStyle = `rgba(${r},${g},${b},${theme.grade.warm})`;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = `rgba(18,12,8,${theme.grade.dark})`;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

function drawParticles(ctx, kind, width, height) {
  ctx.save();
  if (kind === "snow") {
    ctx.fillStyle = "rgba(255,255,255,0.78)";
    for (let i = 0; i < 70; i += 1) {
      const x = ((i * 97) % width);
      const y = ((i * 53) % height);
      const r = 1 + (i % 4);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (kind === "leaves") {
    const colors = ["#c46a2a", "#d4a017", "#8b3a1a", "#e07a2f"];
    for (let i = 0; i < 28; i += 1) {
      ctx.fillStyle = colors[i % colors.length];
      ctx.save();
      ctx.translate((i * 137) % width, (i * 79) % height);
      ctx.rotate((i * 0.7) % Math.PI);
      ctx.beginPath();
      ctx.ellipse(0, 0, 10, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  } else if (kind === "sparkle") {
    ctx.fillStyle = "rgba(232, 208, 122, 0.85)";
    for (let i = 0; i < 36; i += 1) {
      const x = (i * 149) % width;
      const y = (i * 83) % height;
      ctx.globalAlpha = 0.35 + (i % 5) * 0.1;
      ctx.beginPath();
      ctx.arc(x, y, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawBrandFrame(ctx, width, height, theme, logo) {
  ctx.fillStyle = "rgba(8,7,6,0.55)";
  ctx.fillRect(0, height - 92, width, 92);
  ctx.drawImage(logo, 36, height - 82, 220, 72);
  ctx.fillStyle = "#f3ead7";
  ctx.font = "500 22px 'Quattrocento Sans', sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("FESTIVAL PORTRAIT", width - 40, height - 48);
  ctx.fillStyle = "#c5b519";
  ctx.font = "600 18px 'Tenor Sans', sans-serif";
  ctx.fillText(theme.scent.toUpperCase(), width - 40, height - 22);
}

export async function composePortrait(photo, theme) {
  const width = 1920;
  const height = 1080;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  const [background, candle, logo] = await Promise.all([
    loadImage(theme.background),
    loadImage("assets/candle.png"),
    loadImage("assets/logo-gold.png"),
  ]);

  ctx.drawImage(background, 0, 0, width, height);

  const { canvas: subjectCanvas, bounds } = await segmentSubject(photo);
  const faces = await detectFaces(photo);

  const srcW = bounds.maxX - bounds.minX;
  const srcH = bounds.maxY - bounds.minY;
  const targetH = height * theme.subject.scale;
  const scale = targetH / Math.max(srcH, 1);
  const destW = srcW * scale;
  const destH = srcH * scale;
  const destX = (width - destW) / 2;
  const destY = height * theme.subject.y + (height - destH) * 0.12;

  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.beginPath();
  ctx.ellipse(destX + destW * 0.5, destY + destH * 0.93, destW * 0.28, 18, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 22;
  ctx.drawImage(
    subjectCanvas,
    bounds.minX,
    bounds.minY,
    srcW,
    srcH,
    destX,
    destY,
    destW,
    destH,
  );
  ctx.restore();

  await drawClothing(ctx, theme, faces, {
    destX,
    destY,
    destW,
    destH,
    scale,
    bounds,
    photoW: photo.naturalWidth || photo.width,
    photoH: photo.naturalHeight || photo.height,
  });

  const candleH = height * theme.candle.scale;
  const candleW = (candle.width / candle.height) * candleH;
  ctx.save();
  ctx.shadowColor = "rgba(255, 170, 60, 0.45)";
  ctx.shadowBlur = 28;
  ctx.drawImage(
    candle,
    width * theme.candle.x - candleW / 2,
    height * theme.candle.y - candleH / 2,
    candleW,
    candleH,
  );
  ctx.restore();

  drawGrade(ctx, theme, width, height);
  drawParticles(ctx, theme.particles, width, height);
  drawVignette(ctx, width, height);
  drawBrandFrame(ctx, width, height, theme, logo);

  return await new Promise((resolve) => {
    canvas.toBlob((blob) => resolve({ canvas, blob }), "image/jpeg", 0.9);
  });
}
