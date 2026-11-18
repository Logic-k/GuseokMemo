---
gate: unit
command: cargo test --manifest-path src-tauri/Cargo.toml
applies: verification 키에 unit이 있는 태스크
---

# 게이트 — unit (기능/계약 단위 검증)

## 대상·근거

- **Rust**: `src-tauri/`의 순수 로직 — `#[cfg(test)]` 단위 테스트.
- **JS**: `migrate()`·검색 코어·스니펫 치환 같은 순수 로직 — **전용 러너(vitest 등)
  미도입**(TD-12). `src/*.js`는 `@tauri-apps/api`를 import해 node 직행 불가이므로
  JS 단위 단언은 **selftest 케이스**(e2e 게이트)로 커버한다.

## 명령

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
```

## 통과 조건

- 종료 코드 0, 실패 0.
- **테스트 0건은 PASS 증거가 아니다.** 태스크가 Rust 순수 로직을 추가·변경하는데
  `cargo test`가 0건이면 해당 태스크의 unit 기준 미충족으로 본다 — 구현 단계에서
  `#[cfg(test)]` 테스트를 동반해야 한다 (예: rename 재시도 백오프, 리마인더 다음-at
  계산, mtime 자기에코 억제, config.json 포인터 해석 — phase-01/03/04 코어 태스크).
- JS 순수 로직 수용 기준은 이 게이트가 아니라 태스크가 지정한 selftest/단언 위치로
  판정한다 — e2e 게이트 결과와 함께 본다.

## 전제·활성 범위

- `npm run build`로 `dist/` 존재 (`generate_context!` 컴파일 전제).
- `tauri::test` MockRuntime은 unstable — 도입하지 않는다. 커맨드 로직은 순수 함수로
  분리해 테스트하는 것이 원칙 (q04 §4).
- 현재 main.rs에 `#[cfg(test)]` 없음 — **기준선 0건을 명시**해 두고, 신규 로직
  태스크부터 테스트 존재를 요구한다.
