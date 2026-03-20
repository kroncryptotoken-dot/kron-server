const { Room } = require('colyseus');

// PHYSICS CONSTANTS
const DISC_FRIC = 0.978;
const BALL_FRIC = 0.983;
const REST      = 0.78;
const BALL_REST = 0.82;
const DISC_MASS = 3.0;
const BALL_MASS = 1.0;
const WIN_SCORE = 3;
const MAX_SPEED = 10;

// Fixed physics world
const PW   = 600;
const PH   = 340;
const PGH  = PH * 0.42;
const PGY1 = (PH - PGH) / 2;
const PGY2 = PGY1 + PGH;
const PGD  = PW * 0.048;
const PFL  = PGD;
const PFR  = PW - PGD;
const DR   = PH * 0.085;
const BR   = PH * 0.046;

function mkDisc(x, y, own) {
  return { x, y, vx: 0, vy: 0, r: DR, mass: DISC_MASS, own };
}

function moving(o) {
  return Math.abs(o.vx) > 0.005 || Math.abs(o.vy) > 0.005;
}

function wallDisc(d) {
  if (d.y - d.r < 0)   { d.y = d.r;       d.vy =  Math.abs(d.vy) * REST; }
  if (d.y + d.r > PH)  { d.y = PH - d.r;  d.vy = -Math.abs(d.vy) * REST; }
  if (d.x - d.r < PFL) { d.x = PFL + d.r; d.vx =  Math.abs(d.vx) * REST; }
  if (d.x + d.r > PFR) { d.x = PFR - d.r; d.vx = -Math.abs(d.vx) * REST; }
}

function wallBall(b) {
  if (b.y - b.r < 0)   { b.y = b.r;       b.vy =  Math.abs(b.vy) * BALL_REST; }
  if (b.y + b.r > PH)  { b.y = PH - b.r;  b.vy = -Math.abs(b.vy) * BALL_REST; }
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
  const minDist = a.r + b.r;
  if (dist >= minDist || dist < 0.01) return;
  const nx = dx / dist, ny = dy / dist;
  const overlap = minDist - dist;
  const ma = a.mass, mb = b.mass, mt = ma + mb;
  a.x -= nx * overlap * (mb/mt) * 1.05;
  a.y -= ny * overlap * (mb/mt) * 1.05;
  b.x += nx * overlap * (ma/mt) * 1.05;
  b.y += ny * overlap * (ma/mt) * 1.05;
  const dvx = b.vx - a.vx, dvy = b.vy - a.vy;
  const vDotN = dvx*nx + dvy*ny;
  if (vDotN >= 0) return;
  const imp = Math.min(-(1 + REST) * vDotN / (1/ma + 1/mb), MAX_SPEED * mt * 1.5);
  a.vx -= imp/ma * nx; a.vy -= imp/ma * ny;
  b.vx += imp/mb * nx; b.vy += imp/mb * ny;
  [a, b].forEach(o => {
    const sp = Math.sqrt(o.vx*o.vx + o.vy*o.vy);
    if (sp > MAX_SPEED) { o.vx = o.vx/sp * MAX_SPEED; o.vy = o.vy/sp * MAX_SPEED; }
  });
}

function initPositions() {
  return {
    PD: [
      mkDisc(PFL + DR*1.4,  PH*0.50, 'p'),
      mkDisc(PFL + PW*0.13, PH*0.27, 'p'),
      mkDisc(PFL + PW*0.13, PH*0.73, 'p'),
      mkDisc(PFL + PW*0.29, PH*0.34, 'p'),
      mkDisc(PFL + PW*0.29, PH*0.66, 'p'),
    ],
    OD: [
      mkDisc(PFR - DR*1.4,  PH*0.50, 'o'),
      mkDisc(PFR - PW*0.13, PH*0.27, 'o'),
      mkDisc(PFR - PW*0.13, PH*0.73, 'o'),
      mkDisc(PFR - PW*0.29, PH*0.34, 'o'),
      mkDisc(PFR - PW*0.29, PH*0.66, 'o'),
    ],
    ball: { x: PW/2, y: PH/2, vx: 0, vy: 0, r: BR, mass: BALL_MASS }
  };
}

class KronRoom extends Room {

  onCreate(options) {
    this.maxClients = 2;
    this.seatReservationTime = 30;
    this.gs = null;
    this.roles = {};
    this.tickCount = 0;

    // MOVE: only accept in waiting phase, correct turn, not locked
    this.onMessage('move', (client, data) => {
      if (!this.gs) return;
      if (this.gs.phase !== 'waiting') return;
      if (this.gs.moveLocked) return;

      const role = this.roles[client.sessionId];
      if (!role) return;

      const myTurn = role === 'host' ? 'p' : 'o';
      if (this.gs.turn !== myTurn) return;

      const arr = role === 'host' ? this.gs.PD : this.gs.OD;
      const disc = arr[data.discIdx];
      if (!disc) return;

      const speed = Math.sqrt(data.vx*data.vx + data.vy*data.vy);
      if (!isFinite(speed) || speed < 0.05 || speed > MAX_SPEED * 1.05) return;

      // Lock immediately — no more moves until turn_change
      this.gs.moveLocked = true;
      disc.vx = data.vx;
      disc.vy = data.vy;
      this.gs.phase = 'simulating';
      this.gs.lastT = myTurn;
      console.log(`move accepted from ${role}, speed: ${speed.toFixed(2)}`);
    });

    // PASS: timeout
    this.onMessage('pass', (client) => {
      if (!this.gs || this.gs.phase !== 'waiting') return;
      const role = this.roles[client.sessionId];
      const myTurn = role === 'host' ? 'p' : 'o';
      if (this.gs.turn !== myTurn) return;
      this.gs.moveLocked = true;
      this.gs.phase = 'simulating';
      this.gs.lastT = myTurn;
    });

    // 20fps tick
    this.setSimulationInterval((dt) => this.tick(dt), 50);
    console.log('KronRoom created');
  }

  onJoin(client, options) {
    const count = Object.keys(this.roles).length;
    const role = count === 0 ? 'host' : 'guest';
    this.roles[client.sessionId] = role;
    client.send('role', { role });
    console.log(`${client.sessionId} joined as ${role}`);
    if (Object.keys(this.roles).length === 2) {
      this.startGame();
    }
  }

  onLeave(client) {
    const role = this.roles[client.sessionId];
    delete this.roles[client.sessionId];
    this.broadcast('opponent_left', { role });
    console.log(`${client.sessionId} (${role}) left`);
  }

  startGame() {
    const pos = initPositions();
    this.gs = {
      PD: pos.PD,
      OD: pos.OD,
      ball: pos.ball,
      score: { p: 0, o: 0 },
      turn: 'p',
      lastT: 'p',
      phase: 'waiting',     // waiting | simulating | goal_pause
      moveLocked: false,
      goalPauseTimer: 0,
      goalKickTeam: null,
    };
    this.broadcast('state', this.snapshot('start'));
    console.log('Game started');
  }

  tick(dt) {
    if (!this.gs) return;
    const gs = this.gs;

    // Goal pause countdown
    if (gs.phase === 'goal_pause') {
      gs.goalPauseTimer -= dt;
      if (gs.goalPauseTimer <= 0) {
        if (gs.score.p >= WIN_SCORE || gs.score.o >= WIN_SCORE) {
          this.broadcast('state', this.snapshot('gameover'));
          return;
        }
        const pos = initPositions();
        gs.PD   = pos.PD;
        gs.OD   = pos.OD;
        gs.ball = pos.ball;
        gs.turn = gs.goalKickTeam;
        gs.lastT = gs.goalKickTeam;
        gs.phase = 'waiting';
        gs.moveLocked = false;
        gs.goalKickTeam = null;
        this.broadcast('state', this.snapshot('reset'));
      }
      return;
    }

    // Waiting — send idle tick every 200ms so clients stay synced
    if (gs.phase === 'waiting') {
      this.tickCount++;
      if (this.tickCount % 4 === 0) {
        this.broadcast('state', this.snapshot('idle'));
      }
      return;
    }

    // Simulating physics
    let anyMov = false;
    const allDiscs = gs.PD.concat(gs.OD);

    for (const d of allDiscs) {
      d.x += d.vx; d.y += d.vy;
      d.vx *= DISC_FRIC; d.vy *= DISC_FRIC;
      if (Math.abs(d.vx) < 0.005) d.vx = 0;
      if (Math.abs(d.vy) < 0.005) d.vy = 0;
      wallDisc(d);
      if (moving(d)) anyMov = true; else { d.vx = 0; d.vy = 0; }
    }

    const b = gs.ball;
    b.x += b.vx; b.y += b.vy;
    b.vx *= BALL_FRIC; b.vy *= BALL_FRIC;
    if (Math.abs(b.vx) < 0.005) b.vx = 0;
    if (Math.abs(b.vy) < 0.005) b.vy = 0;
    wallBall(b);
    if (moving(b)) anyMov = true; else { b.vx = 0; b.vy = 0; }

    // Collisions
    const all = allDiscs.concat([b]);
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < all.length - 1; i++) {
        for (let j = i + 1; j < all.length; j++) {
          collide(all[i], all[j]);
        }
      }
    }

    // Goal check
    if (b.x - b.r <= PGD*0.25 && b.y > PGY1 && b.y < PGY2) {
      gs.score.o++;
      gs.phase = 'goal_pause';
      gs.goalPauseTimer = 1500;
      gs.goalKickTeam = 'p';
      allDiscs.forEach(d => { d.vx = 0; d.vy = 0; });
      b.vx = 0; b.vy = 0;
      this.broadcast('state', this.snapshot('goal'));
      return;
    }
    if (b.x + b.r >= PW - PGD*0.25 && b.y > PGY1 && b.y < PGY2) {
      gs.score.p++;
      gs.phase = 'goal_pause';
      gs.goalPauseTimer = 1500;
      gs.goalKickTeam = 'o';
      allDiscs.forEach(d => { d.vx = 0; d.vy = 0; });
      b.vx = 0; b.vy = 0;
      this.broadcast('state', this.snapshot('goal'));
      return;
    }

    // Broadcast tick
    this.broadcast('state', this.snapshot('tick'));

    // Simulation done — switch turn, unlock
    if (!anyMov) {
      gs.turn = gs.lastT === 'p' ? 'o' : 'p';
      gs.lastT = gs.turn;
      gs.phase = 'waiting';
      gs.moveLocked = false;
      console.log('turn changed to:', gs.turn);
      this.broadcast('state', this.snapshot('turn_change'));
    }
  }

  snapshot(reason) {
    const gs = this.gs;
    return {
      pd:    gs.PD.map(d => [+(d.x/PW).toFixed(4), +(d.y/PH).toFixed(4), +(d.vx).toFixed(3), +(d.vy).toFixed(3)]),
      od:    gs.OD.map(d => [+(d.x/PW).toFixed(4), +(d.y/PH).toFixed(4), +(d.vx).toFixed(3), +(d.vy).toFixed(3)]),
      bx:    +(gs.ball.x/PW).toFixed(4),
      by:    +(gs.ball.y/PH).toFixed(4),
      bvx:   +(gs.ball.vx).toFixed(3),
      bvy:   +(gs.ball.vy).toFixed(3),
      score: gs.score,
      turn:  gs.turn,
      phase: gs.phase,
      reason
    };
  }
}

module.exports = { KronRoom };
