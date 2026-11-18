# phase-06-task-02 — attempt 1

## 목표
롤백 배포 경로(`plugins.updater.allowDowngrades`, updater ≥2.12)를 검토·확정하고
스키마 다운그레이드 안전성을 확인한다 — TD-10 잠정 → **확정(적용)**.

## 결론: **TD-10 확정 — allowDowngrades 적용**
스키마 역방향 안전 확인 → `src-tauri/tauri.conf.json`에
`plugins.updater.allowDowngrades: true` 적용. 실제 롤백 배포 실행은
사용자 승인 대상이라 경로 확보·문서화만 했다(실 배포 미수행).

## 1. 다운그레이드 안전성 판정 근거

### 대상 코드
다운그레이드 목적지는 **출시 태그 v0.2.4**(v1 스키마 최종 릴리스).
`git show v0.2.4:src/store.js`의 `migrate()`는 버전 분기가 없고 세 단계 모두
spread merge다:

```js
const s = { ...base, ...raw };                          // 최상위 — raw 전 키 보존
s.common = { ...base.common, ...raw.common };           // common — 미지 키 보존
const merged = { ...d, ...item, images: [...] };        // 인덱스 — 미지 키 보존
// version 미처리: raw.version=2가 base의 1을 덮어씀 → 그대로 보존
```

### v2 store → v0.2.4 앱 읽기 시 각 필드의 운명
| v2 키 | 경로 | 결과 |
|---|---|---|
| `version: 2` | 최상위 spread | **보존** — 저장본에도 2 유지 → 재업그레이드 시 declared=2로 STEPS 건너뜀(멱등) |
| `templates[]`, `snippets[]` | 최상위 spread | **보존** — v1 코드가 건드리지 않음, 저장 시 그대로 직렬화 |
| `common.darkMode`, `common.notifyMethod` | common spread | **보존** — v1은 읽지 않지만 파괴도 안 함 |
| `idx.hidden`, `idx.reminders[]` | 인덱스 spread | **보존** — v1은 렌더/스케줄에 미사용, 값 그대로 유지 |
| 미지의 향후 키(임의) | 최상위 spread | **보존** — 화이트리스트 재구성이 없어 전부 통과 |
| `images` | 명시 정규화 | 배열 여부만 검사 — v1·v2 동일 규칙이라 유실 없음 |
| 11개째 인덱스 | `slice(0, MAX_INDEXES)` | 절단 — v2도 같은 상한이라 v2가 쓴 파일엔 해당 없음 |

- 저장 경로: v1 `saveStore()`는 `JSON.stringify(state)` 전량 직렬화 →
  migrate가 보존한 키는 저장본에도 그대로 남는다.
- 복원 경로: v0.2.4 `settings.js` `Object.assign(state, migrate(parsed))` —
  migrate 결과의 최상위 키를 통째 assign하므로 templates/snippets도 유지.
- 화이트리스트 재구성(알 수 없는 키를 버리는 경로)은 v1 어디에도 없음.

### 코드 단언 (selftest +2건, 68→70)
`src/selftest.js`에 v0.2.4 알고리즘을 그대로 옮긴 `migrateV1` 시뮬레이션 추가:
- `downgrade-v1-preserves-v2` — v2 store(version 2·darkMode·notifyMethod·
  hidden·reminders·templates·snippets·미지 최상위 키)를 v1식 migrate→
  JSON 왕복한 결과가 전 필드 보존인지 단언. **PASS** `v=2 tpl=1 rem=1`.
- `downgrade-reupgrade-roundtrip` — 그 저장본을 다시 현행 v2 `migrate()`에
  넣으면 declared=2라 STEPS 없이 reminders.repeat/enabled·hidden·
  templates/snippets까지 무손실인지 단언. **PASS** `idx0.hidden=true rem=1`.

판정: **안전** — 구버전 앱이 v2 파일을 읽어도(그리고 저장·복원해도)
신규 필드를 파괴하지 않는다.

## 2. 적용 결정
**적용**. 근거:
- 스키마 안전 확인(위 §1) — TD-10 잠정 조건 ① 해소.
- `tauri-plugin-updater 2.14.1`(Cargo.lock) ≥ 2.12 — `allowDowngrades`가
  플러그인 설정으로 지원됨(q02 §2.3, JS `check()` 옵션은 보안상 제거됨).
  벤더 소스 확인: `config.rs:148` `pub allow_downgrades`(camelCase/
  `allow-downgrades` alias), `lib.rs:102` 설정 시 기본 비교자가
  `update.version != current`("다르면 허용")로 바뀐다.
- `main.rs:1345`는 `tauri_plugin_updater::Builder::new().build()` 그대로 —
  커스텀 `version_comparator`가 없어 설정이 그대로 적용된다.
- `updates.js`의 `check()`는 인자 없이 호출 — JS 쪽 변경 불필요.

## 3. 설정 diff
```diff
       "endpoints": ["https://github.com/Logic-k/GuseokMemo/releases/latest/download/latest.json"],
-      "windows": { "installMode": "passive" }
+      "windows": { "installMode": "passive" },
+      "allowDowngrades": true
```
`cargo build` 통과 — `generate_context!`가 conf 파싱·플러그인 config가
컴파일 포함돼 형식 유효 확인됨.

## 4. 롤백 운용 절차 (문서 — 조정자 LOG 반영용)
정적 latest.json + GitHub Releases 구성에서의 핫픽스 롤백:

1. **회귀 확정**: 배포된 버전 N에서 심각 회귀 확인. 대응 버전 N-1(직전
   릴리스, 설치자·`.sig`가 Release에 남아 있어야 함)을 정한다.
2. **latest.json 교체**: `releases/latest/download/latest.json`이 가리키는
   내용을 N-1의 것으로 되돌린다 — 방법은 GitHub Release `latest` 태그의
   latest.json 에셋을 N-1 버전·URL·서명·pub_date로 재생성해 업로드
   (또는 `gh release edit latest --tag N-1` 계열로 릴리스 포인터 이동).
   `allowDowngrades: true`이므로 비교자가 "버전이 다르면 업데이트"로
   동작해 N-1(더 낮은 버전)도 유효 업데이트로 인정된다.
   - latest.json의 `version`은 반드시 N-1 실제 버전 문자열 — 부풀리면
     클라이언트가 매번 재업데이트를 시도한다.
   - 서명 검증은 그대로 적용 — N-1 아티팩트는 기존 서명 그대로 유효해야 함
     (개인키 재서명 불필요, 이미 릴리스된 `.sig` 사용).
3. **사용자 수신**: 각 클라이언트는 기존 자동 업데이트 주기로
   `check()` → N-1이 "update"로 보고됨 → 다운로드·서명 검증 →
   `installMode: passive`로 설치 → relaunch. 사용자 조치 없음
   (통상 업데이트와 동일 경로).
4. **store 안전**: 다운그레이드된 v1 앱이 v2 store.json을 읽어도
   신규 필드 보존(§1 단언). 이후 핫픽스 N'을 올리면 STEPS가 아니라
   declared=2 경로로 복귀 — 데이터 유실 없음.
5. **사후**: 회귀 수정본 N'(>N)을 새 릴리스로 배포해 latest.json을 다시
   정상 방향으로 복귀. N'은 반드시 N보다 높은 버전이어야 N 머신도
   업데이트를 받는다(다운그레이드 후 N에 머문 사용자 포함).
   - 주의: N을 완전히 제거하는 것이 아니라 latest.json이 가리키는 대상만
     바꾸는 것 — N을 지우면 이미 N을 받은 사용자만 N-1로 돌아간다
     (의도된 효과). N에 아직 오지 않은 N-1 사용자는 변화 없음.
6. **실행 권한**: GitHub Release 수정·latest.json 교체는 사용자 승인 대상 —
   Loop/에이전트가 자율 실행하지 않는다(PRD 합의: push·Release 금지).

## 5. 잔여 리스크·남은 문제
- **엔드포인트 변조 리스크(상수)**: allowDowngrades는 "이전 버전 설치"에 대한
  유일한 가드를 제거한다(플러그인 주석). 우리 모델에서 latest.json을 고칠 수
  있는 주체는 repo 쓰기 권한자뿐이고 서명 검증은 유지되므로, 공격자가 할 수
  있는 최악은 "이미 릴리스된 서명 아티팩트로의 다운그레이드" — 일반 업데이트
  경로와 동일 신뢰 수준이라 수용 판단. 필요 시 `require_signed_version`은
  별개 축(version-서명 불일치 아티팩트 거부) — 이번엔 미적용(기존 서명에
  trusted-comment 버전이 없을 수 있어 보수적 유지).
- **v3+ 스키마 추가 시 재검증 필요**: 신규 필드가 merge 친화적이 아닌
  변환(키 파괴·형식 변경)을 요구하면 다운그레이드 안전 재평가 — ARCH §5
  "알 수 없는 키 보존 merge 유지" 조항이 그 계약.
- 실 다운그레이드 배포 자체는 미실행(승인 대상) — 경로·절차만 확정.

## 6. 검증 실행 결과
- `npm run build` — OK (vite build 성공)
- `cargo fmt -- --check` — diff 없음 OK
- `cargo clippy --all-targets -- -D warnings` — 경고 0
- `cargo test` — 32/32 PASS
- `cargo build` — OK (conf 재파싱 포함)
- `powershell -File harness_setup/scripts/run-e2e.ps1` — **selftest 70/70 PASS**,
  E2E: PASS. 증거: `.devil/loop/qa-logs/guseok-qa-20261118-202348.log`
  (store 스냅샷→복원 수행, app·vite 프로세스 종료, 5183/9223 잔재 0 확인).

## 변경 파일
- `src-tauri/tauri.conf.json` — plugins.updater.allowDowngrades: true
- `src/selftest.js` — MAX_INDEXES import + 다운그레이드 시뮬레이션 2케이스 (+70건)
- `.devil/loop/phase-06-task-02/attempt-1.md` — 이 파일
