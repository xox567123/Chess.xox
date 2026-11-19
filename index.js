const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
});
const PORT = process.env.PORT || 3000;
const rooms = new Map();
// Ratings are keyed by a browser-generated player ID. This is intentionally in-memory;
// use a database if ratings must survive a server restart or be tamper-proof.
const ratings = new Map();

app.use(express.static(__dirname));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function getRating(playerId) {
  if (!ratings.has(playerId)) ratings.set(playerId, { rating: 800, games: 0 });
  return ratings.get(playerId);
}

function ratingChange(gamesPlayed) {
  if (gamesPlayed < 5) return 50;
  if (gamesPlayed < 10) return 25;
  if (gamesPlayed < 20) return 12;
  return 6;
}

function clockSnapshot(room, now = Date.now()) {
  const clocksMs = { ...room.clocksMs };
  if (room.started && !room.finished && room.turnStartedAt) {
    const side = room.game.turn() === 'w' ? 'white' : 'black';
    clocksMs[side] = Math.max(0, clocksMs[side] - (now - room.turnStartedAt));
  }
  return clocksMs;
}

function getState(room, side) {
  const board = room.game.board();
  const pieces = [];
  board.forEach((rank, row) => rank.forEach((piece, col) => {
    if (piece) pieces.push({
      square: `${'abcdefgh'[col]}${8 - row}`,
      color: piece.color === 'w' ? 'white' : 'black',
      type: piece.type
    });
  }));
  const color = side === 'white' ? 'w' : 'b';
  const legalMoves = room.game.turn() === color
    ? room.game.moves({ verbose: true }).map(move => ({ from: move.from, to: move.to, promotion: move.promotion || null }))
    : [];
  const history = room.game.history({ verbose: true });
  const lastMove = history.length ? { from: history[history.length - 1].from, to: history[history.length - 1].to } : null;
  return {
    code: room.code,
    side,
    pieces,
    legalMoves,
    turn: room.game.turn() === 'w' ? 'white' : 'black',
    check: room.game.isCheck(),
    lastMove,
    opponentConnected: Boolean(room.players[side === 'white' ? 'black' : 'white']),
    clockSeconds: room.clockSeconds,
    clocksMs: clockSnapshot(room),
    clockRunning: room.started && !room.finished
  };
}

function sendStates(room) {
  for (const side of ['white', 'black']) {
    const id = room.players[side];
    if (id) io.to(id).emit('game:state', getState(room, side));
  }
}

function finishGame(room, winner, reason) {
  if (!room || room.finished) return;
  room.finished = true;
  if (room.clockInterval) clearInterval(room.clockInterval);
  room.clockInterval = null;
  rooms.delete(room.code);

  const whitePlayer = room.playerIds.white;
  const blackPlayer = room.playerIds.black;
  const whiteStats = getRating(whitePlayer);
  const blackStats = getRating(blackPlayer);
  if (winner) {
    const winnerStats = winner === 'white' ? whiteStats : blackStats;
    const loserStats = winner === 'white' ? blackStats : whiteStats;
    winnerStats.rating += ratingChange(winnerStats.games);
    loserStats.rating = Math.max(0, loserStats.rating - ratingChange(loserStats.games));
  }
  whiteStats.games += 1;
  blackStats.games += 1;

  const winnerRating = winner === 'white' ? whiteStats.rating : winner === 'black' ? blackStats.rating : null;
  const winnerName = winner ? `${winner[0].toUpperCase()}${winner.slice(1)}` : null;
  for (const side of ['white', 'black']) {
    const id = room.players[side];
    if (!id) continue;
    const ownStats = side === 'white' ? whiteStats : blackStats;
    const message = winner
      ? `${winnerName} wins ${reason}. ${winnerName} Elo: ${winnerRating} · Your Elo: ${ownStats.rating}`
      : `Draw. Your Elo: ${ownStats.rating}`;
    io.to(id).emit('game:over', {
      winner,
      reason,
      message,
      ownRating: ownStats.rating,
      winnerRating,
      gamesPlayed: ownStats.games
    });
  }
}

function updateClock(room, now = Date.now()) {
  if (!room.started || room.finished || !room.turnStartedAt) return false;
  const side = room.game.turn() === 'w' ? 'white' : 'black';
  room.clocksMs[side] -= now - room.turnStartedAt;
  room.turnStartedAt = now;
  if (room.clocksMs[side] <= 0) {
    room.clocksMs[side] = 0;
    finishGame(room, side === 'white' ? 'black' : 'white', 'on time');
    return true;
  }
  return false;
}

function leaveGame(socket, notify = true) {
  const code = socket.data.roomCode;
  const side = socket.data.side;
  if (!code || !side) return;
  const room = rooms.get(code);
  socket.data.roomCode = null;
  socket.data.side = null;
  if (!room || room.players[side] !== socket.id) return;

  room.players[side] = null;
  socket.leave(code);
  const otherSide = side === 'white' ? 'black' : 'white';
  const other = room.players[otherSide];
  if (notify && room.started && other) {
    finishGame(room, otherSide, 'because the opponent disconnected');
    return;
  }
  if (notify && other) io.to(other).emit('opponent:left');
  if (!room.players.white && !room.players.black) {
    if (room.clockInterval) clearInterval(room.clockInterval);
    rooms.delete(code);
  } else {
    sendStates(room);
  }
}

io.on('connection', socket => {
  socket.data.roomCode = null;
  socket.data.side = null;

  socket.on('game:create', (payload = {}, reply = () => {}) => {
    if (socket.data.roomCode) leaveGame(socket);
    const playerId = String(payload.playerId || '').slice(0, 80);
    const seconds = Number(payload.clockSeconds);
    if (!playerId) return reply({ ok: false, error: 'Could not identify your player profile. Refresh and try again.' });
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3600) return reply({ ok: false, error: 'Choose a clock between 1 and 60 minutes.' });
    const code = makeCode();
    const room = {
      code,
      game: new Chess(),
      players: { white: socket.id, black: null },
      playerIds: { white: playerId, black: null },
      clockSeconds: seconds,
      clocksMs: { white: seconds * 1000, black: seconds * 1000 },
      started: false,
      finished: false,
      turnStartedAt: null,
      clockInterval: null
    };
    getRating(playerId);
    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.data.side = 'white';
    socket.join(code);
    reply({ ok: true, code, side: 'white', clockSeconds: seconds });
    sendStates(room);
  });

  socket.on('game:join', (payload, reply = () => {}) => {
    const rawCode = typeof payload === 'string' ? payload : payload && payload.code;
    const playerId = String((payload && payload.playerId) || '').slice(0, 80);
    const code = String(rawCode || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return reply({ ok: false, error: 'That game code was not found. Ask the host for a new code.' });
    if (!playerId) return reply({ ok: false, error: 'Could not identify your player profile. Refresh and try again.' });
    const side = !room.players.white ? 'white' : !room.players.black ? 'black' : null;
    if (!side) return reply({ ok: false, error: 'That game already has two players.' });
    if (socket.data.roomCode) leaveGame(socket);
    room.players[side] = socket.id;
    room.playerIds[side] = playerId;
    getRating(playerId);
    socket.data.roomCode = code;
    socket.data.side = side;
    socket.join(code);
    if (room.players.white && room.players.black && !room.started) {
      room.started = true;
      room.turnStartedAt = Date.now();
      room.clockInterval = setInterval(() => {
        if (updateClock(room)) return;
        io.to(room.code).emit('game:clock', {
          clocksMs: clockSnapshot(room),
          turn: room.game.turn() === 'w' ? 'white' : 'black'
        });
      }, 1000);
    }
    reply({ ok: true, code, side, clockSeconds: room.clockSeconds });
    sendStates(room);
  });

  socket.on('game:move', (move, reply = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    const side = socket.data.side;
    if (!room || !side || room.finished) return reply({ ok: false, error: 'You are not in an active game.' });
    if (!room.started) return reply({ ok: false, error: 'The clock and game start when both players join.' });
    if (updateClock(room)) return reply({ ok: false, error: 'Your clock ran out.' });
    const expectedColor = side === 'white' ? 'w' : 'b';
    if (room.game.turn() !== expectedColor) return reply({ ok: false, error: 'It is not your turn.' });

    try {
      const result = room.game.move({
        from: String(move && move.from || ''),
        to: String(move && move.to || ''),
        promotion: String(move && move.promotion || 'q').toLowerCase()
      });
      if (!result) return reply({ ok: false, error: 'That move is not legal.' });
      room.turnStartedAt = Date.now();
      reply({ ok: true });
      if (room.game.isCheckmate()) {
        const winner = room.game.turn() === 'w' ? 'black' : 'white';
        finishGame(room, winner, 'by checkmate');
        return;
      }
      if (room.game.isDraw()) {
        finishGame(room, null, 'by draw');
        return;
      }
      sendStates(room);
    } catch (_error) {
      reply({ ok: false, error: 'That move is not legal.' });
    }
  });

  socket.on('game:exit', () => leaveGame(socket));
  socket.on('disconnect', () => leaveGame(socket));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Chess server listening on port ${PORT}`);
});
