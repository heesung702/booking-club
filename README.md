# 부킹 클럽

야외 페스티벌 분위기의 웹 3D 클럽. 설치 없이 브라우저에서 바로 입장해 혼자 또는 함께 춤추고 구경합니다.

- `index.html`: 화면 (단일 파일, GitHub Pages로 공개)
- `server/`: 실시간 서버 (Cloudflare Workers + Durable Objects, 무료 플랜)
  - 같은 방 사람들의 위치·춤·반응만 전달합니다. 대화 기능 없음, 이름은 정해진 낱말 조합만 허용.
  - 장소마다 방이 있고 한 방 최대 30명, 차면 다음 방.
  - 모두 서버 시계로 박자를 맞춰서 음악과 떼춤이 같이 맞습니다.
  - 사람이 적으면 컴퓨터 댄서가 채웁니다(방장 화면이 움직임).
  - 일자별 통계: `<서버주소>/stats` (비밀번호 필요). 입장수, 순 사용자, 신규, 재방문, 최대 동시 접속.
    브라우저에 저장한 무작위 번호의 해시만 저장하고 이름·IP는 저장하지 않습니다.
- `.github/workflows/deploy-server.yml`: main에 `server/` 변경이 들어오면 자동 배포.
  필요한 Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `STATS_KEY`

로컬 시험: `cd server && npm install && npx wrangler dev`, 다른 창에서 `python3 -m http.server 8080` 후
`http://localhost:8080/?server=ws://127.0.0.1:8787/ws` 를 여러 창으로 열기. 비밀번호는 `server/.dev.vars`(커밋 안 됨)에 `STATS_KEY=...`.

## 보안 규칙

이 저장소는 공개(Public)입니다. 아래 파일은 절대 커밋하지 않습니다.

- `.env`, `.env.*` 등 환경 변수 파일 (예시 파일 `.env.example`만 허용, 실제 값 없이)
- API 키, 토큰, 비밀번호가 들어간 모든 파일
- 키·인증서 파일: `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.crt`, `id_rsa*`, `id_ed25519*`
- 인증 정보 파일: `credentials*.json`, `service-account*.json`, `secret*.json`, `secrets/`
- `.npmrc`, `.netrc` (토큰이 들어갈 수 있음)

위 항목은 `.gitignore`에 등록되어 있습니다. 새 비밀 파일 종류가 생기면 커밋 전에 먼저 `.gitignore`에 추가합니다.

비밀 값은 코드에 직접 쓰지 않고, 배포 환경의 환경 변수나 GitHub Secrets로 관리합니다.
실수로 커밋했다면 파일 삭제만으로는 부족합니다. 해당 키를 즉시 폐기·재발급합니다.
