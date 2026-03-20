const { Room } = require('colyseus');

// ═══════════════════════════════════════════════
// PHYSICS CONSTANTS — must match client exactly
// ═══════════════════════════════════════════════
const DISC_FRIC = 0.978;
const BALL_FRIC = 0.983;
const REST      = 0.78;
const BALL_REST = 0.82;
const DISC_MASS = 3.0;
const BALL_MASS = 1.0;
const WIN_SCORE = 3;
const TURN_SEC  = 30;
const MAX_SPEED = 10;

// Fixed physics world — independent of client screen size
const PW  = 600;
const PH  = 340;
const PGH = PH * 0.42;
const PGY1 = (PH - PGH) / 2;
const PGY2 = PGY1 + PGH;
const PGD = PW * 0.048;
const PFL = PGD;
const PFR = PW - PGD;
const DISC_R = PH * 0.085;
const BALL_R = PH * 0.046;

// ═══════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════
function mkDisc(x, y, own) {
  return { x, y, vx: 0, vy: 0, r: DISC_R, mass: DISC_MASS, own };
}

function mv(o) {
  return Math.abs(o.vx) > 0.005 || Math.abs(o.vy) > 0.005;
}

function wallD(d) {
  if (d.y - d.r < 0)   { d.y = d.r;      d.vy =  Math.abs(d.vy) * REST; }
  if (d.y + d.r > PH)  { d.y = PH - d.r; d.vy = -Math.abs(d.vy) * REST; }
  if (d.x - d.r < PFL) { d.x = PFL + d.r; d.vx =  Math.abs(d.vx) * REST; }
  if (d.x + d.r > PFR) { d.x = PFR - d.r; d.vx = -Math.abs(d.vx) * REST; }
}

function wallB(b) {
  if (b.y - b.r < 0)  { b.y = b.r;      b.vy =  Math.abs(b.vy) * BALL_REST; }
  if (b.y + b.r > PH) { b.y = PH - b.r; b.vy = -Math.abs(b.vy) * BALL_REST; }
  if (b.x - b.r < PFL && (b.y < PGY1 || b.y > PGY2)) {
    b.x = PFL + b.r; b.vx = Math.abs(b.vx) * BALL_REST;
  }
  if (b.x + b.r > PFR && (b.y < PGY1 || b.y > PGY2)) {
    b.x = PFR - b.r; b.vx = -Math.abs(b.vx) * BALL_REST;
  }
}

function collide(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.sqrt(dx*dx + dy*dy);
  const mn = a.r + b.r;
  if (dist >= mn || dist < 0.01) return;

  const nx = dx / dist, ny = dy / dist;
  const ov = mn - dist;
  const ma = a.mass, mb = b.mass, mt = ma + mb;

  a.x -= nx * ov * (mb/mt) * 1.05;
  a.y -= ny * ov * (mb/mt) * 1.05;
  b.x += nx * ov * (ma/mt) * 1.05;
  b.y += ny * ov * (ma/mt) * 1.05;

  const dvx = b.vx - a.vx, dvy = b.vy - a.vy;
  const vn = dvx*nx + dvy*ny;
  if (vn >= 0) return;

  const imp = Math.min(-(1 + REST) * vn / (1/ma + 1/mb), MAX_SPEED * mt * 1.5);

  a.vx -= imp/ma * nx; a.vy -= imp/ma * ny;
  b.vx += imp/mb * nx; b.vy += imp/mb * ny;

  [a, b].forEach(o => {
    const sp = Math.sqrt(o.vx*o.vx + o.vy*o.vy);
    if (sp > MAX_SPEED) { o.vx = o.vx/sp * MAX_SPEED; o.vy = o.vy/sp * MAX_SPEED; }
  });
}

function initPositions() {
  const dr = DISC_R;
  const PD = [
    mkDisc(PFL + dr*1.4,   PH*0.50, 'p'),
    mkDisc(PFL + PW*0.13,  PH*0.27, 'p'),
    mkDisc(PFL + PW*0.13,  PH*0.73, 'p'),
    mkDisc(PFL + PW*0.29,  PH*0.34, 'p'),
    mkDisc(PFL + PW*0.29,  PH*0.66, 'p'),
  ];
  const OD = [
    mkDisc(PFR - dr*1.4,   PH*0.50, 'o'),
    mkDisc(PFR - PW*0.13,  PH*0.27, 'o'),
    mkDisc(PFR - PW*0.13,  PH*0.73, 'o'),
    mkDisc(PFR - PW*0.29,  PH*0.34, 'o'),
    mkDisc(PFR - PW*0.29,  PH*0.66, 'o'),
  ];
  const ball = { x: PW/2, y: PH/2, vx: 0, vy: 0, r: BALL_R, mass: BALL_MASS };
  return { PD, OD, ball };
}

// ═══════════════════════════════════════════════
// KRON ROOM
// ═══════════════════════════════════════════════
class KronRoom extends Room {

  onCreate(options) {
    this.maxClients = 2;
    this.gameState  = null;  // physics state — server only
    this.players    = {};    // sessionId -> role ('host'|'guest')
    this.physicsRunning = false;

    // Client move message — input ONLY: discIdx + vx + vy
    this.onMessage('move', (client, data) => {
      if (!this.gameState || this.gameState.turn === 'wait') return;
      const role = this.players[client.sessionId];
      if (!role) return;

      // Turn check
      const myTurn = role === 'host' ? 'p' : 'o';
      if (this.gameState.turn !== myTurn) return;

      // Get disc
      const arr = role === 'host' ? this.gameState.PD : this.gameState.OD;
      const disc = arr[data.discIdx];
      if (!disc) return;

      // Validate speed
      const speed = Math.sqrt(data.vx*data.vx + data.vy*data.vy);
      if (!isFinite(speed) || speed < 0.05 || speed > MAX_SPEED * 1.05) return;

      disc.vx = data.vx;
      disc.vy = data.vy;
      this.gameState.turn = 'wait';
      this.gameState.lastT = myTurn;

      // Broadcast: move applied
      this.broadcast('move_applied', { role, discIdx: data.discIdx, vx: data.vx, vy: data.vy });
    });

    // Client timeout pass
    this.onMessage('pass', (client, data) => {
      const role = this.players[client.sessionId];
      const myTurn = role === 'host' ? 'p' : 'o';
      if (this.gameState && this.gameState.turn === myTurn) {
        this.gameState.turn = 'wait';
        this.gameState.lastT = myTurn;
        this.broadcast('move_applied', { role, discIdx: -1, vx: 0, vy: 0 });
      }
    });

    // Physics loop: 60fps
    this.setSimulationInterval((dt) => this.physicsUpdate(dt), 1000/60);

    console.log('KronRoom created');
  }

  onJoin(client, options) {
    const playerCount = Object.keys(this.players).length;
    const role = playerCount === 0 ? 'host' : 'guest';
    this.players[client.sessionId] = role;
    client.send('role', { role });
    console.log(`${client.sessionId} joined as ${role}`);

    // Two players ready — start game
    if (Object.keys(this.players).length === 2) {
      this.startGame();
    }
  }

  onLeave(client, consented) {
    const role = this.players[client.sessionId];
    delete this.players[client.sessionId];
    // Notify opponent
    this.broadcast('opponent_left', { role });
    this.physicsRunning = false;
    console.log(`${client.sessionId} (${role}) left`);
  }

  startGame() {
    const pos = initPositions();
    this.gameState = {
      PD: pos.PD,
      OD: pos.OD,
      ball: pos.ball,
      score: { p: 0, o: 0 },
      turn: 'p',
      lastT: 'p',
      glock: false,
      goalTimer: 0,
      goalKickTeam: null,
    };
    this.physicsRunning = true;

    // Send initial state
    this.broadcastState('start');
    console.log('Game started');
  }

  physicsUpdate(dt) {
    if (!this.physicsRunning || !this.gameState) return;
    const gs = this.gameState;

    // Waiting for goal animation
    if (gs.glock) {
      gs.goalTimer -= dt;
      if (gs.goalTimer <= 0) {
        // Reset
        const pos = initPositions();
        gs.PD   = pos.PD;
        gs.OD   = pos.OD;
        gs.ball = pos.ball;
        gs.glock = false;
        gs.turn  = gs.goalKickTeam;
        gs.lastT = gs.goalKickTeam;
        gs.goalKickTeam = null;

        // Game over?
        if (gs.score.p >= WIN_SCORE || gs.score.o >= WIN_SCORE) {
          this.broadcastState('gameover');
          this.physicsRunning = false;
          return;
        }

        this.broadcastState('goal_reset');
      }
      return;
    }

    if (gs.turn !== 'wait') return; // waiting for move

    // ── Physics step ──────────────────────────
    let anyMov = false;

    // Discs
    const allDiscs = gs.PD.concat(gs.OD);
    for (let i = 0; i < allDiscs.length; i++) {
      const d = allDiscs[i];
      d.x += d.vx; d.y += d.vy;
      d.vx *= DISC_FRIC; d.vy *= DISC_FRIC;
      if (Math.abs(d.vx) < 0.005) d.vx = 0;
      if (Math.abs(d.vy) < 0.005) d.vy = 0;
      wallD(d);
      if (mv(d)) anyMov = true; else { d.vx = 0; d.vy = 0; }
    }

    // Ball
    gs.ball.x += gs.ball.vx; gs.ball.y += gs.ball.vy;
    gs.ball.vx *= BALL_FRIC; gs.ball.vy *= BALL_FRIC;
    if (Math.abs(gs.ball.vx) < 0.005) gs.ball.vx = 0;
    if (Math.abs(gs.ball.vy) < 0.005) gs.ball.vy = 0;
    wallB(gs.ball);
    if (mv(gs.ball)) anyMov = true; else { gs.ball.vx = 0; gs.ball.vy = 0; }

    // Collision — fixed order
    const all = allDiscs.concat([gs.ball]);
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < all.length - 1; i++) {
        for (let j = i + 1; j < all.length; j++) {
          collide(all[i], all[j]);
        }
      }
    }

    // Goal check
    const b = gs.ball;
    if (b.x - b.r <= PGD*0.25 && b.y > PGY1 && b.y < PGY2) {
      // Left goal — team o scored (host's goal)
      gs.score.o++;
      gs.glock = true;
      gs.goalTimer = 1200; // wait 1.2 seconds
      gs.goalKickTeam = 'p'; // team that conceded starts
      b.vx = 0; b.vy = 0;
      allDiscs.forEach(d => { d.vx = 0; d.vy = 0; });
      this.broadcastState('goal');
      return;
    }
    if (b.x + b.r >= PW - PGD*0.25 && b.y > PGY1 && b.y < PGY2) {
      // Right goal — team p scored (guest's goal)
      gs.score.p++;
      gs.glock = true;
      gs.goalTimer = 1200;
      gs.goalKickTeam = 'o';
      b.vx = 0; b.vy = 0;
      allDiscs.forEach(d => { d.vx = 0; d.vy = 0; });
      this.broadcastState('goal');
      return;
    }

    // Movement stopped — switch turn
    if (!anyMov) {
      gs.turn = gs.lastT === 'p' ? 'o' : 'p';
      gs.lastT = gs.turn;
      this.broadcastState('turn_change');
    } else {
      // State sent during movement (every 50ms — handled by Colyseus)
    }
  }

  // Send state as ratio (0-1) — screen independent
  broadcastState(reason) {
    if (!this.gameState) return;
    const gs = this.gameState;
    this.broadcast('state', {
      pd:    gs.PD.map(d => [+(d.x/PW).toFixed(4), +(d.y/PH).toFixed(4)]),
      od:    gs.OD.map(d => [+(d.x/PW).toFixed(4), +(d.y/PH).toFixed(4)]),
      bx:    +(gs.ball.x/PW).toFixed(4),
      by:    +(gs.ball.y/PH).toFixed(4),
      score: gs.score,
      turn:  gs.turn,
      lastT: gs.lastT,
      reason
    });
  }

  // Send position to client during physics (every 50ms)
  // Colyseus setSimulationInterval handles this but
  // instead of calling broadcast inside physicsUpdate
  // we can use setPatchRate for regular state push.
  // For now, broadcast on move+goal events is sufficient.
}

module.exports = { KronRoom };
