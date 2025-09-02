"use strict";

/*
  Side-scroller with shooting & melee enemies

  Changes:
  - Mario replaced by a soldier with a pistol (player can shoot).
  - Spawns a row of sword soldiers.
  - Player bullet kills sword soldier with 1 hit.
  - The gun soldier (player) dies after being slashed 3 times.
  - HUD shows health and remaining enemies.
*/

// Canvas and rendering setup (HiDPI)
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d", { alpha: false });
let DPR = Math.min(2, window.devicePixelRatio || 1);
function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const cssW = Math.max(640, Math.floor(rect.width));
  const cssH = Math.max(360, Math.floor(rect.height));
  DPR = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.floor(cssW * DPR);
  canvas.height = Math.floor(cssH * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0); // draw using CSS pixels
  ctx.imageSmoothingEnabled = false;
}
resizeCanvas();
window.addEventListener("resize", resizeCanvas);

// Constants
const TILE = 48;
const LEVEL_H = 12; // rows
const LEVEL_W = 180; // columns (world width)
const WORLD_W = LEVEL_W * TILE;
const WORLD_H = LEVEL_H * TILE;

const GRAVITY = 2400;
const MOVE_MAX = 300;
const ACCEL_GROUND = 2000;
const ACCEL_AIR = 1200;
const FRICTION_GROUND = 2100;
const FRICTION_AIR = 200;
const JUMP_VEL = 900;
const COYOTE_TIME = 0.08;
const JUMP_BUFFER = 0.10;

// Combat constants
const BULLET_SPEED = 800;
const SHOOT_COOLDOWN = 0.25;
const BULLET_LIFETIME = 1.4;
const ENEMY_SPEED = 90;
const SLASH_RANGE = 34;
const SLASH_COOLDOWN = 0.9;
const ENEMY_JUMP_VEL = 780;
const ENEMY_JUMP_COOLDOWN = 0.6;
const PLAYER_MAX_HP = 3;
const PLAYER_IFRAMES = 0.7;

// Input
const keys = {
  left: false,
  right: false,
  jump: false,
  jumpPressedAt: -999,
  jumpHeld: false,
  shoot: false,
  shootPressedAt: -999,
  restart: false,
};
const KeyMap = {
  Left: ["ArrowLeft", "a", "A"],
  Right: ["ArrowRight", "d", "D"],
  Jump: [" ", "Space", "ArrowUp", "w", "W"],
  Shoot: ["j", "J", "f", "F"],
  Restart: ["r", "R"],
};
function onKey(e, down) {
  const k = e.key;
  if (KeyMap.Left.includes(k)) {
    keys.left = down;
    e.preventDefault();
  } else if (KeyMap.Right.includes(k)) {
    keys.right = down;
    e.preventDefault();
  } else if (KeyMap.Jump.includes(k)) {
    if (down) {
      keys.jump = true;
      keys.jumpHeld = true;
      keys.jumpPressedAt = timeNow;
    } else {
      keys.jumpHeld = false;
    }
    e.preventDefault();
  } else if (KeyMap.Shoot.includes(k)) {
    if (down) {
      keys.shoot = true;
      keys.shootPressedAt = timeNow;
    } else {
      keys.shoot = false;
    }
    e.preventDefault();
  } else if (KeyMap.Restart.includes(k)) {
    keys.restart = down;
    e.preventDefault();
  }
}
window.addEventListener("keydown", (e) => onKey(e, true));
window.addEventListener("keyup", (e) => onKey(e, false));

// Simple deterministic RNG for repeatable level decorations
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rng = mulberry32(1337);

// Level data (boolean solid tiles)
let level = createLevel();

// Decorative background elements
const clouds = createClouds(32);
const hills = createHills(18);

// Entities
const player = {
  x: TILE * 2,
  y: 0,
  w: 28,
  h: 42,
  vx: 0,
  vy: 0,
  onGround: false,
  coyote: 0,
  lastJumpCut: false,
  facing: 1, // 1 right, -1 left
  hp: PLAYER_MAX_HP,
  invuln: 0,
  lastShotAt: -999,
};
const bullets = [];
const enemies = [];

// Camera
let camX = 0;

// Time
let lastFrame = performance.now();
let timeNow = 0;

// HUD dynamic info
const hud = document.getElementById("hud");
const hudInfo = document.createElement("div");
hudInfo.style.marginTop = "6px";
hudInfo.style.fontSize = "12px";
hudInfo.style.opacity = "0.95";
hud.appendChild(hudInfo);

// Main loop
requestAnimationFrame(loop);

function loop(ts) {
  const rawDt = (ts - lastFrame) / 1000;
  lastFrame = ts;
  timeNow += rawDt;
  const dt = Math.min(1 / 30, rawDt); // clamp big frame gaps

  if (keys.restart) {
    restart();
  }

  update(dt);
  draw();

  requestAnimationFrame(loop);
}

function restart() {
  rng = mulberry32(1337);
  level = createLevel();
  resetPlayerToStart();
  bullets.length = 0;
  enemies.length = 0;
  spawnSwordLine();
  camX = 0;
  keys.restart = false;
}

function spawnSwordLine() {
  // Spawn a line of sword enemies ahead
  const count = 10;
  const startX = TILE * 22;
  const spacing = 80;
  for (let i = 0; i < count; i++) {
    const ex = startX + i * spacing;
    const groundY = groundTopAtX(ex);
    const e = {
      type: "sword",
      x: ex,
      y: groundY - 40, // enemy height is ~40
      w: 26,
      h: 40,
      vx: 0,
      vy: 0,
      onGround: false,
      facing: -1,
      slashCD: 0,
      jumpCD: 0,
      alive: true,
    };
    enemies.push(e);
  }
}

// Create a side-scrolling level with ground, gaps, and some platforms
function createLevel() {
  const solid = Array.from({ length: LEVEL_H }, () =>
    new Array(LEVEL_W).fill(false)
  );

  // Base: two rows of ground everywhere
  for (let c = 0; c < LEVEL_W; c++) {
    solid[LEVEL_H - 1][c] = true;
    solid[LEVEL_H - 2][c] = true;
  }

  // Carve occasional gaps in ground
  // Ensure gaps are not too close, not too wide
  let c = 10;
  while (c < LEVEL_W - 20) {
    if (rng() < 0.14) {
      const gapW = 2 + Math.floor(rng() * 3); // 2..4 tiles
      for (let gc = 0; gc < gapW && c + gc < LEVEL_W - 12; gc++) {
        solid[LEVEL_H - 1][c + gc] = false;
        solid[LEVEL_H - 2][c + gc] = false;
      }
      // add a rescue platform above some gaps
      if (rng() < 0.6) {
        const platRow = LEVEL_H - 4 - Math.floor(rng() * 2); // above ground
        const start = c - 1;
        const w = gapW + 2;
        for (let pc = 0; pc < w; pc++) {
          setSolid(platRow, start + pc, true);
        }
      }
      c += gapW + 6 + Math.floor(rng() * 6);
    } else {
      c += 3 + Math.floor(rng() * 6);
    }
  }

  // Add some simple stairs and platforms along the way
  for (let i = 0; i < 25; i++) {
    const base = 12 + Math.floor(rng() * (LEVEL_W - 24));
    const height = 1 + Math.floor(rng() * 3);
    const width = 2 + Math.floor(rng() * 5);
    for (let w = 0; w < width; w++) {
      for (let h = 0; h < height; h++) {
        const row = LEVEL_H - 3 - h;
        const col = base + w;
        setSolid(row, col, true);
      }
    }
  }

  // Floating platforms
  for (let i = 0; i < 30; i++) {
    const row = 3 + Math.floor(rng() * (LEVEL_H - 6));
    const col = 12 + Math.floor(rng() * (LEVEL_W - 24));
    const width = 2 + Math.floor(rng() * 3);
    for (let w = 0; w < width; w++) {
      setSolid(row, col + w, true);
    }
  }

  // Create an ending platform and flag base near end
  for (let w = 0; w < 8; w++) {
    setSolid(LEVEL_H - 3, LEVEL_W - 6 + (w - 4), true);
  }

  function setSolid(r, c, val) {
    if (r >= 0 && r < LEVEL_H && c >= 0 && c < LEVEL_W) {
      solid[r][c] = val;
    }
  }

  return solid;
}

function resetPlayerToStart() {
  player.x = TILE * 2;
  player.y = groundTopAtX(player.x) - player.h - 0.1;
  player.vx = 0;
  player.vy = 0;
  player.onGround = false;
  player.coyote = 0;
  player.lastJumpCut = false;
  player.facing = 1;
  player.hp = PLAYER_MAX_HP;
  player.invuln = 0;
  player.lastShotAt = -999;
}

// MAIN UPDATE
function update(dt) {
  // Input horizontal movement
  const wantDir = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const accel = player.onGround ? ACCEL_GROUND : ACCEL_AIR;
  const friction = player.onGround ? FRICTION_GROUND : FRICTION_AIR;

  if (wantDir !== 0) {
    player.vx += wantDir * accel * dt;
    player.facing = wantDir;
  } else {
    // apply friction to slow down
    const s = Math.sign(player.vx);
    const mag = Math.max(0, Math.abs(player.vx) - friction * dt);
    player.vx = mag * s;
  }

  // clamp horizontal speed
  player.vx = clamp(player.vx, -MOVE_MAX, MOVE_MAX);

  // Jump buffer + coyote time
  if (player.onGround) {
    player.coyote = COYOTE_TIME;
  } else {
    player.coyote = Math.max(0, player.coyote - dt);
  }

  const canJump =
    (timeNow - keys.jumpPressedAt) <= JUMP_BUFFER &&
    (player.onGround || player.coyote > 0);

  if (canJump) {
    player.vy = -JUMP_VEL;
    player.onGround = false;
    player.coyote = 0;
    keys.jumpPressedAt = -999;
    player.lastJumpCut = false;
  }

  // Variable jump height: if releasing jump while going up, cut velocity
  if (!keys.jumpHeld && player.vy < 0 && !player.lastJumpCut) {
    player.vy *= 0.6;
    player.lastJumpCut = true;
  }

  // Gravity
  player.vy += GRAVITY * dt;
  // terminal fall speed to reduce tunneling
  player.vy = Math.min(player.vy, 1800);

  // Integrate and collide for player
  player.onGround = false;
  moveAndCollide(player, dt);

  // Shooting
  if (keys.shoot && timeNow - player.lastShotAt >= SHOOT_COOLDOWN) {
    shootBullet();
  }

  // Update bullets
  for (const b of bullets) {
    b.life += dt;
    b.x += b.vx * dt;

    // collide with tiles
    if (rectHitsSolid(b.x, b.y, b.w, b.h)) {
      b.dead = true;
      continue;
    }
    // out of world or lifetime
    if (b.life > BULLET_LIFETIME || b.x < 0 || b.x > WORLD_W) {
      b.dead = true;
      continue;
    }

    // bullet vs enemies
    for (const e of enemies) {
      if (!e.alive) continue;
      if (aabb(b.x, b.y, b.w, b.h, e.x, e.y, e.w, e.h)) {
        // bullet kills sword enemy instantly
        if (e.type === "sword") {
          e.alive = false;
        }
        b.dead = true;
        break;
      }
    }
  }
  // prune bullets
  for (let i = bullets.length - 1; i >= 0; i--) {
    if (bullets[i].dead) bullets.splice(i, 1);
  }

  // Update enemies
  for (const e of enemies) {
    if (!e.alive) continue;

    // simple chase AI when close horizontally
    const dx = (player.x + player.w / 2) - (e.x + e.w / 2);
    if (Math.abs(dx) < 600) {
      const dir = Math.sign(dx) || 1;
      e.vx = dir * ENEMY_SPEED;
      e.facing = dir;
    } else {
      e.vx = 0;
    }

    // jump AI: obstacles, gaps, or player above
    if (e.jumpCD > 0) e.jumpCD -= dt;
    if (e.onGround && e.jumpCD <= 0) {
      const dirSign = e.facing >= 0 ? 1 : -1;
      const frontX = e.x + (dirSign === 1 ? e.w + 2 : -2);
      const footY = e.y + e.h - 1;
      const chestY = e.y + e.h - 20;
      const colAhead = Math.floor(frontX / TILE);
      const rowFoot = Math.floor(footY / TILE);
      const rowChest = Math.floor(chestY / TILE);
      const wallAhead = isSolid(rowChest, colAhead);
      const gapAhead = !isSolid(rowFoot + 1, colAhead);
      const playerAbove = (player.y + player.h / 2) < (e.y + e.h / 2) && Math.abs(dx) < 120;

      if (wallAhead || gapAhead || playerAbove) {
        e.vy = -ENEMY_JUMP_VEL;
        e.onGround = false;
        e.jumpCD = ENEMY_JUMP_COOLDOWN;
      }
    }

    // gravity
    e.vy += GRAVITY * dt;
    e.vy = Math.min(e.vy, 1800);
    e.onGround = false;
    moveAndCollide(e, dt);

    // cooldowns
    if (e.slashCD > 0) e.slashCD -= dt;

    // slash if in range and roughly same height
    const sameHeight = Math.abs((e.y + e.h / 2) - (player.y + player.h / 2)) < 24;
    const close = Math.abs((e.x + e.w / 2) - (player.x + player.w / 2)) < SLASH_RANGE;
    if (e.type === "sword" && sameHeight && close && e.slashCD <= 0) {
      e.slashCD = SLASH_COOLDOWN;
      // damage player if not in iframes
      if (player.invuln <= 0) {
        player.hp -= 1;
        player.invuln = PLAYER_IFRAMES;
        // small knockback
        const k = Math.sign(player.x - e.x) || 1;
        player.vx += k * 120;
        player.vy = Math.min(player.vy, 0);
        player.vy -= 220;
      }
    }
  }

  // prune dead enemies
  for (let i = enemies.length - 1; i >= 0; i--) {
    if (!enemies[i].alive) enemies.splice(i, 1);
  }

  // i-frames tick
  if (player.invuln > 0) player.invuln -= dt;

  // Update camera follow (centered with slight forward offset)
  const forward = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const targetCam =
    player.x + player.w / 2 - canvas.width / DPR / 2 + forward * 80;
  camX += (targetCam - camX) * 0.12;
  camX = clamp(camX, 0, WORLD_W - canvas.width / DPR);

  // Fail-safe: if falls out of world, restart to last safe spot
  if (player.y > WORLD_H + 200) {
    resetPlayerToStart();
    camX = clamp(player.x - canvas.width / DPR / 2, 0, WORLD_W - canvas.width / DPR);
    bullets.length = 0;
  }

  // HUD info
  const dist = Math.max(0, Math.floor((player.x / WORLD_W) * 100));
  const hp = Math.max(0, player.hp);
  const remain = enemies.length;
  hudInfo.textContent = `Tiến độ: ${dist}% • Máu: ${hp}/${PLAYER_MAX_HP} • Địch còn: ${remain} • Vị trí: ${Math.floor(
    player.x
  )}, ${Math.floor(player.y)} • R: chơi lại`;

  // death
  if (player.hp <= 0) {
    restart();
  }
}

function shootBullet() {
  player.lastShotAt = timeNow;
  const dir = player.facing >= 0 ? 1 : -1;
  const muzzleX = player.x + (dir === 1 ? player.w - 6 : 6);
  const muzzleY = player.y + 18;
  bullets.push({
    x: muzzleX,
    y: muzzleY,
    w: 10,
    h: 3,
    vx: dir * BULLET_SPEED,
    life: 0,
    dead: false,
  });
}

// Drawing
function draw() {
  const W = canvas.width / DPR;
  const H = canvas.height / DPR;

  // Sky gradient
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#87CEEB");
  sky.addColorStop(0.6, "#4fb4ff");
  sky.addColorStop(1, "#8bd868");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // Parallax backgrounds
  drawHills(camX, W, H);
  drawClouds(camX, W, H);

  // Visible tile range
  const firstCol = Math.max(0, Math.floor(camX / TILE) - 2);
  const lastCol = Math.min(
    LEVEL_W - 1,
    Math.floor((camX + W) / TILE) + 2
  );

  // Draw tiles
  for (let r = 0; r < LEVEL_H; r++) {
    for (let c = firstCol; c <= lastCol; c++) {
      if (!level[r][c]) continue;
      const x = c * TILE - camX;
      const y = r * TILE;
      // dirt block
      ctx.fillStyle = "#8B5A2B";
      ctx.fillRect(Math.floor(x), Math.floor(y), TILE, TILE);

      // darker bottom
      ctx.fillStyle = "#6d4621";
      ctx.fillRect(Math.floor(x), Math.floor(y + TILE - 10), TILE, 10);

      // grass top if top-exposed
      const topExposed = r - 1 >= 0 ? !level[r - 1][c] : true;
      if (topExposed) {
        ctx.fillStyle = "#2ea043";
        ctx.fillRect(Math.floor(x), Math.floor(y), TILE, 10);
        // blades
        ctx.fillStyle = "#3ecf5e";
        for (let i = 0; i < 6; i++) {
          const gx = Math.floor(x) + 3 + i * 8 + ((c * 13 + r * 7 + i) % 3);
          ctx.fillRect(gx, Math.floor(y) + 2, 4, 3);
        }
      }
    }
  }

  // Draw goal flag near end
  drawGoal(W, H);

  // Draw bullets
  for (const b of bullets) {
    const bx = Math.floor(b.x - camX);
    const by = Math.floor(b.y);
    ctx.fillStyle = "#111"; // bullet body
    ctx.fillRect(bx, by, b.w, b.h);
    ctx.fillStyle = "#ffd166";
    ctx.fillRect(bx - (b.vx < 0 ? 1 : 0), by, 2, b.h); // small muzzle trace
  }

  // Draw enemies
  for (const e of enemies) {
    if (!e.alive) continue;
    drawSwordEnemy(e);
  }

  // Draw player soldier
  drawPlayer();
}

function drawPlayer() {
  // blink while invulnerable
  if (player.invuln > 0) {
    const t = Math.floor(timeNow * 20) % 2;
    if (t === 0) return;
  }

  const px = Math.floor(player.x - camX);
  const py = Math.floor(player.y);
  const facing = player.facing >= 0 ? 1 : -1;

  // shadow
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.beginPath();
  ctx.ellipse(
    px + player.w / 2,
    py + player.h,
    Math.max(8, Math.min(18, Math.abs(player.vx) * 0.06 + (player.onGround ? 14 : 10))),
    6,
    0,
    0,
    Math.PI * 2
  );
  ctx.fill();

  // legs
  ctx.fillStyle = "#374151"; // dark grey pants
  const walkPhase = (timeNow * 10 * (Math.abs(player.vx) / MOVE_MAX)) % (Math.PI * 2);
  const legOffset = player.onGround ? Math.sin(walkPhase) * 3 : 0;
  const legW = 10, legH = 16;
  ctx.fillRect(px + 6, py + player.h - legH, legW, legH);
  ctx.fillRect(px + player.w - 6 - legW, py + player.h - legH + legOffset, legW, legH);

  // torso (vest)
  ctx.fillStyle = "#4b5563"; // slate grey
  ctx.fillRect(px + 4, py + 12, player.w - 8, 18);

  // belt
  ctx.fillStyle = "#1f2937";
  ctx.fillRect(px + 4, py + 28, player.w - 8, 3);

  // arms
  ctx.fillStyle = "#4b5563";
  if (facing === 1) {
    ctx.fillRect(px + player.w - 8, py + 14, 8, 6);
  } else {
    ctx.fillRect(px, py + 14, 8, 6);
  }

  // head
  ctx.fillStyle = "#f1c27d";
  ctx.fillRect(px + 6, py, player.w - 12, 12);

  // helmet
  ctx.fillStyle = "#2f855a"; // green
  ctx.fillRect(px + 4, py - 4, player.w - 8, 6);
  ctx.fillRect(
    facing === 1 ? px + 4 : px + player.w - 16,
    py - 2,
    12,
    3
  );

  // eye
  ctx.fillStyle = "#111";
  ctx.fillRect(px + (facing === 1 ? player.w - 16 : 8), py + 4, 2, 3);

  // pistol
  ctx.fillStyle = "#111";
  const gunX = facing === 1 ? px + player.w - 2 : px - 10;
  const gunY = py + 18;
  ctx.fillRect(gunX, gunY, 10 * facing, 3); // pistol barrel/body
  // muzzle flash when just shot
  if (timeNow - player.lastShotAt < 0.06) {
    ctx.fillStyle = "#ffd166";
    const mx = facing === 1 ? gunX + 10 : gunX - 6;
    ctx.fillRect(mx, gunY - 1, 6, 5);
  }
}

function drawSwordEnemy(e) {
  const ex = Math.floor(e.x - camX);
  const ey = Math.floor(e.y);
  const facing = e.facing >= 0 ? 1 : -1;

  // shadow
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.beginPath();
  ctx.ellipse(ex + e.w / 2, ey + e.h, 14, 5, 0, 0, Math.PI * 2);
  ctx.fill();

  // legs
  ctx.fillStyle = "#1f4ed8";
  ctx.fillRect(ex + 5, ey + e.h - 14, 8, 14);
  ctx.fillRect(ex + e.w - 13, ey + e.h - 14, 8, 14);

  // torso
  ctx.fillStyle = "#2563eb";
  ctx.fillRect(ex + 4, ey + 10, e.w - 8, 18);

  // head
  ctx.fillStyle = "#f1c27d";
  ctx.fillRect(ex + 6, ey, e.w - 12, 10);

  // band
  ctx.fillStyle = "#b91c1c";
  ctx.fillRect(ex + 4, ey - 3, e.w - 8, 4);

  // eye
  ctx.fillStyle = "#111";
  ctx.fillRect(ex + (facing === 1 ? e.w - 14 : 8), ey + 3, 2, 3);

  // sword arm
  ctx.fillStyle = "#2563eb";
  if (facing === 1) {
    ctx.fillRect(ex + e.w - 6, ey + 14, 6, 6);
    // sword
    ctx.fillStyle = "#cccccc";
    const swing = e.slashCD > SLASH_COOLDOWN - 0.15 ? 6 : 0;
    ctx.fillRect(ex + e.w + 2, ey + 12 - swing, 18, 3);
  } else {
    ctx.fillRect(ex, ey + 14, 6, 6);
    // sword
    ctx.fillStyle = "#cccccc";
    const swing = e.slashCD > SLASH_COOLDOWN - 0.15 ? 6 : 0;
    ctx.fillRect(ex - 20, ey + 12 - swing, 18, 3);
  }
}

// Physics and collisions
function moveAndCollide(ent, dt) {
  // Horizontal
  ent.x += ent.vx * dt;

  if (ent.vx > 0) {
    // moving right: check tiles to the right
    const right = ent.x + ent.w;
    const col = Math.floor((right) / TILE);
    const topRow = Math.floor(ent.y / TILE);
    const botRow = Math.floor((ent.y + ent.h - 1) / TILE);
    for (let r = topRow; r <= botRow; r++) {
      if (isSolid(r, col)) {
        ent.x = col * TILE - ent.w;
        ent.vx = 0;
        break;
      }
    }
  } else if (ent.vx < 0) {
    // moving left: check tiles to the left
    const left = ent.x;
    const col = Math.floor((left) / TILE);
    const topRow = Math.floor(ent.y / TILE);
    const botRow = Math.floor((ent.y + ent.h - 1) / TILE);
    for (let r = topRow; r <= botRow; r++) {
      if (isSolid(r, col)) {
        ent.x = (col + 1) * TILE;
        ent.vx = 0;
        break;
      }
    }
  }

  // Vertical
  ent.y += ent.vy * dt;

  if (ent.vy > 0) {
    // moving down: check bottom
    const bottom = ent.y + ent.h;
    const row = Math.floor(bottom / TILE);
    const leftCol = Math.floor(ent.x / TILE);
    const rightCol = Math.floor((ent.x + ent.w - 1) / TILE);
    for (let c = leftCol; c <= rightCol; c++) {
      if (isSolid(row, c)) {
        ent.y = row * TILE - ent.h;
        ent.vy = 0;
        ent.onGround = true;
        break;
      }
    }
  } else if (ent.vy < 0) {
    // moving up: check top
    const top = ent.y;
    const row = Math.floor(top / TILE);
    const leftCol = Math.floor(ent.x / TILE);
    const rightCol = Math.floor((ent.x + ent.w - 1) / TILE);
    for (let c = leftCol; c <= rightCol; c++) {
      if (isSolid(row, c)) {
        ent.y = (row + 1) * TILE;
        ent.vy = 0;
        break;
      }
    }
  }

  // Clamp inside world bounds horizontally
  ent.x = clamp(ent.x, 0, WORLD_W - ent.w);
}

function rectHitsSolid(x, y, w, h) {
  const leftCol = Math.floor(x / TILE);
  const rightCol = Math.floor((x + w - 1) / TILE);
  const topRow = Math.floor(y / TILE);
  const botRow = Math.floor((y + h - 1) / TILE);
  for (let r = topRow; r <= botRow; r++) {
    for (let c = leftCol; c <= rightCol; c++) {
      if (isSolid(r, c)) return true;
    }
  }
  return false;
}

function isSolid(r, c) {
  if (r < 0 || r >= LEVEL_H || c < 0 || c >= LEVEL_W) return true;
  return level[r][c];
}

function groundTopAtX(x) {
  // find the top-most solid tile at given x
  const col = clamp(Math.floor(x / TILE), 0, LEVEL_W - 1);
  for (let r = 0; r < LEVEL_H; r++) {
    if (level[r][col]) {
      return r * TILE;
    }
  }
  return WORLD_H;
}

// Decorations: clouds
function createClouds(count) {
  const arr = [];
  for (let i = 0; i < count; i++) {
    arr.push({
      x: Math.floor(rng() * WORLD_W),
      y: 20 + Math.floor(rng() * 180),
      s: 0.8 + rng() * 1.8, // size scale
    });
  }
  return arr;
}
function drawClouds(cam, W, H) {
  const parallax = 0.4;
  for (const cl of clouds) {
    const cx = cl.x - cam * parallax;
    // wrap clouds
    let x = ((cx % WORLD_W) + WORLD_W) % WORLD_W;
    // draw over a couple wraps to cover camera range
    for (let k = -1; k <= 1; k++) {
      const px = Math.floor(x + k * WORLD_W - cam * 0); // adjusted above
      const py = Math.floor(cl.y);
      if (px > -200 && px < W + 200) {
        drawCloud(px, py, cl.s);
      }
    }
  }
}
function drawCloud(x, y, s) {
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.beginPath();
  // three-lobed cloud
  ctx.ellipse(x, y, 18 * s, 12 * s, 0, 0, Math.PI * 2);
  ctx.ellipse(x + 18 * s, y + 4 * s, 22 * s, 14 * s, 0, 0, Math.PI * 2);
  ctx.ellipse(x - 18 * s, y + 6 * s, 20 * s, 12 * s, 0, 0, Math.PI * 2);
  ctx.fill();
}

// Decorations: hills
function createHills(count) {
  const arr = [];
  for (let i = 0; i < count; i++) {
    const baseW = 120 + Math.floor(rng() * 220);
    const baseH = 60 + Math.floor(rng() * 120);
    arr.push({
      x: Math.floor(rng() * WORLD_W),
      y: WORLD_H - 2 * TILE + 8,
      w: baseW,
      h: baseH,
      shade: rng() * 0.25 + 0.25,
    });
  }
  return arr;
}
function drawHills(cam, W, H) {
  const parallax = 0.65;
  for (const h of hills) {
    const baseX = h.x - cam * parallax;
    // draw wrapped
    for (let k = -1; k <= 1; k++) {
      const x = Math.floor(baseX + k * WORLD_W);
      if (x > -h.w && x < W + h.w) {
        const y = H - (WORLD_H - h.y); // align with ground horizon
        ctx.fillStyle = `rgba(30,170,60,${0.8 - h.shade * 0.4})`;
        ctx.beginPath();
        ctx.ellipse(
          x,
          y,
          h.w,
          h.h,
          0,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    }
  }
}

// Goal flag
function drawGoal(W, H) {
  const baseCol = LEVEL_W - 6;
  const x = baseCol * TILE - camX + TILE * 0.5;
  const groundY = (LEVEL_H - 2) * TILE;
  // pole
  ctx.fillStyle = "#dddddd";
  ctx.fillRect(Math.floor(x), groundY - TILE * 5, 6, TILE * 5);
  // flag
  ctx.fillStyle = "#f59e0b";
  ctx.beginPath();
  ctx.moveTo(Math.floor(x + 6), groundY - TILE * 5 + 8);
  ctx.lineTo(Math.floor(x + 6 + 26), groundY - TILE * 5 + 18);
  ctx.lineTo(Math.floor(x + 6), groundY - TILE * 5 + 28);
  ctx.closePath();
  ctx.fill();
}

// Utils
function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}
function aabb(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

// Initialize entities on first load
resetPlayerToStart();
spawnSwordLine();
