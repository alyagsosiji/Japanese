// 天の川 (Amanogawa) — Photorealistic Milky Way & Spectral Starfield Renderer
(function () {
  'use strict';

  const canvas = document.getElementById('milkyway-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return;

  const prefersReducedMotion =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Deterministic PRNG for pleasing, balanced star compositions
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Authentic astronomical spectral colors (O/B blue-white, A white, F/G cream-gold, K warm amber)
  const SPECTRAL_COLORS = [
    { r: 168, g: 210, b: 255, weight: 0.24 }, // Sirius blue-white
    { r: 235, g: 244, b: 255, weight: 0.42 }, // Vega crisp white
    { r: 248, g: 232, b: 196, weight: 0.22 }, // Capella champagne gold
    { r: 242, g: 200, b: 158, weight: 0.12 }  // Antares soft amber
  ];

  function pickSpectral(rand) {
    let acc = 0;
    const v = rand();
    for (const c of SPECTRAL_COLORS) {
      acc += c.weight;
      if (v <= acc) return c;
    }
    return SPECTRAL_COLORS[1];
  }

  let width = 0;
  let height = 0;
  let dpr = 1;
  let offscreen = null;
  let stars = [];
  let brightStars = [];
  let shootingStar = null;
  let nextMeteorTime = 4500;
  let rafId = null;

  // Evaluate signed distance from diagonal Milky Way galactic centerline
  function galacticOffset(x, y, w, h) {
    // Runs gently curving from bottom-left (0.08w, 1.05h) toward top-right (0.94w, -0.05h)
    const nx = x / w;
    const ny = y / h;
    const targetY = 1.02 - 1.04 * nx + 0.07 * Math.sin(nx * Math.PI * 1.6);
    return ny - targetY;
  }

  function buildStaticMilkyWay(w, h) {
    const off = document.createElement('canvas');
    off.width = Math.round(w * dpr);
    off.height = Math.round(h * dpr);
    const octx = off.getContext('2d', { alpha: false });
    octx.scale(dpr, dpr);

    // 1. Deep celestial sapphire-indigo base gradient (luminous night sky, never flat black)
    const skyGrad = octx.createLinearGradient(0, 0, w * 0.4, h);
    skyGrad.addColorStop(0, '#071022');
    skyGrad.addColorStop(0.45, '#0b1831');
    skyGrad.addColorStop(1, '#102242');
    octx.fillStyle = skyGrad;
    octx.fillRect(0, 0, w, h);

    // 2. Layered Milky Way Nebular Dust Band (diagonal galactic river)
    const rand = mulberry32(20260707);
    const steps = 42;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx = w * (-0.08 + t * 1.18);
      const cy = h * (1.06 - t * 1.12 + 0.065 * Math.sin(t * Math.PI * 1.6));

      // Outer cool glacial blue-slate haze
      const rOuter = Math.max(w, h) * (0.21 + 0.07 * Math.sin(t * Math.PI));
      const gOuter = octx.createRadialGradient(cx, cy, 0, cx, cy, rOuter);
      gOuter.addColorStop(0, 'rgba(104, 162, 228, 0.075)');
      gOuter.addColorStop(0.48, 'rgba(48, 96, 152, 0.042)');
      gOuter.addColorStop(1, 'rgba(11, 24, 49, 0)');
      octx.fillStyle = gOuter;
      octx.beginPath();
      octx.arc(cx, cy, rOuter, 0, Math.PI * 2);
      octx.fill();

      // Inner luminous silver-champagne galactic core cloud (stronger near middle-lower section)
      const coreStrength = Math.exp(-Math.pow((t - 0.44) / 0.36, 2));
      const rCore = Math.max(w, h) * (0.1 + 0.045 * coreStrength);
      const jx = cx + (rand() - 0.5) * rCore * 0.35;
      const jy = cy + (rand() - 0.5) * rCore * 0.35;
      const gCore = octx.createRadialGradient(jx, jy, 0, jx, jy, rCore);
      gCore.addColorStop(0, `rgba(236, 212, 168, ${(0.026 + 0.04 * coreStrength).toFixed(4)})`);
      gCore.addColorStop(0.45, `rgba(160, 204, 246, ${(0.02 + 0.026 * coreStrength).toFixed(4)})`);
      gCore.addColorStop(1, 'rgba(11, 24, 49, 0)');
      octx.fillStyle = gCore;
      octx.beginPath();
      octx.arc(jx, jy, rCore, 0, Math.PI * 2);
      octx.fill();
    }

    // 3. Great Rift (subtle cosmic dust lane along center of the Milky Way — soft indigo, never pitch black)
    for (let i = 0; i <= 24; i++) {
      const t = 0.14 + (i / 24) * 0.74;
      const cx = w * (-0.04 + t * 1.12) + (rand() - 0.5) * 28;
      const cy = h * (1.03 - t * 1.07 + 0.065 * Math.sin(t * Math.PI * 1.6)) + (rand() - 0.5) * 24;
      const rDark = Math.max(w, h) * (0.04 + rand() * 0.025);
      const gDark = octx.createRadialGradient(cx, cy, 0, cx, cy, rDark);
      gDark.addColorStop(0, 'rgba(7, 16, 34, 0.18)');
      gDark.addColorStop(0.6, 'rgba(7, 16, 34, 0.06)');
      gDark.addColorStop(1, 'rgba(7, 16, 34, 0)');
      octx.fillStyle = gDark;
      octx.beginPath();
      octx.arc(cx, cy, rDark, 0, Math.PI * 2);
      octx.fill();
    }

    // 4. Thousands of fine micro-stars concentrated densely along the Milky Way river
    const microCount = Math.min(1800, Math.max(850, Math.floor((w * h) / 950)));
    for (let i = 0; i < microCount; i++) {
      let x, y;
      if (rand() < 0.72) {
        // Clustered around the galactic band using Gaussian-like spread
        const t = rand();
        const spread = ((rand() + rand() + rand()) / 3 - 0.5) * 0.44;
        x = w * (-0.05 + t * 1.12);
        const baseY = h * (1.04 - t * 1.08 + 0.065 * Math.sin(t * Math.PI * 1.6));
        y = baseY + spread * h;
      } else {
        x = rand() * w;
        y = rand() * h;
      }
      if (x < 0 || x > w || y < 0 || y > h) continue;

      const dist = Math.abs(galacticOffset(x, y, w, h));
      const inBandBoost = Math.exp(-dist * dist * 16);
      const col = pickSpectral(rand);
      const radius = 0.35 + Math.pow(rand(), 2.6) * 0.95;
      const alpha = (0.14 + rand() * 0.42) * (0.7 + 0.45 * inBandBoost);

      octx.fillStyle = `rgba(${col.r}, ${col.g}, ${col.b}, ${Math.min(0.85, alpha).toFixed(3)})`;
      octx.beginPath();
      octx.arc(x, y, radius, 0, Math.PI * 2);
      octx.fill();
    }

    return off;
  }

  function initStars(w, h) {
    const rand = mulberry32(99173);
    stars = [];
    brightStars = [];

    const count = Math.min(260, Math.max(120, Math.floor((w * h) / 6800)));
    for (let i = 0; i < count; i++) {
      let x, y;
      if (rand() < 0.55) {
        const t = rand();
        const spread = ((rand() + rand()) / 2 - 0.5) * 0.48;
        x = w * t;
        y = h * (1.02 - t * 1.04 + 0.065 * Math.sin(t * Math.PI * 1.6)) + spread * h;
      } else {
        x = rand() * w;
        y = rand() * h;
      }
      const col = pickSpectral(rand);
      const isHero = i < 12;
      const star = {
        x,
        y,
        r: isHero ? 1.45 + rand() * 0.85 : 0.65 + Math.pow(rand(), 1.8) * 1.1,
        col,
        baseAlpha: isHero ? 0.86 : 0.42 + rand() * 0.45,
        phase: rand() * Math.PI * 2,
        speed: 0.0006 + rand() * 0.0014,
        isHero
      };
      stars.push(star);
      if (isHero) brightStars.push(star);
    }
  }

  function spawnMeteor(now) {
    const startX = width * (0.35 + Math.random() * 0.55);
    const startY = height * (0.04 + Math.random() * 0.28);
    const angle = Math.PI * (0.68 + Math.random() * 0.14);
    const speed = 0.72 + Math.random() * 0.38;
    shootingStar = {
      x: startX,
      y: startY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      born: now,
      life: 750 + Math.random() * 380,
      length: 95 + Math.random() * 65
    };
    nextMeteorTime = now + 11000 + Math.random() * 11000;
  }

  function drawFrame(now) {
    if (!offscreen) return;

    // Blit pre-rendered Milky Way sky
    ctx.drawImage(offscreen, 0, 0, width, height);

    // Subtle delicate constellation hints among nearby bright stars
    ctx.lineWidth = 0.6;
    for (let i = 0; i < brightStars.length; i++) {
      for (let j = i + 1; j < brightStars.length; j++) {
        const a = brightStars[i];
        const b = brightStars[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist > 70 && dist < 210) {
          ctx.strokeStyle = 'rgba(184, 214, 248, 0.065)';
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    // Animated twinkling spectral stars
    for (const s of stars) {
      const twinkle = prefersReducedMotion
        ? 1
        : 0.74 + 0.26 * Math.sin(now * s.speed + s.phase);
      const alpha = Math.min(1, s.baseAlpha * twinkle);

      if (s.isHero) {
        // Soft atmospheric halo
        const glow = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 5.2);
        glow.addColorStop(0, `rgba(${s.col.r}, ${s.col.g}, ${s.col.b}, ${(alpha * 0.36).toFixed(3)})`);
        glow.addColorStop(1, `rgba(${s.col.r}, ${s.col.g}, ${s.col.b}, 0)`);
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * 5.2, 0, Math.PI * 2);
        ctx.fill();

        // Crisp 4-point starlight diffraction spike
        const spike = s.r * 4.5 * twinkle;
        ctx.strokeStyle = `rgba(${s.col.r}, ${s.col.g}, ${s.col.b}, ${(alpha * 0.42).toFixed(3)})`;
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(s.x - spike, s.y);
        ctx.lineTo(s.x + spike, s.y);
        ctx.moveTo(s.x, s.y - spike);
        ctx.lineTo(s.x, s.y + spike);
        ctx.stroke();
      }

      ctx.fillStyle = `rgba(${s.col.r}, ${s.col.g}, ${s.col.b}, ${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Rare serene shooting star
    if (!prefersReducedMotion) {
      if (!shootingStar && now > nextMeteorTime) {
        spawnMeteor(now);
      }
      if (shootingStar) {
        const age = now - shootingStar.born;
        if (age >= shootingStar.life) {
          shootingStar = null;
        } else {
          const p = age / shootingStar.life;
          const fade = Math.sin(p * Math.PI);
          const hx = shootingStar.x + shootingStar.vx * age;
          const hy = shootingStar.y + shootingStar.vy * age;
          const speedMag = Math.hypot(shootingStar.vx, shootingStar.vy);
          const tx = hx - (shootingStar.vx / speedMag) * shootingStar.length * fade;
          const ty = hy - (shootingStar.vy / speedMag) * shootingStar.length * fade;

          const grad = ctx.createLinearGradient(hx, hy, tx, ty);
          grad.addColorStop(0, `rgba(255, 248, 232, ${(0.88 * fade).toFixed(3)})`);
          grad.addColorStop(0.35, `rgba(176, 214, 255, ${(0.35 * fade).toFixed(3)})`);
          grad.addColorStop(1, 'rgba(136, 197, 247, 0)');
          ctx.strokeStyle = grad;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(hx, hy);
          ctx.lineTo(tx, ty);
          ctx.stroke();
        }
      }
    }
  }

  function loop(now) {
    if (!document.hidden) {
      drawFrame(now);
    }
    if (!prefersReducedMotion) {
      rafId = requestAnimationFrame(loop);
    }
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = Math.max(window.innerWidth, Math.ceil(rect.width || 0));
    height = Math.max(window.innerHeight, Math.ceil(rect.height || 0));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    offscreen = buildStaticMilkyWay(width, height);
    initStars(width, height);
    drawFrame(performance.now());
  }

  let resizeTimer = null;
  function scheduleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 160);
  }
  window.addEventListener('resize', scheduleResize);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', scheduleResize);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !prefersReducedMotion && !rafId) {
      rafId = requestAnimationFrame(loop);
    }
  });

  resize();
  if (!prefersReducedMotion) {
    rafId = requestAnimationFrame(loop);
  }
})();
