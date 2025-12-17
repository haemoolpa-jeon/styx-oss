// Styx 클라이언트 - HADES 실시간 오디오 협업
// WebRTC P2P 오디오 + 메트로놈 + 오디오 레벨 미터

const socket = io({ reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: 10 });
const peers = new Map();
const volumeStates = new Map();
let localStream = null;
let isMuted = false;
let currentUser = null;
let selectedDeviceId = null;
let selectedOutputId = null;
let latencyInterval = null;
let audioContext = null;
let analyser = null;
let meterInterval = null;
let metronomeInterval = null;
let metronomeAudio = null;
let sessionRestored = false;
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

const $ = id => document.getElementById(id);

// 토스트 메시지
function toast(message, type = 'info', duration = 3000) {
  const container = $('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ===== 테마 =====
function initTheme() {
  const saved = localStorage.getItem('styx-theme') || 'dark';
  document.body.dataset.theme = saved;
  updateThemeIcon();
}

function toggleTheme() {
  const current = document.body.dataset.theme;
  const next = current === 'dark' ? 'light' : 'dark';
  document.body.dataset.theme = next;
  localStorage.setItem('styx-theme', next);
  updateThemeIcon();
}

function updateThemeIcon() {
  const btn = $('themeBtn');
  if (btn) btn.textContent = document.body.dataset.theme === 'dark' ? '☀️' : '🌙';
}

initTheme();

// ===== 사운드 알림 =====
let notifyAudio = null;

function playSound(type) {
  if (!notifyAudio) notifyAudio = new AudioContext();
  if (notifyAudio.state === 'suspended') notifyAudio.resume();
  
  const osc = notifyAudio.createOscillator();
  const gain = notifyAudio.createGain();
  osc.connect(gain);
  gain.connect(notifyAudio.destination);
  
  if (type === 'join') {
    osc.frequency.value = 800;
    gain.gain.setValueAtTime(0.2, notifyAudio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, notifyAudio.currentTime + 0.15);
    osc.start();
    osc.stop(notifyAudio.currentTime + 0.15);
  } else if (type === 'leave') {
    osc.frequency.value = 400;
    gain.gain.setValueAtTime(0.2, notifyAudio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, notifyAudio.currentTime + 0.2);
    osc.start();
    osc.stop(notifyAudio.currentTime + 0.2);
  }
}

// ===== 키보드 단축키 =====
document.addEventListener('keydown', (e) => {
  // 입력 필드에서는 무시
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  
  // 방 화면에서만 작동
  if (roomView?.classList.contains('hidden')) return;
  
  if (e.key === 'm' || e.key === 'M' || e.key === 'ㅡ') {
    e.preventDefault();
    $('muteBtn')?.click();
  } else if (e.key === ' ') {
    e.preventDefault();
    $('metronome-toggle')?.click();
  }
});

// ===== (즐겨찾기 제거됨) =====

// ===== 녹음 =====
function startRecording() {
  if (isRecording) return;
  
  // 모든 오디오 스트림 믹싱
  const audioCtx = new AudioContext();
  const dest = audioCtx.createMediaStreamDestination();
  
  // 로컬 오디오 추가
  if (localStream) {
    const localSource = audioCtx.createMediaStreamSource(localStream);
    localSource.connect(dest);
  }
  
  // 원격 오디오 추가
  peers.forEach(peer => {
    if (peer.audioEl.srcObject) {
      const remoteSource = audioCtx.createMediaStreamSource(peer.audioEl.srcObject);
      remoteSource.connect(dest);
    }
  });
  
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm' });
  
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };
  
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: 'audio/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `styx-recording-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.webm`;
    a.click();
    URL.revokeObjectURL(url);
    toast('녹음 파일이 다운로드되었습니다', 'success');
  };
  
  mediaRecorder.start();
  isRecording = true;
  $('recordBtn').textContent = '⏹️ 녹음 중';
  $('recordBtn').classList.add('recording');
  toast('녹음 시작', 'info');
}

function stopRecording() {
  if (!isRecording || !mediaRecorder) return;
  
  mediaRecorder.stop();
  isRecording = false;
  $('recordBtn').textContent = '⏺️ 녹음';
  $('recordBtn').classList.remove('recording');
}

function toggleRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}
const authPanel = $('auth');
const lobby = $('lobby');
const adminPanel = $('admin-panel');
const roomView = $('room-view');
const usersGrid = $('users-grid');
const chatMessages = $('chat-messages');

// 소켓 연결 후 세션 복구 시도
socket.on('connect', () => {
  console.log('서버 연결됨');
  $('connection-status')?.classList.remove('offline');
  
  // 세션 복구 (최초 연결 시에만)
  if (!sessionRestored) {
    sessionRestored = true;
    const savedUser = localStorage.getItem('styx-user');
    const savedToken = localStorage.getItem('styx-token');
    
    if (savedUser && savedToken) {
      socket.emit('restore-session', { username: savedUser, token: savedToken }, res => {
        if (res.success) {
          currentUser = res.user;
          showLobby();
        } else {
          localStorage.removeItem('styx-user');
          localStorage.removeItem('styx-token');
        }
      });
    }
  }
  
  // 방에 있었다면 재입장 시도
  if (currentUser && socket.room) {
    socket.emit('join', { room: socket.room, username: currentUser.username }, res => {
      if (res.error) {
        toast('재연결 실패: ' + res.error, 'error');
        leaveRoom();
      }
    });
  }
});

socket.on('disconnect', () => {
  console.log('서버 연결 끊김');
  $('connection-status')?.classList.add('offline');
});

socket.on('kicked', () => { 
  toast('방에서 강퇴되었습니다', 'error'); 
  leaveRoom();
});

socket.on('room-closed', () => {
  toast('관리자가 방을 닫았습니다', 'warning');
  leaveRoom();
});

// 관리자: 방 닫기
function closeRoom() {
  const roomName = $('roomName')?.textContent;
  if (!roomName) return;
  
  if (confirm(`"${roomName}" 방을 닫으시겠습니까? 모든 사용자가 퇴장됩니다.`)) {
    socket.emit('close-room', { roomName }, res => {
      if (res.error) {
        toast(res.error, 'error');
      }
    });
  }
}

// 로그인/회원가입 탭
document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $('login-form').classList.toggle('hidden', tab.dataset.tab !== 'login');
    $('signup-form').classList.toggle('hidden', tab.dataset.tab !== 'signup');
  };
});

// Enter 키
$('login-user').onkeypress = $('login-pass').onkeypress = (e) => { if (e.key === 'Enter') $('loginBtn').click(); };
$('signup-user').onkeypress = $('signup-pass').onkeypress = (e) => { if (e.key === 'Enter') $('signupBtn').click(); };
$('room-input').onkeypress = (e) => { if (e.key === 'Enter') $('joinRoomBtn').click(); };

// 로그인
$('loginBtn').onclick = () => {
  const username = $('login-user').value.trim();
  const password = $('login-pass').value;
  if (!username || !password) return showAuthMsg('사용자명과 비밀번호를 입력하세요', true);

  $('loginBtn').disabled = true;
  socket.emit('login', { username, password }, res => {
    $('loginBtn').disabled = false;
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
    localStorage.setItem('styx-token', res.token);
    showLobby();
  });
};

// 회원가입
$('signupBtn').onclick = () => {
  const username = $('signup-user').value.trim();
  const password = $('signup-pass').value;
  if (!username || !password) return showAuthMsg('사용자명과 비밀번호를 입력하세요', true);

  $('signupBtn').disabled = true;
  socket.emit('signup', { username, password }, res => {
    $('signupBtn').disabled = false;
    if (res.error) {
      const errorMsg = {
        'Username taken': '이미 사용 중인 사용자명입니다',
        'Invalid username (2-20자, 영문/숫자/한글/_)': '사용자명: 2-20자, 영문/숫자/한글/_만 가능',
        'Invalid password (4-50자)': '비밀번호: 4-50자'
      }[res.error] || res.error;
      return showAuthMsg(errorMsg, true);
    }
    showAuthMsg('가입 요청 완료. 관리자 승인을 기다려주세요.', false);
    toast('가입 요청이 전송되었습니다', 'success');
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
  localStorage.removeItem('styx-token');
  location.reload();
};

// 오디오 장치 로드 (입력 + 출력)
async function loadAudioDevices() {
  try {
    const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    tempStream.getTracks().forEach(t => t.stop());
    
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');
    const audioOutputs = devices.filter(d => d.kind === 'audiooutput');
    
    // 입력 장치
    const inputSelect = $('audio-device');
    inputSelect.innerHTML = audioInputs.map((d, i) => 
      `<option value="${d.deviceId}">${d.label || '마이크 ' + (i + 1)}</option>`
    ).join('');
    selectedDeviceId = audioInputs[0]?.deviceId;
    inputSelect.onchange = () => selectedDeviceId = inputSelect.value;
    
    // 출력 장치
    const outputSelect = $('audio-output');
    if (outputSelect && audioOutputs.length) {
      outputSelect.innerHTML = audioOutputs.map((d, i) => 
        `<option value="${d.deviceId}">${d.label || '스피커 ' + (i + 1)}</option>`
      ).join('');
      selectedOutputId = audioOutputs[0]?.deviceId;
      outputSelect.onchange = () => {
        selectedOutputId = outputSelect.value;
        // 모든 오디오 엘리먼트에 출력 장치 적용
        peers.forEach(peer => {
          if (peer.audioEl.setSinkId) {
            peer.audioEl.setSinkId(selectedOutputId).catch(() => {});
          }
        });
      };
    }
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
  if (file.size > 2 * 1024 * 1024) return toast('이미지 크기는 2MB 이하여야 합니다', 'error');
  
  const reader = new FileReader();
  reader.onload = () => {
    socket.emit('upload-avatar', { username: currentUser.username, avatarData: reader.result }, res => {
      if (res.success) {
        currentUser.avatar = res.avatar;
        $('my-avatar').style.backgroundImage = `url(${res.avatar})`;
        toast('아바타가 변경되었습니다', 'success');
      } else {
        toast(res.error, 'error');
      }
    });
  };
  reader.readAsDataURL(file);
};

// 설정 패널
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
  if (!oldPw || !newPw) return toast('비밀번호를 입력하세요', 'warning');
  
  socket.emit('change-password', { oldPassword: oldPw, newPassword: newPw }, res => {
    if (res.success) {
      toast('비밀번호가 변경되었습니다. 다시 로그인해주세요.', 'success');
      setTimeout(() => {
        localStorage.removeItem('styx-token');
        location.reload();
      }, 1500);
    } else {
      toast(res.error === 'Wrong password' ? '현재 비밀번호가 틀렸습니다' : res.error, 'error');
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
  socket.emit('get-pending', null, res => {
    const list = $('pending-list');
    list.innerHTML = res.pending?.length ? '' : '<p>대기 중인 요청이 없습니다</p>';
    res.pending?.forEach(username => {
      const div = document.createElement('div');
      div.className = 'pending-user';
      div.innerHTML = `<span>${escapeHtml(username)}</span>
        <button onclick="approveUser('${username.replace(/'/g, "\\'")}')">✓</button>
        <button onclick="rejectUser('${username.replace(/'/g, "\\'")}')">✗</button>`;
      list.appendChild(div);
    });
  });
  
  socket.emit('get-users', null, res => {
    const list = $('users-list');
    list.innerHTML = '';
    res.users?.forEach(u => {
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
    return toast('마이크 접근이 거부되었습니다', 'error');
  }

  $('joinRoomBtn').disabled = true;
  socket.emit('join', { room, username: currentUser.username, password: roomPassword }, res => {
    $('joinRoomBtn').disabled = false;
    if (res.error) {
      localStream.getTracks().forEach(t => t.stop());
      const errorMsg = {
        'Room full': '방이 가득 찼습니다',
        'Username already in room': '이미 방에 접속 중입니다',
        'Not authorized': '권한이 없습니다',
        'Wrong room password': '방 비밀번호가 틀렸습니다'
      }[res.error] || res.error;
      return toast(errorMsg, 'error');
    }

    lobby.classList.add('hidden');
    roomView.classList.remove('hidden');
    $('roomName').textContent = room;
    socket.room = room;
    
    // 관리자면 방 닫기 버튼 표시
    if (res.isAdmin) {
      $('closeRoomBtn')?.classList.remove('hidden');
    } else {
      $('closeRoomBtn')?.classList.add('hidden');
    }
    
    document.querySelector('#my-card .card-avatar').style.backgroundImage = 
      currentUser.avatar ? `url(${currentUser.avatar})` : '';

    chatMessages.innerHTML = '';
    res.messages?.forEach(addChatMessage);

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
  try {
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
  } catch (e) {
    console.error('AudioContext 생성 실패:', e);
  }
}

// 메트로놈
$('metronome-toggle').onclick = () => {
  // 사용자 상호작용으로 AudioContext 생성
  if (!metronomeAudio) {
    metronomeAudio = new AudioContext();
  }
  
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
  
  let delay = 0;
  if (serverStartTime) {
    const elapsed = Date.now() - serverStartTime;
    delay = interval - (elapsed % interval);
  }
  
  const playTick = () => {
    tick.classList.add('active');
    
    // AudioContext가 없거나 suspended면 생성/resume
    if (!metronomeAudio || metronomeAudio.state === 'closed') {
      metronomeAudio = new AudioContext();
    }
    if (metronomeAudio.state === 'suspended') {
      metronomeAudio.resume();
    }
    
    try {
      const osc = metronomeAudio.createOscillator();
      const gain = metronomeAudio.createGain();
      osc.connect(gain);
      gain.connect(metronomeAudio.destination);
      osc.frequency.value = 1000;
      gain.gain.setValueAtTime(0.3, metronomeAudio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, metronomeAudio.currentTime + 0.1);
      osc.start();
      osc.stop(metronomeAudio.currentTime + 0.1);
    } catch (e) {
      console.error('메트로놈 사운드 재생 실패:', e);
    }
    
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

  // 출력 장치 설정
  if (selectedOutputId && audioEl.setSinkId) {
    audioEl.setSinkId(selectedOutputId).catch(() => {});
  }

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

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      console.log(`연결 실패: ${username}, 재시도...`);
      // 연결 실패 시 재시도
      pc.restartIce();
    }
    renderUsers();
  };

  if (initiator) {
    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .then(() => socket.emit('offer', { to: peerId, offer: pc.localDescription }))
      .catch(e => console.error('Offer 생성 실패:', e));
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
        <input type="range" min="0" max="100" value="${peer.volume}" class="volume-slider">
        <span class="volume-label">${peer.volume}%</span>
        ${currentUser?.isAdmin ? `<button class="kick-btn" data-id="${id}">강퇴</button>` : ''}
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
    
    const kickBtn = card.querySelector('.kick-btn');
    if (kickBtn) {
      kickBtn.onclick = () => {
        if (confirm('이 사용자를 강퇴하시겠습니까?')) {
          socket.emit('kick-user', { socketId: id });
        }
      };
    }
    
    usersGrid.appendChild(card);
  });
}

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
        }).catch(() => {});
      }
    });
  }, 2000);
}

// 소켓 이벤트
socket.on('user-joined', ({ id, username, avatar }) => {
  createPeerConnection(id, username, avatar, true);
  playSound('join');
  toast(`${username} 입장`, 'info', 2000);
});

socket.on('offer', async ({ from, offer }) => {
  try {
    let peer = peers.get(from);
    if (!peer) {
      createPeerConnection(from, '사용자', null, false);
      peer = peers.get(from);
    }
    await peer.pc.setRemoteDescription(offer);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    socket.emit('answer', { to: from, answer });
  } catch (e) {
    console.error('Offer 처리 실패:', e);
  }
});

socket.on('answer', async ({ from, answer }) => {
  try {
    const peer = peers.get(from);
    if (peer) await peer.pc.setRemoteDescription(answer);
  } catch (e) {
    console.error('Answer 처리 실패:', e);
  }
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  try {
    const peer = peers.get(from);
    if (peer && candidate) await peer.pc.addIceCandidate(candidate);
  } catch (e) {
    console.error('ICE 후보 추가 실패:', e);
  }
});

socket.on('user-left', ({ id }) => {
  const peer = peers.get(id);
  if (peer) {
    const username = peer.username;
    peer.pc.close();
    peer.audioEl.remove();
    peers.delete(id);
    renderUsers();
    playSound('leave');
    toast(`${username} 퇴장`, 'info', 2000);
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
  localStream?.getAudioTracks().forEach(t => t.enabled = !isMuted);
  $('muteBtn').textContent = isMuted ? '🔇' : '🎤';
  $('muteBtn').classList.toggle('muted', isMuted);
};

// 방 나가기
$('leaveBtn').onclick = () => {
  if (!confirm('방을 나가시겠습니까?')) return;
  leaveRoom();
};

function leaveRoom() {
  // 서버에 방 나가기 알림
  socket.emit('leave-room');
  
  if (latencyInterval) { clearInterval(latencyInterval); latencyInterval = null; }
  if (meterInterval) { clearInterval(meterInterval); meterInterval = null; }
  stopMetronome();
  stopRecording();
  
  if (audioContext) { 
    try { audioContext.close(); } catch {} 
    audioContext = null; 
  }
  if (metronomeAudio) { 
    try { metronomeAudio.close(); } catch {} 
    metronomeAudio = null; 
  }
  
  peers.forEach(peer => {
    peer.pc.close();
    peer.audioEl.remove();
  });
  peers.clear();
  volumeStates.clear();
  
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;
  
  socket.room = null;
  roomView.classList.add('hidden');
  lobby.classList.remove('hidden');
  loadRoomList();
  
}
