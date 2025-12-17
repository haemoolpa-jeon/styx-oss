// Styx 초기 설정 스크립트
// 관리자 계정을 bcrypt 해시된 비밀번호로 생성

const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');

const USERS_FILE = path.join(__dirname, 'server/users.json');

async function setup() {
  const hash = await bcrypt.hash('admin123', 10);
  const data = {
    users: {
      admin: {
        password: hash,
        approved: true,
        isAdmin: true,
        avatar: null,
        createdAt: new Date().toISOString()
      }
    },
    pending: {}
  };
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
  console.log('설정 완료. 관리자 계정이 생성되었습니다.');
  console.log('사용자명: admin');
  console.log('비밀번호: admin123');
}

setup();
