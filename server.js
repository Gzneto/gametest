// Simple multiplayer element-combining game server
// Uses Express and Socket.io for real-time communication

require('dotenv').config();
console.log("OpenRouter key present?", !!process.env.OPENROUTER_API_KEY);

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// ✅ Node v18+ has fetch built-in, no need for node-fetch
const fetch = global.fetch;

const app = express();
app.use(cors());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server);

// ------------------ TEST OPENROUTER CONNECTION ------------------
async function openRouterQuickTest() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.log("OpenRouter: missing API key, skipping test.");
    return;
  }
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || "deepseek/deepseek-chat-v3-0324:free",
        messages: [
          { role: "system", content: "You are a concise assistant." },
          { role: "user", content: "Reply with the word PONG." }
        ],
        temperature: 0
      })
    });

    if (!res.ok) {
      console.log("OpenRouter test HTTP error:", res.status, await res.text());
      return;
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || "";
    console.log("OpenRouter test reply:", text);
  } catch (e) {
    console.log("OpenRouter test failed:", e.message);
  }
}
// call once on startup
openRouterQuickTest();

// ------------------ GAME STATE ------------------
const lobbies = {}; // { roomCode: { players: [], currentRound: 0, roundType: 'standard', pending: [] } }

const ELEMENTS = ['Fire', 'Water', 'Earth', 'Air', 'Lightning', 'Ice', 'Metal', 'Nature', 'Shadow', 'Light'];

function randomElements(count = 3) {
  const copy = [...ELEMENTS];
  const result = [];
  for (let i = 0; i < count && copy.length; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy.splice(idx, 1)[0]);
  }
  return result;
}

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

// Optionally evaluate abilities using OpenRouter. Falls back to random numbers.
async function evaluateAbilities(a, b) {
  if (process.env.OPENROUTER_API_KEY) {
    try {
      const prompt = `Which ability would win?\nA: ${a.description}\nB: ${b.description}\nRespond with A or B.`;
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: 'POST',
        headers: {
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: process.env.OPENROUTER_MODEL || "deepseek/deepseek-chat-v3-0324:free",
          messages: [{ role: "user", content: prompt }]
        })
      });

      const data = await response.json();
      const answer = data.choices?.[0]?.message?.content?.trim();
      a.power = Math.floor(Math.random() * 101);
      b.power = Math.floor(Math.random() * 101);
      if (answer === 'A') a.power = b.power + 1;
      if (answer === 'B') b.power = a.power + 1;
      return [a, b];
    } catch (err) {
      console.error('OpenRouter API error', err);
    }
  }
  // fallback random
  a.power = Math.floor(Math.random() * 101);
  b.power = Math.floor(Math.random() * 101);
  return [a, b];
}

function startRound(roomCode) {
  const room = lobbies[roomCode];
  if (!room) return;
  room.currentRound++;
  room.pending = [];
  let type = 'standard';
  let sets = [randomElements(), randomElements()];
  const rand = Math.random();
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

// ------------------ SOCKET LOGIC ------------------
io.on('connection', socket => {
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

  socket.on('startGame', ({ roomCode }) => {
    startRound(roomCode);
  });

  socket.on('playerChoice', async ({ roomCode, elements, description, imageUrl }) => {
    try {
      const room = lobbies[roomCode];
      if (!room) return;
      if (room.roundType === 'missing') {
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

      if (room.players.length === 1 && room.pending.length === 1) {
        createAIPlayer(room);
      }

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
          createAIPlayer(room);
        }
        break;
      }
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
