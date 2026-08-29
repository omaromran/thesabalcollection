import { THEMES, themeById } from "./themes.js";
import { composePortrait, preloadComposer } from "./compose.js";
import { saveLead } from "./leads.js";

const IDLE_MS = 90_000;
const THANKS_MS = 14_000;

const state = {
  screen: "attract",
  stream: null,
  facingMode: "user",
  photo: null,
  photoUrl: null,
  cutoutReady: false,
  themeId: THEMES[0].id,
  portrait: null,
  portraitUrl: null,
  busy: false,
};

const $ = (id) => document.getElementById(id);
const screens = {
  attract: $("screen-attract"),
  camera: $("screen-camera"),
  themes: $("screen-themes"),
  reveal: $("screen-reveal"),
  contact: $("screen-contact"),
  thanks: $("screen-thanks"),
};

const video = $("camera-video");
const countdownEl = $("countdown");
const revealImage = $("reveal-image");
const thanksImage = $("thanks-image");
const statusChip = $("engine-status");
const themeGrid = $("theme-grid");
const attractStage = $("attract-stage");

let idleTimer;
let thanksTimer;
let attractIndex = 0;
let attractTimer;
let wakeLock;
let logoTaps = 0;
let logoTapTimer;

function showScreen(name) {
  state.screen = name;
  for (const [key, el] of Object.entries(screens)) {
    el.classList.toggle("is-active", key === name);
  }
  document.body.dataset.screen = name;
  bumpIdle();
}

function bumpIdle() {
  clearTimeout(idleTimer);
  if (state.screen === "attract" || state.screen === "thanks") return;
  idleTimer = setTimeout(() => resetToAttract(), IDLE_MS);
}

function revoke(url) {
  if (url) URL.revokeObjectURL(url);
}

function resetSession() {
  revoke(state.photoUrl);
  revoke(state.portraitUrl);
  state.photo = null;
  state.photoUrl = null;
  state.portrait = null;
  state.portraitUrl = null;
  state.themeId = THEMES[0].id;
  $("guest-email").value = "";
  $("guest-phone").value = "";
  $("guest-name").value = "";
}

async function resetToAttract() {
  clearTimeout(thanksTimer);
  await stopCamera();
  resetSession();
  showScreen("attract");
  startAttract();
}

function startAttract() {
  const slides = [...attractStage.querySelectorAll(".slide")];
  slides.forEach((slide, i) => slide.classList.toggle("is-on", i === attractIndex));
  clearInterval(attractTimer);
  attractTimer = setInterval(() => {
    attractIndex = (attractIndex + 1) % slides.length;
    slides.forEach((slide, i) => slide.classList.toggle("is-on", i === attractIndex));
  }, 4200);
}

async function requestWakeLock() {
  try {
    if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    /* iPad may deny until a gesture */
  }
}

async function useDemoPhoto() {
  const image = new Image();
  image.src = "./assets/demo-guest.jpg";
  await image.decode();
  revoke(state.photoUrl);
  state.photo = image;
  state.photoUrl = image.src;
  showScreen("themes");
}

async function startCamera() {
  await stopCamera();
  const constraints = {
    audio: false,
    video: {
      facingMode: state.facingMode,
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  };
  state.stream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = state.stream;
  video.classList.toggle("is-mirrored", state.facingMode === "user");
  await video.play();
}

async function stopCamera() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  video.srcObject = null;
}

function captureFrame() {
  const width = video.videoWidth || 1600;
  const height = video.videoHeight || 900;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (state.facingMode === "user") {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, width, height);
  return canvas;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCountdown() {
  countdownEl.hidden = false;
  for (const value of ["3", "2", "1"]) {
    countdownEl.textContent = value;
    countdownEl.classList.remove("pop");
    void countdownEl.offsetWidth;
    countdownEl.classList.add("pop");
    navigator.vibrate?.(80);
    await wait(780);
  }
  countdownEl.textContent = "";
  countdownEl.hidden = true;
}

function renderThemes() {
  themeGrid.innerHTML = THEMES.map(
    (theme) => `
      <button class="theme-tile" type="button" data-theme="${theme.id}">
        <img src="${theme.sample}" alt="${theme.name}">
        <span class="theme-copy">
          <strong>${theme.name}</strong>
          <em>${theme.scent}</em>
          <small>${theme.clothing}</small>
        </span>
      </button>
    `,
  ).join("");
}

async function makePortrait(themeId) {
  if (!state.photo) return;
  state.busy = true;
  $("magic-veil").hidden = false;
  $("magic-line").textContent = themeById(themeId).name;
  try {
    const result = await composePortrait(state.photo, themeById(themeId));
    revoke(state.portraitUrl);
    state.themeId = themeId;
    state.portrait = result.blob;
    state.portraitUrl = URL.createObjectURL(result.blob);
    revealImage.src = state.portraitUrl;
    thanksImage.src = state.portraitUrl;
    markThemeSelected();
  } finally {
    state.busy = false;
    $("magic-veil").hidden = true;
  }
}

function markThemeSelected() {
  themeGrid.querySelectorAll(".theme-tile").forEach((tile) => {
    tile.classList.toggle("is-selected", tile.dataset.theme === state.themeId);
  });
  $("reveal-themes").querySelectorAll(".mini-theme").forEach((btn) => {
    btn.classList.toggle("is-selected", btn.dataset.theme === state.themeId);
  });
}

function renderRevealThemes() {
  $("reveal-themes").innerHTML = THEMES.map(
    (theme) => `
      <button class="mini-theme" type="button" data-theme="${theme.id}">
        <img src="${theme.sample}" alt="">
        <span>${theme.name}</span>
      </button>
    `,
  ).join("");
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validPhone(value) {
  return value.replace(/\D/g, "").length >= 10;
}

async function submitLead(event) {
  event.preventDefault();
  const email = $("guest-email").value.trim();
  const phone = $("guest-phone").value.trim();
  const name = $("guest-name").value.trim();
  const error = $("contact-error");
  if (!validEmail(email) || !validPhone(phone)) {
    error.hidden = false;
    error.textContent = "Add a real email and a 10-digit phone so we can send the portraits.";
    return;
  }
  error.hidden = true;
  const lead = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    name,
    email,
    phone,
    theme: state.themeId,
    photo: state.portraitUrl ? await blobToDataUrl(state.portrait) : "",
  };
  await saveLead(lead);
  $("thanks-email").textContent = email;
  $("thanks-phone").textContent = phone;
  showScreen("thanks");
  clearTimeout(thanksTimer);
  thanksTimer = setTimeout(() => resetToAttract(), THANKS_MS);
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

function wireEvents() {
  $("btn-start").addEventListener("click", async () => {
    await requestWakeLock();
    if (new URLSearchParams(location.search).has("demo")) {
      await useDemoPhoto();
      return;
    }
    showScreen("camera");
    try {
      await startCamera();
    } catch {
      $("camera-error").hidden = false;
      $("btn-demo").hidden = false;
    }
  });

  $("btn-demo").addEventListener("click", () => useDemoPhoto());

  $("btn-flip").addEventListener("click", async () => {
    state.facingMode = state.facingMode === "user" ? "environment" : "user";
    try {
      await startCamera();
    } catch {
      $("camera-error").hidden = false;
    }
  });

  $("btn-back-camera").addEventListener("click", () => resetToAttract());

  $("btn-snap").addEventListener("click", async () => {
    if (state.busy) return;
    state.busy = true;
    $("btn-snap").disabled = true;
    try {
      await runCountdown();
      document.body.classList.add("flash");
      const frame = captureFrame();
      setTimeout(() => document.body.classList.remove("flash"), 180);
      revoke(state.photoUrl);
      state.photo = frame;
      state.photoUrl = frame.toDataURL("image/jpeg", 0.92);
      await stopCamera();
      showScreen("themes");
    } finally {
      state.busy = false;
      $("btn-snap").disabled = false;
    }
  });

  $("btn-back-themes").addEventListener("click", async () => {
    showScreen("camera");
    try {
      await startCamera();
    } catch {
      $("camera-error").hidden = false;
    }
  });

  themeGrid.addEventListener("click", async (event) => {
    const tile = event.target.closest("[data-theme]");
    if (!tile || state.busy) return;
    showScreen("reveal");
    await makePortrait(tile.dataset.theme);
  });

  $("reveal-themes").addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-theme]");
    if (!btn || state.busy) return;
    await makePortrait(btn.dataset.theme);
  });

  $("btn-retake").addEventListener("click", async () => {
    showScreen("camera");
    try {
      await startCamera();
    } catch {
      $("camera-error").hidden = false;
    }
  });

  $("btn-send").addEventListener("click", () => showScreen("contact"));
  $("btn-back-contact").addEventListener("click", () => showScreen("reveal"));
  $("contact-form").addEventListener("submit", submitLead);
  $("btn-next-guest").addEventListener("click", () => resetToAttract());

  $("brand-mark").addEventListener("click", () => {
    logoTaps += 1;
    clearTimeout(logoTapTimer);
    logoTapTimer = setTimeout(() => {
      logoTaps = 0;
    }, 1600);
    if (logoTaps >= 6) {
      window.location.href = "./admin.html";
    }
  });

  ["pointerdown", "keydown", "touchstart"].forEach((name) => {
    document.addEventListener(name, bumpIdle, { passive: true });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") requestWakeLock();
  });
}

async function boot() {
  renderThemes();
  renderRevealThemes();
  startAttract();
  wireEvents();
  showScreen("attract");
  statusChip.textContent = "Warming the studio…";
  try {
    await preloadComposer();
    statusChip.textContent = "Studio ready";
    statusChip.dataset.ready = "true";
  } catch {
    statusChip.textContent = "Studio ready";
  }
}

boot();
