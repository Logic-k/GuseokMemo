---
gate: lint
command: npm run build; cargo fmt --manifest-path src-tauri/Cargo.toml -- --check; cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
applies: verification 키에 lint가 있는 모든 태스크
---

# 게이트 — lint (정적 오류)

## 대상·근거

Rust 소스 전체(`src-tauri/`). NFR-05 검증 게이트와 TRD TD-13의 1~3번째 단계.
`tauri::generate_context!`가 컴파일 타임에 `frontendDist`(dist/)를 평가하므로
**Rust 명령 전에 `npm run build` 선행이 필수**다.

## 명령

```powershell
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

## 통과 조건

- 세 명령 모두 종료 코드 0.
- fmt diff 없음, clippy 경고 **0건** (`-D warnings`로 경고=오류 승격).
- JS 측(vite build)은 `npm run build`의 성공으로 간접 검증 — 별도 JS 린터 없음
  (미도입 — package.json에 eslint/biome 없음. 도입 결정은 Loop 밖 논의).

## 전제·활성 범위

- `npm install` 완료 상태. `check-env.ps1`로 선점검 가능.
- fmt/clippy 미설치 시 `rustup component add rustfmt clippy` (허용된 로컬 준비).
- 판정 중 소스 자동 수정 금지 — `cargo fmt`(쓰기)·`--fix`는 **구현 단계**에서만.
  lint 실패는 구현자에게 돌려보내 고친 뒤 이 판정을 무효화하고 재실행한다.
- 문서·plan_setup 전용 변경 태스크(`verification`에 lint 없음)에는 적용하지 않는다.
