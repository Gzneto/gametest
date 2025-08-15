// Client side logic for Element Battle

const socket = io();

const lobbyDiv = document.getElementById('lobby');
const gameDiv = document.getElementById('game');
const usernameInput = document.getElementById('username');
const roomCodeInput = document.getElementById('roomCode');
const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');
const elementsDiv = document.getElementById('elements');
const submitBtn = document.getElementById('submitChoice');
const abilityDesc = document.getElementById('abilityDesc');
const imageUrlInput = document.getElementById('imageUrl');
const roundInfo = document.getElementById('roundInfo');
const resultsDiv = document.getElementById('results');
const scoreboardDiv = document.getElementById('scoreboard');
const nextRoundBtn = document.getElementById('nextRound');

let roomCode = null;
let currentSets = [];
let selected = [];

createBtn.onclick = () => {
  const username = usernameInput.value.trim();
  if (!username) return alert('Enter username');
  socket.emit('createRoom', { username });
};

joinBtn.onclick = () => {
  const username = usernameInput.value.trim();
  const code = roomCodeInput.value.trim();
  if (!username || !code) return alert('Enter username and room code');
  socket.emit('joinRoom', { username, roomCode: code });
};

socket.on('roomCreated', data => {
  roomCode = data.roomCode;
  lobbyDiv.innerHTML = `Room code: ${roomCode}. Waiting for others...<button id="startBtn">Start</button>`;
  document.getElementById('startBtn').onclick = () => {
    socket.emit('startGame', { roomCode });
  };
});

socket.on('roomJoined', data => {
  roomCode = roomCodeInput.value.trim() || roomCode;
  lobbyDiv.classList.add('hidden');
  gameDiv.classList.remove('hidden');
});

socket.on('errorMessage', msg => alert(msg));

function renderSets(sets) {
  elementsDiv.innerHTML = '';
  selected = Array(sets.length).fill(null);
  sets.forEach((set, index) => {
    const row = document.createElement('div');
    row.className = 'elements';
    set.forEach(el => {
      const card = document.createElement('div');
      card.className = 'card';
      card.textContent = el;
      card.onclick = () => {
        Array.from(row.children).forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        selected[index] = el;
      };
      row.appendChild(card);
    });
    elementsDiv.appendChild(row);
  });
}

socket.on('roundStart', data => {
  currentSets = data.sets;
  renderSets(currentSets);
  roundInfo.textContent = `Round ${data.round} (${data.type})`;
  resultsDiv.innerHTML = '';
  nextRoundBtn.classList.add('hidden');
  updateScoreboard(data.scores);
});

function updateScoreboard(scores) {
  scoreboardDiv.innerHTML = scores.map(s => `${s.name}: ${s.score}`).join(' | ');
}

submitBtn.onclick = () => {
  if (selected.includes(null)) return alert('Select an element for each row');
  const desc = abilityDesc.value.trim();
  socket.emit('playerChoice', {
    roomCode,
    elements: selected,
    description: desc,
    imageUrl: imageUrlInput.value.trim()
  });
};

socket.on('battleResult', data => {
  const [a, b] = data.abilities;
  let text = `${a.name} (${a.power}) vs ${b.name} (${b.power})\n`;
  if (data.winner === 'tie') text += "It's a tie!";
  else {
    const winnerName = data.abilities.find(ab => ab.playerId === data.winner)?.name;
    text += `${winnerName} wins!`;
  }
  resultsDiv.textContent = text;
  updateScoreboard(data.scores);
  nextRoundBtn.classList.remove('hidden');
});

nextRoundBtn.onclick = () => {
  abilityDesc.value = '';
  imageUrlInput.value = '';
  socket.emit('requestNextRound', { roomCode });
};

socket.on('gameOver', data => {
  updateScoreboard(data.scores);
  resultsDiv.textContent = 'Game Over!';
  nextRoundBtn.classList.add('hidden');
  lobbyDiv.classList.remove('hidden');
  gameDiv.classList.add('hidden');
});
