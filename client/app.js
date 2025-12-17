// Styx 클라이언트 - HADES 실시간 오디오 협업
// WebRTC P2P 오디오 + 메트로놈 + 오디오 레벨 미터

const socket = io({ reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: 10 });
const peers = new Map();
const volumeStates = new Map(); // 볼륨 상태 유지
let localStream = null;
let isMuted = false;
let currentUser = null;
let selectedDeviceId = null;
let latencyInterval = null;
let audioContext = null;
let analyser = null;
let meterInterval = null;
let metronomeInterval = null;
let metronomeAudio = null;

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

const $ = id => document.getElementById(id);
const authPanel = $('auth');
const lobby = $('lobby');
const adminPanel = $('admin-panel');
const roomView = $('room-view');
const usersGrid = $('users-grid');
const chatMessages = $('chat-messages');

// 세션 복구 시도
const savedUser = localStorage.getItem('styx-user');
if (savedUser) {
  socket.emit('restore-session', { username: savedUser }, res => {
    if (res.success) {
      currentUser = res.user;
      showLobby();
    } else {
      localStorage.removeItem('styx-user');
    }
  });
}

// 소켓 재연결 처리
socket.on('connect', () => {
  console.log('서버 연결됨');
  if (currentUser && socket.room) {
    // 방에 있었다면 재입장 시도
    socket.emit('join', { room: socket.room, username: currentUser.username }, res => {
      if (res.error) location.reload();
    });
  }
});

socket.on('disconnect', () => console.log('서버 연결 끊김, 재연결 시도 중...'));
socket.on('kicked', () => { alert('방에서 강퇴되었습니다'); location.reload(); });

// 로그인/회원가입 탭
document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $('login-form').classList.toggle('hidden', tab.dataset.tab !== 'login');
    $('signup-form').classList.toggle('hidden', tab.dataset.tab !== 'signup');
  };
});

// Enter 키 로그인
$('login-user').onkeypress = $('login-pass').onkeypress = (e) => { if (e.key === 'Enter') $('loginBtn').click(); };
$('signup-user').onkeypress = $('signup-pass').onkeypress = (e) => { if (e.key === 'Enter') $('signupBtn').click(); };
$('room-input').onkeypress = (e) => { if (e.key === 'Enter') $('joinRoomBtn').click(); };

// 로그인
$('loginBtn').onclick = () => {
  const username = $('login-user').value.trim();
  const password = $('login-pass').value;
  if (!username || !password) return showAuthMsg('사용자명과 비밀번호를 입력하세요', true);

  socket.emit('login', { username, password }, res => {
    if (res.error) {
      const errorMsg = {
        'User not found': '사용자를 찾을 수 없습니다',
        'Wrong password': '비밀번호가 틀렸습니다',
        'Account pending approval': '승인 대기 중입니다',
        'Invalid username': '잘못된 사용자명입니다'
      }[res.error] || res.error;
      return showAuthMsg(errorMsg, true);
    }
    currentUser = res.user;
    localStorage.setItem('styx-user', username);
    showLobby();
  });
};

// 회원가입
$('signupBtn').onclick = () => {
  const username = $('signup-user').value.trim();
  const password = $('signup-pass').value;
  if (!username || !password) return showAuthMsg('사용자명과 비밀번호를 입력하세요', true);

  socket.emit('signup', { username, password }, res => {
    if (res.error) {
      const errorMsg = {
        'Username taken': '이미 사용 중인 사용자명입니다',
        'Invalid username (2-20자, 영문/숫자/한글/_)': '사용자명: 2-20자, 영문/숫자/한글/_만 가능',
        'Invalid password (4-50자)': '비밀번호: 4-50자'
      }[res.error] || res.error;
      return showAuthMsg(errorMsg, true);
    }
    showAuthMsg('가입 요청 완료. 관리자 승인을 기다려주세요.', false);
  });
};

function showAuthMsg(msg, isError) {
  const el = $('auth-msg');
  el.textContent = msg;
  el.className = isError ? 'error' : 'success';
}

async function showLobby() {
  authPanel.classList.add('hidden');
  lobby.classList.remove('hidden');
  $('my-username').textContent = currentUser.username;
  $('my-avatar').style.backgroundImage = currentUser.avatar ? `url(${currentUser.avatar})` : '';
  if (currentUser.isAdmin) $('adminBtn').classList.remove('hidden');
  
  await loadAudioDevices();
  loadRoomList();
}

$('logoutBtn').onclick = () => {
  localStorage.removeItem('styx-user');
  location.reload();
};

// 오디오 장치 로드 (권한 요청 후 해제)
async function loadAudioDevices() {
  try {
    const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    tempStream.getTracks().forEach(t => t.stop()); // 즉시 해제
    
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');
    
    const select = $('audio-device');
    select.innerHTML = audioInputs.map((d, i) => 
      `<option value="${d.deviceId}">${d.label || '마이크 ' + (i + 1)}</option>`
    ).join('');
    
    selectedDeviceId = audioInputs[0]?.deviceId;
    select.onchange = () => selectedDeviceId = select.value;
  } catch (e) {
    console.error('오디오 장치 접근 거부됨');
  }
}

// 방 목록
function loadRoomList() {
  socket.emit('get-rooms', null, rooms => renderRoomList(rooms));
}

socket.on('room-list', renderRoomList);

function renderRoomList(rooms) {
  const list = $('room-list');
  if (!rooms.length) {
    list.innerHTML = '<p class="no-rooms">활성화된 방이 없습니다</p>';
    return;
  }
  list.innerHTML = rooms.map(r => `
    <div class="room-item" onclick="joinRoom('${r.name.replace(/'/g, "\\'")}', ${r.hasPassword})">
      <span class="room-name">${r.hasPassword ? '🔒 ' : ''}${escapeHtml(r.name)}</span>
      <span class="room-users">${r.userCount}/8 👤</span>
    </div>
  `).join('');
}

// 아바타 업로드
$('avatar-input').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) return alert('이미지 크기는 2MB 이하여야 합니다');
  
  const reader = new FileReader();
  reader.onload = () => {
    socket.emit('upload-avatar', { username: currentUser.username, avatarData: reader.result }, res => {
      if (res.success) {
        currentUser.avatar = res.avatar;
        $('my-avatar').style.backgroundImage = `url(${res.avatar})`;
      } else {
        alert(res.error);
      }
    });
  };
  reader.readAsDataURL(file);
};

// 설정 패널 (비밀번호 변경)
$('settingsBtn').onclick = () => {
  $('settings-panel').classList.remove('hidden');
  lobby.classList.add('hidden');
};

$('closeSettingsBtn').onclick = () => {
  $('settings-panel').classList.add('hidden');
  lobby.classList.remove('hidden');
};

$('changePasswordBtn').onclick = () => {
  const oldPw = $('old-password').value;
  const newPw = $('new-password').value;
  if (!oldPw || !newPw) return alert('비밀번호를 입력하세요');
  
  socket.emit('change-password', { oldPassword: oldPw, newPassword: newPw }, res => {
    if (res.success) {
      alert('비밀번호가 변경되었습니다');
      $('old-password').value = '';
      $('new-password').value = '';
    } else {
      alert(res.error === 'Wrong password' ? '현재 비밀번호가 틀렸습니다' : res.error);
    }
  });
};

// 관리자 패널
$('adminBtn').onclick = () => {
  loadAdminData();
  adminPanel.classList.remove('hidden');
  lobby.classList.add('hidden');
};

function loadAdminData() {
  // 대기 중인 사용자
  socket.emit('get-pending', null, res => {
    const list = $('pending-list');
    list.innerHTML = res.pending.length ? '' : '<p>대기 중인 요청이 없습니다</p>';
    res.pending.forEach(username => {
      const div = document.createElement('div');
      div.className = 'pending-user';
      div.innerHTML = `<span>${escapeHtml(username)}</span>
        <button onclick="approveUser('${username.replace(/'/g, "\\'")}')">✓</button>
        <button onclick="rejectUser('${username.replace(/'/g, "\\'")}')">✗</button>`;
      list.appendChild(div);
    });
  });
  
  // 전체 사용자 목록
  socket.emit('get-users', null, res => {
    const list = $('users-list');
    list.innerHTML = '';
    res.users.forEach(u => {
      const div = document.createElement('div');
      div.className = 'user-item';
      div.innerHTML = `
        <span>${escapeHtml(u.username)} ${u.isAdmin ? '👑' : ''}</span>
        ${!u.isAdmin ? `<button onclick="deleteUser('${u.username.replace(/'/g, "\\'")}')">삭제</button>` : ''}
      `;
      list.appendChild(div);
    });
  });
}

window.approveUser = (username) => socket.emit('approve-user', { username }, () => loadAdminData());
window.rejectUser = (username) => socket.emit('reject-user', { username }, () => loadAdminData());
window.deleteUser = (username) => {
  if (confirm(`${username} 사용자를 삭제하시겠습니까?`)) {
    socket.emit('delete-user', { username }, () => loadAdminData());
  }
};

$('closeAdminBtn').onclick = () => {
  adminPanel.classList.add('hidden');
  lobby.classList.remove('hidden');
};

// 방 입장
window.joinRoom = async (roomName, hasPassword) => {
  const room = roomName || $('room-input').value.trim();
  if (!room) return;

  let roomPassword = $('room-password').value || null;
  if (hasPassword && !roomPassword) {
    roomPassword = prompt('방 비밀번호를 입력하세요:');
    if (!roomPassword) return;
  }

  const audioConstraints = {
    audio: {
      deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      latency: 0
    }
  };

  try {
    localStream = await navigator.mediaDevices.getUserMedia(audioConstraints);
  } catch {
    return alert('마이크 접근이 거부되었습니다');
  }

  socket.emit('join', { room, username: currentUser.username, password: roomPassword }, res => {
    if (res.error) {
      localStream.getTracks().forEach(t => t.stop());
      const errorMsg = {
        'Room full': '방이 가득 찼습니다',
        'Username already in room': '이미 방에 접속 중입니다',
        'Not authorized': '권한이 없습니다',
        'Wrong room password': '방 비밀번호가 틀렸습니다'
      }[res.error] || res.error;
      return alert(errorMsg);
    }

    lobby.classList.add('hidden');
    roomView.classList.remove('hidden');
    $('roomName').textContent = room;
    socket.room = room;
    
    document.querySelector('#my-card .card-avatar').style.backgroundImage = 
      currentUser.avatar ? `url(${currentUser.avatar})` : '';

    chatMessages.innerHTML = '';
    res.messages?.forEach(addChatMessage);

    // 메트로놈 상태 복원
    if (res.metronome) {
      $('bpm-input').value = res.metronome.bpm;
      if (res.metronome.playing) startMetronome(res.metronome.bpm, res.metronome.startTime);
    }

    res.users.forEach(u => createPeerConnection(u.id, u.username, u.avatar, true));
    startLatencyPing();
    startAudioMeter();
  });
};

$('joinRoomBtn').onclick = () => joinRoom();

// 오디오 레벨 미터
function startAudioMeter() {
  audioContext = new AudioContext();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  
  const source = audioContext.createMediaStreamSource(localStream);
  source.connect(analyser);
  
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  const meter = $('audio-meter');
  
  meterInterval = setInterval(() => {
    analyser.getByteFrequencyData(dataArray);
    const avg = dataArray.reduce((a, b) => a + b) / dataArray.length;
    const level = Math.min(100, avg * 1.5);
    meter.style.width = level + '%';
    meter.style.background = level > 80 ? '#ff4757' : level > 50 ? '#ffa502' : '#2ed573';
  }, 50);
}

// 메트로놈
$('metronome-toggle').onclick = () => {
  const bpm = parseInt($('bpm-input').value) || 120;
  const playing = !metronomeInterval;
  
  if (playing) {
    startMetronome(bpm);
  } else {
    stopMetronome();
  }
  
  socket.emit('metronome-update', { bpm, playing });
};

$('bpm-input').onchange = () => {
  if (metronomeInterval) {
    const bpm = parseInt($('bpm-input').value) || 120;
    stopMetronome();
    startMetronome(bpm);
    socket.emit('metronome-update', { bpm, playing: true });
  }
};

socket.on('metronome-sync', ({ bpm, playing, startTime }) => {
  $('bpm-input').value = bpm;
  if (playing) {
    startMetronome(bpm, startTime);
  } else {
    stopMetronome();
  }
});

function startMetronome(bpm, serverStartTime) {
  stopMetronome();
  
  const interval = 60000 / bpm;
  const tick = $('metronome-tick');
  
  // 서버 시작 시간에 동기화
  let delay = 0;
  if (serverStartTime) {
    const elapsed = Date.now() - serverStartTime;
    delay = interval - (elapsed % interval);
  }
  
  const playTick = () => {
    tick.classList.add('active');
    // 클릭 사운드 (Web Audio)
    if (!metronomeAudio) {
      metronomeAudio = new AudioContext();
    }
    const osc = metronomeAudio.createOscillator();
    const gain = metronomeAudio.createGain();
    osc.connect(gain);
    gain.connect(metronomeAudio.destination);
    osc.frequency.value = 1000;
    gain.gain.setValueAtTime(0.3, metronomeAudio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, metronomeAudio.currentTime + 0.1);
    osc.start();
    osc.stop(metronomeAudio.currentTime + 0.1);
    
    setTimeout(() => tick.classList.remove('active'), 100);
  };
  
  setTimeout(() => {
    playTick();
    metronomeInterval = setInterval(playTick, interval);
  }, delay);
  
  $('metronome-toggle').textContent = '⏹️';
  $('metronome-toggle').classList.add('playing');
}

function stopMetronome() {
  if (metronomeInterval) {
    clearInterval(metronomeInterval);
    metronomeInterval = null;
  }
  $('metronome-toggle').textContent = '▶️';
  $('metronome-toggle').classList.remove('playing');
}

// 채팅
$('sendBtn').onclick = sendChat;
$('chat-text').onkeypress = (e) => { if (e.key === 'Enter') sendChat(); };

function sendChat() {
  const text = $('chat-text').value.trim();
  if (!text) return;
  socket.emit('chat', text);
  $('chat-text').value = '';
}

socket.on('chat', addChatMessage);

function addChatMessage(msg) {
  const div = document.createElement('div');
  div.className = 'chat-msg' + (msg.username === currentUser?.username ? ' self' : '');
  div.innerHTML = `<span class="chat-user">${escapeHtml(msg.username)}</span><span class="chat-text">${escapeHtml(msg.text)}</span>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// WebRTC
function createPeerConnection(peerId, username, avatar, initiator) {
  const pc = new RTCPeerConnection(rtcConfig);
  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  document.body.appendChild(audioEl);

  // 이전 볼륨 상태 복원
  const savedVolume = volumeStates.get(peerId) ?? 100;
  audioEl.volume = savedVolume / 100;

  peers.set(peerId, { pc, username, avatar, audioEl, latency: null, volume: savedVolume });

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.ontrack = (e) => {
    audioEl.srcObject = e.streams[0];
    renderUsers();
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('ice-candidate', { to: peerId, candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => renderUsers();

  if (initiator) {
    pc.createOffer().then(offer => pc.setLocalDescription(offer))
      .then(() => socket.emit('offer', { to: peerId, offer: pc.localDescription }));
  }

  renderUsers();
  return pc;
}

function renderUsers() {
  usersGrid.innerHTML = '';
  peers.forEach((peer, id) => {
    const state = peer.pc.connectionState;
    const connected = state === 'connected';
    
    const card = document.createElement('div');
    card.className = `user-card ${connected ? 'connected' : 'connecting'}`;
    card.innerHTML = `
      <div class="card-avatar" style="background-image: ${peer.avatar ? `url(${peer.avatar})` : 'none'}"></div>
      <div class="card-info">
        <span class="card-name">${escapeHtml(peer.username)}</span>
        <span class="card-latency">${peer.latency ? peer.latency + 'ms' : (connected ? '측정중...' : state)}</span>
      </div>
      <div class="card-controls">
        <input type="range" min="0" max="100" value="${peer.volume}" class="volume-slider" data-peer="${id}">
        <span class="volume-label">${peer.volume}%</span>
        ${currentUser?.isAdmin ? `<button class="kick-btn" onclick="kickUser('${id}')">강퇴</button>` : ''}
      </div>
    `;
    
    const slider = card.querySelector('.volume-slider');
    const label = card.querySelector('.volume-label');
    slider.oninput = () => {
      const vol = parseInt(slider.value);
      peer.audioEl.volume = vol / 100;
      peer.volume = vol;
      volumeStates.set(id, vol);
      label.textContent = vol + '%';
    };
    
    usersGrid.appendChild(card);
  });
}

window.kickUser = (socketId) => {
  if (confirm('이 사용자를 강퇴하시겠습니까?')) {
    socket.emit('kick-user', { socketId });
  }
};

function startLatencyPing() {
  if (latencyInterval) clearInterval(latencyInterval);
  latencyInterval = setInterval(() => {
    peers.forEach((peer) => {
      if (peer.pc.connectionState === 'connected') {
        peer.pc.getStats().then(stats => {
          stats.forEach(report => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime) {
              peer.latency = Math.round(report.currentRoundTripTime * 1000);
            }
          });
          renderUsers();
        });
      }
    });
  }, 2000);
}

// 소켓 이벤트
socket.on('user-joined', ({ id, username, avatar }) => createPeerConnection(id, username, avatar, true));

socket.on('offer', async ({ from, offer }) => {
  let peer = peers.get(from);
  if (!peer) {
    createPeerConnection(from, '사용자', null, false);
    peer = peers.get(from);
  }
  await peer.pc.setRemoteDescription(offer);
  const answer = await peer.pc.createAnswer();
  await peer.pc.setLocalDescription(answer);
  socket.emit('answer', { to: from, answer });
});

socket.on('answer', async ({ from, answer }) => {
  const peer = peers.get(from);
  if (peer) await peer.pc.setRemoteDescription(answer);
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  const peer = peers.get(from);
  if (peer) await peer.pc.addIceCandidate(candidate);
});

socket.on('user-left', ({ id }) => {
  const peer = peers.get(id);
  if (peer) {
    peer.pc.close();
    peer.audioEl.remove();
    peers.delete(id);
    renderUsers();
  }
});

socket.on('user-updated', ({ id, avatar }) => {
  const peer = peers.get(id);
  if (peer) {
    peer.avatar = avatar;
    renderUsers();
  }
});

// 음소거
$('muteBtn').onclick = () => {
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  $('muteBtn').textContent = isMuted ? '🔇' : '🎤';
  $('muteBtn').classList.toggle('muted', isMuted);
};

// 방 나가기
$('leaveBtn').onclick = () => {
  if (!confirm('방을 나가시겠습니까?')) return;
  leaveRoom();
};

function leaveRoom() {
  // 인터벌 정리
  if (latencyInterval) { clearInterval(latencyInterval); latencyInterval = null; }
  if (meterInterval) { clearInterval(meterInterval); meterInterval = null; }
  stopMetronome();
  
  // 오디오 컨텍스트 정리
  if (audioContext) { audioContext.close(); audioContext = null; }
  if (metronomeAudio) { metronomeAudio.close(); metronomeAudio = null; }
  
  // P2P 연결 정리
  peers.forEach(peer => {
    peer.pc.close();
    peer.audioEl.remove();
  });
  peers.clear();
  volumeStates.clear();
  
  // 로컬 스트림 정리
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;
  
  socket.room = null;
  roomView.classList.add('hidden');
  lobby.classList.remove('hidden');
  loadRoomList();
}
