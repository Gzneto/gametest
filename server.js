// Simple multiplayer element-combining game server
// Uses Express and Socket.io for real-time communication

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const fetch = require('node-fetch');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server);

// In-memory game state. Not suitable for production but fine for local play.
const lobbies = {}; // { roomCode: { players: [], currentRound: 0, roundType: 'standard', pending: [] } }

// Basic element pool. Feel free to add more!
const ELEMENTS = ['Fire', 'Water', 'Earth', 'Air', 'Lightning', 'Ice', 'Metal', 'Nature', 'Shadow', 'Light'];

// Helper to grab random elements from the pool
function randomElements(count = 3) {
  const copy = [...ELEMENTS];
  const result = [];
  for (let i = 0; i < count && copy.length; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy.splice(idx, 1)[0]);
  }
  return result;
}

// When only one human is present we create a quick AI opponent
function createAIPlayer(room) {
  const elements = [randomElements(1)[0], randomElements(1)[0]];
  room.pending.push({
    playerId: 'AI',
    name: 'AI Bot',
    elements,
    description: `AI uses ${elements.join(' and ')}`,
    imageUrl: '',
    power: Math.floor(Math.random() * 101)
  });
}

// Optionally evaluate abilities using OpenAI. Falls back to random numbers.
async function evaluateAbilities(a, b) {
  if (process.env.OPENAI_API_KEY) {
    try {
      const prompt = `Which ability would win?\nA: ${a.description}\nB: ${b.description}\nRespond with A or B.`;
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const data = await response.json();
      const answer = data.choices?.[0]?.message?.content?.trim();
      a.power = Math.floor(Math.random() * 101);
      b.power = Math.floor(Math.random() * 101);
      if (answer === 'A') a.power = b.power + 1; // ensure A wins
      if (answer === 'B') b.power = a.power + 1; // ensure B wins
      return [a, b];
    } catch (err) {
      console.error('OpenAI API error', err);
    }
  }
  // Fallback random evaluation
  a.power = Math.floor(Math.random() * 101);
  b.power = Math.floor(Math.random() * 101);
  return [a, b];
}

function startRound(roomCode) {
  const room = lobbies[roomCode];
  if (!room) return;
  room.currentRound++;
  room.pending = [];
  // Decide round type
  const rand = Math.random();
  let type = 'standard';
  let sets = [randomElements(), randomElements()];
  if (rand < 0.33) {
    type = 'missing';
    sets = [randomElements()];
  } else if (rand < 0.66) {
    type = 'evolution';
    sets = [randomElements(), randomElements(), randomElements()];
  }
  room.roundType = type;
  io.to(roomCode).emit('roundStart', {
    round: room.currentRound,
    type,
    sets,
    scores: room.players.map(p => ({ name: p.name, score: p.score }))
  });
}

io.on('connection', socket => {
  // Player creates a new lobby
  socket.on('createRoom', ({ username }) => {
    try {
      const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
      lobbies[roomCode] = {
        players: [{ id: socket.id, name: username, score: 0 }],
        currentRound: 0,
        roundType: 'standard',
        pending: []
      };
      socket.join(roomCode);
      socket.emit('roomCreated', { roomCode });
    } catch (err) {
      console.error('createRoom error', err);
      socket.emit('errorMessage', 'Could not create room');
    }
  });

  // Join an existing lobby
  socket.on('joinRoom', ({ username, roomCode }) => {
    try {
      const room = lobbies[roomCode];
      if (!room) return socket.emit('errorMessage', 'Room not found');
      room.players.push({ id: socket.id, name: username, score: 0 });
      socket.join(roomCode);
      io.to(roomCode).emit('roomJoined', { players: room.players });
    } catch (err) {
      console.error('joinRoom error', err);
      socket.emit('errorMessage', 'Could not join room');
    }
  });

  // Host starts the game
  socket.on('startGame', ({ roomCode }) => {
    startRound(roomCode);
  });

  // Players submit their element choices and ability
  socket.on('playerChoice', async ({ roomCode, elements, description, imageUrl }) => {
    try {
      const room = lobbies[roomCode];
      if (!room) return;
      if (room.roundType === 'missing') {
        // server fills the missing element
        elements.push(randomElements(1)[0]);
      }
      room.pending.push({
        playerId: socket.id,
        name: room.players.find(p => p.id === socket.id)?.name || 'Unknown',
        elements,
        description,
        imageUrl,
        power: 0
      });

      // If we have only one human player, spawn an AI opponent
      if (room.players.length === 1 && room.pending.length === 1) {
        createAIPlayer(room);
      }

      // Once we have two abilities, evaluate the battle
      if (room.pending.length >= 2) {
        const [a, b] = await evaluateAbilities(room.pending[0], room.pending[1]);
        let winner = 'tie';
        if (a.power > b.power) winner = a.playerId;
        if (b.power > a.power) winner = b.playerId;
        if (winner !== 'tie') {
          const w = room.players.find(p => p.id === winner);
          if (w) w.score++;
        }
        io.to(roomCode).emit('battleResult', {
          round: room.currentRound,
          winner,
          abilities: [a, b],
          scores: room.players.map(p => ({ name: p.name, score: p.score })),
          narrative: `${a.name} (${a.elements.join(' + ')}) vs ${b.name} (${b.elements.join(' + ')})`
        });
      }
    } catch (err) {
      console.error('playerChoice error', err);
      socket.emit('errorMessage', 'Problem submitting choice');
    }
  });

  // Request the next round
  socket.on('requestNextRound', ({ roomCode }) => {
    try {
      const room = lobbies[roomCode];
      if (!room) return;
      if (room.currentRound >= 5) {
        io.to(roomCode).emit('gameOver', {
          scores: room.players.map(p => ({ name: p.name, score: p.score }))
        });
        delete lobbies[roomCode];
      } else {
        startRound(roomCode);
      }
    } catch (err) {
      console.error('requestNextRound error', err);
    }
  });

  // Clean up on disconnect
  socket.on('disconnect', () => {
    for (const code of Object.keys(lobbies)) {
      const room = lobbies[code];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        io.to(code).emit('playerLeft', { id: socket.id });
        if (room.players.length === 0) {
          delete lobbies[code];
        } else if (room.players.length === 1) {
          // Remaining player will fight AI
          createAIPlayer(room);
        }
        break;
      }
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
