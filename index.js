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
    opponentConnected: Boolean(room.players[side === 'white' ? 'black' : 'white'])
  };
}

function sendStates(room) {
  for (const side of ['white', 'black']) {
    const id = room.players[side];
    if (id) io.to(id).emit('game:state', getState(room, side));
  }
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
  if (notify) {
    const other = room.players[side === 'white' ? 'black' : 'white'];
    if (other) io.to(other).emit('opponent:left');
  }
  if (!room.players.white && !room.players.black) rooms.delete(code);
  else sendStates(room);
}

io.on('connection', socket => {
  socket.data.roomCode = null;
  socket.data.side = null;

  socket.on('game:create', (_payload, reply = () => {}) => {
    if (socket.data.roomCode) leaveGame(socket);
    const code = makeCode();
    const room = { code, game: new Chess(), players: { white: socket.id, black: null } };
    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.data.side = 'white';
    socket.join(code);
    reply({ ok: true, code, side: 'white' });
    sendStates(room);
  });

  socket.on('game:join', (rawCode, reply = () => {}) => {
    const code = String(rawCode || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return reply({ ok: false, error: 'That game code was not found. Ask the host for a new code.' });
    const side = !room.players.white ? 'white' : !room.players.black ? 'black' : null;
    if (!side) return reply({ ok: false, error: 'That game already has two players.' });
    if (socket.data.roomCode) leaveGame(socket);
    room.players[side] = socket.id;
    socket.data.roomCode = code;
    socket.data.side = side;
    socket.join(code);
    reply({ ok: true, code, side });
    sendStates(room);
  });

  socket.on('game:move', (move, reply = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    const side = socket.data.side;
    if (!room || !side) return reply({ ok: false, error: 'You are not in a game.' });
    const expectedColor = side === 'white' ? 'w' : 'b';
    if (room.game.turn() !== expectedColor) return reply({ ok: false, error: 'It is not your turn.' });

    try {
      const result = room.game.move({
        from: String(move && move.from || ''),
        to: String(move && move.to || ''),
        promotion: String(move && move.promotion || 'q').toLowerCase()
      });
      if (!result) return reply({ ok: false, error: 'That move is not legal.' });
      reply({ ok: true });
      if (room.game.isCheckmate()) {
        const winner = room.game.turn() === 'w' ? 'black' : 'white';
        io.to(room.code).emit('game:over', { winner, message: `${winner === 'white' ? 'White' : 'Black'} wins by checkmate!` });
        rooms.delete(room.code);
        return;
      }
      if (room.game.isDraw()) {
        io.to(room.code).emit('game:over', { winner: null, message: 'The game is a draw.' });
        rooms.delete(room.code);
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
