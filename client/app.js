// Styx 클라이언트 - HADES 실시간 오디오 협업
// WebRTC P2P 오디오 연결 및 채팅 기능

const socket = io();
const peers = new Map(); // peerId -> { pc, username, avatar, audioEl, latency }
let localStream = null;
let isMuted = false;
let currentUser = null;
let selectedDeviceId = null;

// WebRTC 설정 - STUN 서버로 NAT 통과
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// DOM 헬퍼
const $ = id => document.getElementById(id);
const authPanel = $('auth');
const lobby = $('lobby');
const adminPanel = $('admin-panel');
const roomView = $('room-view');
const usersGrid = $('users-grid');
const chatMessages = $('chat-messages');

// 로그인/회원가입 탭 전환
document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $('login-form').classList.toggle('hidden', tab.dataset.tab !== 'login');
    $('signup-form').classList.toggle('hidden', tab.dataset.tab !== 'signup');
  };
});

// 로그인 처리
$('loginBtn').onclick = () => {
  const username = $('login-user').value.trim();
  const password = $('login-pass').value;
  if (!username || !password) return showAuthMsg('사용자명과 비밀번호를 입력하세요', true);

  socket.emit('login', { username, password }, res => {
    if (res.error) {
      const errorMsg = {
        'User not found': '사용자를 찾을 수 없습니다',
        'Wrong password': '비밀번호가 틀렸습니다',
        'Account pending approval': '승인 대기 중입니다'
      }[res.error] || res.error;
      return showAuthMsg(errorMsg, true);
    }
    currentUser = res.user;
    showLobby();
  });
};

// 회원가입 요청
$('signupBtn').onclick = () => {
  const username = $('signup-user').value.trim();
  const password = $('signup-pass').value;
  if (!username || !password) return showAuthMsg('사용자명과 비밀번호를 입력하세요', true);

  socket.emit('signup', { username, password }, res => {
    if (res.error) {
      const errorMsg = res.error === 'Username taken' ? '이미 사용 중인 사용자명입니다' : res.error;
      return showAuthMsg(errorMsg, true);
    }
    showAuthMsg('가입 요청 완료. 관리자 승인을 기다려주세요.', false);
  });
};

// 인증 메시지 표시
function showAuthMsg(msg, isError) {
  const el = $('auth-msg');
  el.textContent = msg;
  el.className = isError ? 'error' : 'success';
}

// 로비 화면 표시
async function showLobby() {
  authPanel.classList.add('hidden');
  lobby.classList.remove('hidden');
  $('my-username').textContent = currentUser.username;
  $('my-avatar').style.backgroundImage = currentUser.avatar ? `url(${currentUser.avatar})` : '';
  if (currentUser.isAdmin) $('adminBtn').classList.remove('hidden');
  
  await loadAudioDevices();
  loadRoomList();
}

$('logoutBtn').onclick = () => location.reload();

// 오디오 장치 목록 로드
async function loadAudioDevices() {
  try {
    // 먼저 권한 요청
    await navigator.mediaDevices.getUserMedia({ audio: true });
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

// 방 목록 로드
function loadRoomList() {
  socket.emit('get-rooms', null, rooms => renderRoomList(rooms));
}

// 방 목록 실시간 업데이트 수신
socket.on('room-list', renderRoomList);

// 방 목록 렌더링
function renderRoomList(rooms) {
  const list = $('room-list');
  if (!rooms.length) {
    list.innerHTML = '<p class="no-rooms">활성화된 방이 없습니다</p>';
    return;
  }
  list.innerHTML = rooms.map(r => `
    <div class="room-item" onclick="joinRoom('${r.name}')">
      <span class="room-name">${r.name}</span>
      <span class="room-users">${r.userCount}/8 👤</span>
    </div>
  `).join('');
}

// 아바타 업로드
$('avatar-input').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    socket.emit('upload-avatar', { username: currentUser.username, avatarData: reader.result }, res => {
      if (res.success) {
        currentUser.avatar = res.avatar;
        $('my-avatar').style.backgroundImage = `url(${res.avatar})`;
      }
    });
  };
  reader.readAsDataURL(file);
};

// 관리자 패널 열기
$('adminBtn').onclick = () => {
  socket.emit('get-pending', null, res => {
    const list = $('pending-list');
    list.innerHTML = res.pending.length ? '' : '<p>대기 중인 요청이 없습니다</p>';
    res.pending.forEach(username => {
      const div = document.createElement('div');
      div.className = 'pending-user';
      div.innerHTML = `<span>${username}</span>
        <button onclick="approveUser('${username}')">✓</button>
        <button onclick="rejectUser('${username}')">✗</button>`;
      list.appendChild(div);
    });
  });
  adminPanel.classList.remove('hidden');
  lobby.classList.add('hidden');
};

// 사용자 승인/거절
window.approveUser = (username) => socket.emit('approve-user', { username }, () => $('adminBtn').click());
window.rejectUser = (username) => socket.emit('reject-user', { username }, () => $('adminBtn').click());

$('closeAdminBtn').onclick = () => {
  adminPanel.classList.add('hidden');
  lobby.classList.remove('hidden');
};

// 방 입장
window.joinRoom = async (roomName) => {
  const room = roomName || $('room-input').value.trim();
  if (!room) return;

  // 악기용 저지연 오디오 설정 (에코 제거 끔)
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

  socket.emit('join', { room, username: currentUser.username }, res => {
    if (res.error) {
      localStream.getTracks().forEach(t => t.stop());
      const errorMsg = {
        'Room full': '방이 가득 찼습니다',
        'Username already in room': '이미 방에 접속 중입니다',
        'Not authorized': '권한이 없습니다'
      }[res.error] || res.error;
      return alert(errorMsg);
    }

    lobby.classList.add('hidden');
    roomView.classList.remove('hidden');
    $('roomName').textContent = room;
    
    // 내 카드에 아바타 설정
    document.querySelector('#my-card .card-avatar').style.backgroundImage = 
      currentUser.avatar ? `url(${currentUser.avatar})` : '';

    // 채팅 기록 로드
    chatMessages.innerHTML = '';
    res.messages?.forEach(addChatMessage);

    // 기존 사용자들과 P2P 연결
    res.users.forEach(u => createPeerConnection(u.id, u.username, u.avatar, true));
    startLatencyPing();
  });
};

$('joinRoomBtn').onclick = () => joinRoom();

// 채팅 전송
$('sendBtn').onclick = sendChat;
$('chat-text').onkeypress = (e) => { if (e.key === 'Enter') sendChat(); };

function sendChat() {
  const text = $('chat-text').value.trim();
  if (!text) return;
  socket.emit('chat', text);
  $('chat-text').value = '';
}

// 채팅 메시지 수신
socket.on('chat', addChatMessage);

// 채팅 메시지 추가
function addChatMessage(msg) {
  const div = document.createElement('div');
  div.className = 'chat-msg' + (msg.username === currentUser?.username ? ' self' : '');
  div.innerHTML = `<span class="chat-user">${msg.username}</span><span class="chat-text">${escapeHtml(msg.text)}</span>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// HTML 이스케이프 (XSS 방지)
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// WebRTC P2P 연결 생성
function createPeerConnection(peerId, username, avatar, initiator) {
  const pc = new RTCPeerConnection(rtcConfig);
  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  document.body.appendChild(audioEl);

  peers.set(peerId, { pc, username, avatar, audioEl, latency: null });

  // 로컬 오디오 트랙 추가
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  // 원격 오디오 수신
  pc.ontrack = (e) => {
    audioEl.srcObject = e.streams[0];
    renderUsers();
  };

  // ICE 후보 전송
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('ice-candidate', { to: peerId, candidate: e.candidate });
  };

  // 연결 상태 변경 시 UI 업데이트
  pc.onconnectionstatechange = () => renderUsers();

  // 연결 시작자면 offer 생성
  if (initiator) {
    pc.createOffer().then(offer => pc.setLocalDescription(offer))
      .then(() => socket.emit('offer', { to: peerId, offer: pc.localDescription }));
  }

  renderUsers();
  return pc;
}

// 사용자 카드 렌더링
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
        <span class="card-name">${peer.username}</span>
        <span class="card-latency">${peer.latency ? peer.latency + 'ms' : (connected ? '측정중...' : state)}</span>
      </div>
      <div class="card-controls">
        <input type="range" min="0" max="100" value="100" class="volume-slider" data-peer="${id}">
        <span class="volume-label">100%</span>
      </div>
    `;
    
    // 볼륨 슬라이더 이벤트
    const slider = card.querySelector('.volume-slider');
    const label = card.querySelector('.volume-label');
    slider.oninput = () => {
      peer.audioEl.volume = slider.value / 100;
      label.textContent = slider.value + '%';
    };
    
    usersGrid.appendChild(card);
  });
}

// 지연시간 측정 (2초마다)
function startLatencyPing() {
  setInterval(() => {
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

// 소켓 이벤트: 새 사용자 입장
socket.on('user-joined', ({ id, username, avatar }) => createPeerConnection(id, username, avatar, true));

// 소켓 이벤트: offer 수신
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

// 소켓 이벤트: answer 수신
socket.on('answer', async ({ from, answer }) => {
  const peer = peers.get(from);
  if (peer) await peer.pc.setRemoteDescription(answer);
});

// 소켓 이벤트: ICE 후보 수신
socket.on('ice-candidate', async ({ from, candidate }) => {
  const peer = peers.get(from);
  if (peer) await peer.pc.addIceCandidate(candidate);
});

// 소켓 이벤트: 사용자 퇴장
socket.on('user-left', ({ id }) => {
  const peer = peers.get(id);
  if (peer) {
    peer.pc.close();
    peer.audioEl.remove();
    peers.delete(id);
    renderUsers();
  }
});

// 소켓 이벤트: 사용자 정보 업데이트 (아바타 등)
socket.on('user-updated', ({ id, avatar }) => {
  const peer = peers.get(id);
  if (peer) {
    peer.avatar = avatar;
    renderUsers();
  }
});

// 음소거 토글
$('muteBtn').onclick = () => {
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  $('muteBtn').textContent = isMuted ? '🔇' : '🎤';
  $('muteBtn').classList.toggle('muted', isMuted);
};

// 방 나가기
$('leaveBtn').onclick = () => {
  peers.forEach(peer => {
    peer.pc.close();
    peer.audioEl.remove();
  });
  peers.clear();
  localStream?.getTracks().forEach(t => t.stop());
  socket.disconnect();
  location.reload();
};
