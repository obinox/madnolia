# 보안 감사 보고서 — 2026-10-29

- **판정:** 엄격한 보안 승인 기준을 충족하지 못함. 실제 브라우저에서 모델 캐시 인덱스 변조 시 다른 워크스페이스 파일을 삭제하는 **확정 높음(High)** 데이터 무결성 결함이 재현됐다. GitHub Pages 동일 출처에 배포된 다른 프로젝트 코드가 존재할 때의 조건부 로컬 데이터 위험도 확인됐다.
- **공격 한계:** 익명 원격 코드 실행, OS 경계 탈출, 실제 사용자 파일 삭제·유출은 입증하지 못했다. 확정 삭제 재현은 합성 OPFS 파일만 사용했다. 결함 전제에는 변조된 워크스페이스 인덱스와 사용자의 정상 캐시 삭제 동작이 필요하다.
- **범위:** 커밋 `49a97e2d9aaf35959e55cf568542b570a405a574`, 공개 배포 [obinox.github.io/madnolia](https://obinox.github.io/madnolia/), 관련 브라우저 워크스페이스·모델 캐시·미디어 처리 코드, 배포 워크플로와 의존성 감사. 날짜는 한국시간 기준.

## 배포 및 검증 근거

성공한 Pages 배포 [run 40782525672](https://github.com/obinox/madnolia/actions/runs/40782525672)은 `main`의 범위 커밋과 일치한다. 실행 시작은 `2026-10-28T22:46:36Z`. 배포 HTML GET은 HTTPS에서 200이었으며 로컬 `web/dist/index.html`과 바이트 단위로 같았다. `index`, `workspace`, `modelCache`, `router`, `analysis.worker`, `BrowserWorkspace` JS 6개도 로컬 산출물과 SHA-256이 일치했다. 모든 WASM 바이트를 대조한 것은 아니며, Vite 파일명의 콘텐츠 해시는 보안 무결성 통제가 아니다.

저장소의 Node 테스트는 **57/57 통과**했다. 원래 `tests/browser-static-smoke.mjs`는 워크스페이스 허용 버튼이 아직 비활성화된 시점에 클릭해 실패했다. 감사용 진단 스크립트는 버튼 활성화를 기다린 뒤 하위 경로 자산, 폴더 선택·새로고침, 외부 API 네트워크 부재를 통과했다. 원래 테스트를 수정하거나 통과했다고 보고하지 않는다. 앱 소스는 변경하지 않았고 새 빌드는 수행하지 않았다. 배포물은 기존 로컬 빌드 산출물과 비교했다.

## 주요 런타임 검증 결과

| ID / 심각도 | 관찰 및 영향 | 전제·경계 |
|---|---|---|
| **R1 — 높음: 캐시 경로 혼동으로 임의 워크스페이스 하위 항목 삭제** | 실제 `deleteCachedModel()`에 인덱스 항목 `path: "projects/victim"`를 제공하고 해당 모델 삭제를 실행하자, 별도 합성 프로젝트의 `project.json`이 재귀 삭제됐다. 같은 인덱스 경로 사용으로 무관한 `unrelated-synthetic/secret.bin`의 합성 내용도 캐시 `match()` 응답으로 읽혔다. 근본 원인은 인덱스에서 읽은 경로를 고정된 캐시 루트에 제한하거나 검증하지 않는 점이다. | 변조된 캐시 인덱스가 있는 워크스페이스를 사용자가 연결하고, 캐시 삭제 작업이 실행되어야 한다. 모델 관리 화면의 확인은 캐시 모델 삭제만 알리고 다른 프로젝트 데이터 삭제는 드러내지 않는다. 임의 사이트의 무인증 OS 파일 삭제나 외부 유출을 뜻하지 않는다. |
| **R2 — 높음(조건부): Pages 경로 간 같은 출처 저장소 공유** | 브라우저에서 `/madnolia/`가 저장한 IndexedDB 핸들과 OPFS 표식을 같은 출처의 `/other-project/`에서 실제로 읽었다. `localhost`와 `127.0.0.1`은 다른 출처여서 저장소가 분리됐다. | `https://obinox.github.io/<다른 프로젝트>/`에 신뢰할 수 없는 또는 침해된 스크립트가 있고, 브라우저가 파일 권한을 계속 허용한 경우 로컬 작업공간 위험이 생긴다. 모든 `github.io` 사용자나 모든 호스트 간 공유는 아니다. 런타임 시험은 권한 API를 스텁 처리했으므로 네이티브 권한 지속·OS 프롬프트 우회는 입증하지 않았다. |

### R1 안전 재현 요약

감사 전용 임시 프로필과 합성 OPFS에 `projects/victim/project.json`을 만들고, 합성 캐시 인덱스 항목의 `path`를 `projects/victim`으로 지정했다. 프로덕션 `deleteCachedModel()`을 해당 항목의 모델 ID로 호출했을 때 파일이 존재에서 부재로 바뀌었다. 사용자 폴더, 실제 모델 캐시, 비밀값은 사용하지 않았다. 소스 근거는 [`modelCache.ts`](../web/src/browser/modelCache.ts#L149)와 [`workspace.ts`](../web/src/browser/workspace.ts#L221)다.

## 조건부 구조·공급망 위험

| 심각도 | 관찰 | 권고 순서 |
|---|---|---|
| **높음(조건부)** | R2의 출처 구조상 동일 `github.io` 호스트의 다른 프로젝트 스크립트와 IndexedDB/OPFS 저장소를 공유한다. 경로 접두사나 DB 이름만 바꾸면 출처 격리가 되지 않는다. | 민감한 사용자 파일 권한을 유지해야 한다면 전용 출처(예: 별도 호스트명) 배포를 우선 검토한다. 전환 시 이전 출처 권한의 취소와 새 출처 재연결 안내도 설계한다. 다른 `github.io` 프로젝트 신뢰 경계를 별도로 검토한다. |
| **중간(조건부)** | `.github/workflows/release.yml:6-9`의 `contents:read`, `pages:write`, `id-token:write` 권한이 전체 워크플로에 부여되어 빌드·테스트 작업도 배포 권한을 가진다. Actions는 `@v5`/`@v4` 등 이동 가능한 태그를 사용한다. | 필요한 권한을 배포 작업 단위로 축소하고, 서드파티 Actions를 검토한 검증된 전체 커밋 SHA 또는 지원되는 워크플로 의존성 잠금 파일로 고정한다. |
| **중간(조건부)** | 공개 저장소의 Pages 환경은 `main` 브랜치만 허용하지만 승인자·대기 게이트가 없다. 확인 당시 `main`은 브랜치 보호 및 ruleset이 없고 직접 변경이 가능했다. 워크플로는 수동 실행만 허용하며 `pull_request_target`이나 비신뢰 PR 입력은 확인되지 않았다. 이는 실제 침해 증거가 아니라 검토되지 않은 변경의 배포 가능성이다. | 조직 정책에 맞춰 `main` 필수 검토·검사와 배포 승인 통제를 구성한다. GitHub 설정은 이번 감사에서 변경하지 않았다. |
| **중간(노출 축소)** | Pages 응답은 `Access-Control-Allow-Origin: *`를 반환했다. 공개 정적 파일에 대한 와일드카드 응답만으로 사용자 로컬 파일에 접근할 수 있다는 증거는 없다. CSP 응답 헤더·메타, `X-Frame-Options`, 명시적 `Referrer-Policy`, `nosniff`, `Permissions-Policy`, COOP/COEP는 관찰되지 않았다. | 지원 호스팅 경계에서 정책 헤더를 제공하고, 특히 프레이밍 제한은 `frame-ancestors` 응답 헤더를 사용한다. `frame-ancestors`는 CSP 메타에서 지원되지 않는다. 표준 GitHub Pages에 `_headers` 파일이 적용된다고 가정하지 말고 실제 호스팅 지원 여부를 확인한다. 현재 부재만으로 취약점 악용을 입증한 것은 아니다. |

## 의존성 감사

현재 잠금 파일을 대상으로 한 `npm audit` 결과는 **높음 4, 심각 0**이다. 4건은 취약한 의존성 묶음 수이지, 브라우저에서 악용 가능한 결함 4개가 확인됐다는 뜻이 아니다.

| 패키지 | 감사 결과와 실제 노출 범위 | 권고 |
|---|---|---|
| `@huggingface/transformers 3.8.1` / `sharp 0.34.5` | `sharp`의 libvips/libheif/librsvg 관련 [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj), [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c), [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w). 브라우저 번들은 `sharp`와 `onnxruntime-node`를 제외한다. 네이티브 Node 이미지 라이브러리가 브라우저로 제공되거나 CI에서 신뢰 불가 이미지를 파싱한다는 사실은 확인하지 못했다. | 잠금 파일·번들 구성을 확인하며 업데이트를 검토한다. 감사가 제시한 Transformers `4.3.2`는 메이저 변경이므로 호환성 검증 없이 강제 업데이트하지 않는다. |
| `source-map-js 1.2.1` | [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q), 수정 버전 `1.2.2`. 빌드 도구 전이 의존성이며 Pages에서 소스맵 처리 서비스를 제공한다는 증거는 없다. | 잠금 그래프를 검토해 수정 버전으로 업데이트한다. |
| `vite 8.3.0` | [GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm), [GHSA-698v-4r3x-3vcv](https://github.com/advisories/GHSA-698v-4r3x-3vcv), [GHSA-r825-w8mm-5pxw](https://github.com/advisories/GHSA-r825-w8mm-5pxw), [GHSA-9jrq-w75r-8gcw](https://github.com/advisories/GHSA-9jrq-w75r-8gcw), [GHSA-rq7h-c2jc-7f22](https://github.com/advisories/GHSA-rq7h-c2jc-7f22), [GHSA-vfpm-58rq-9qcg](https://github.com/advisories/GHSA-vfpm-58rq-9qcg). Pages에서 Vite 개발 서버를 실행하지 않는다. Windows `launch-editor` 계열은 Ubuntu CI 조건과 다르다. | 감사가 제안한 `8.3.5` 업데이트를 검토하고 개발 서버 관련 사용 조건을 확인한다. |

`web/package.json`의 일부 선언이 `latest`여도 CI는 커밋된 `web/package-lock.json`으로 `npm ci`를 실행하므로 매 배포가 자동으로 최신 패키지를 받는 것은 아니다. 잠금 파일은 변경하지 않았다.

## 방어 검토 및 미확정 사항

- [`workspace.ts`](../web/src/browser/workspace.ts#L140)는 `..`, 절대 경로, 역슬래시, 빈·점 경로 조각을 거부했고, 런타임 시험의 형제 OPFS 표식도 유지됐다. `%2e%2e`와 `%252e%252e`는 디코딩되지 않은 문자 그대로 허용됐다. 경로 탈출은 재현되지 않았다.
- [`workspace.ts`](../web/src/browser/workspace.ts#L108)는 알려진 내부 디렉터리만 확인한다. 합성 개인 파일을 둔 임의 폴더도 워크스페이스로 받아들여졌으며 파일은 보존됐다. 과도하게 넓은 폴더 선택 방지의 개선 여지는 있지만 데이터 손상 증거는 아니다.
- 캐시 인덱스 `null`과 `{entry:null}`은 `TypeError`를 냈고 배열·숫자는 빈 목록처럼 처리됐다. 스키마 검증 부족은 확인했으나 프로토타입 오염, XSS, RCE는 입증하지 않았다.
- **중간(조건부): 모델 revision 및 콘텐츠 무결성 위험.** 분석 워커는 모델 `revision`을 지정하지 않는다([`analysis.worker.ts`](../web/src/browser/analysis.worker.ts#L34)); 라이브러리 기본값은 Hugging Face `main`이다. 모델 ID는 [`analysis.ts`](../web/src/browser/analysis.ts#L403)에서 허용 목록으로 제한된다. 캐시 키 SHA-256은 URL 문자열 해시일 뿐 파일 내용 해시가 아니며, 스트리밍 응답 크기 상한도 없다([`modelCache.ts`](../web/src/browser/modelCache.ts#L16), [`modelCache.ts`](../web/src/browser/modelCache.ts#L54)). 원격 모델 변경·캐시 오염이 추론 결과와 저장공간을 위협할 수 있지만, 모델 가중치 다운로드가 JavaScript 실행이나 호스트 RCE라는 뜻은 아니다.
- Transformers, ONNX Runtime WASM 및 FFmpeg 실행 자산은 번들에 포함된 로컬 빌드 자산이며 라이브러리 CDN 기본 주소는 재정의된다([`analysis.worker.ts`](../web/src/browser/analysis.worker.ts#L1), [`ffmpeg.ts`](../web/src/browser/ffmpeg.ts#L1)). 첫 모델 사용 시 Hugging Face 요청에서 IP와 모델 요청 정보가 노출될 수 있다. 오디오 업로드 경로는 확인되지 않았고, 이번 감사에서 새 ASR 추적은 수행하지 않았다.
- 미디어 입력은 1 GB·30분, MP4는 10분 제한이 있으나 일부 디코딩·FFmpeg 작업 전에 비용을 제한하지 못할 수 있다. FFmpeg 실행 제한 상수는 `-1`이며 JSON·레코드·다운로드 전체 크기 제한은 충분히 확인되지 않았다. 서비스 거부 가능성은 조건부이며 OOM은 시험하지 않았다.
- 검토한 앱 경로에서 React raw HTML 삽입 싱크는 발견되지 않았고, FCPXML 이스케이프와 파일명 정리를 확인했다. 모든 의존성 싱크·내보내기 입력 형태를 퍼징한 것은 아니다.

## 권고 조치 순서

1. **R1을 먼저 수정:** 캐시 인덱스 스키마를 검증하고 모든 캐시 경로를 캐시 루트 내부의 예상 경로·모델 ID에 결속한다. 삭제 전에도 경로를 검증하고, 잘못된 인덱스에서는 파괴 작업을 중단한다. 기존 잘못된 인덱스의 안전한 복구 동작도 설계한다.
2. **저장소 격리 결정:** GitHub Pages 동일 출처의 사용자 지정 프로젝트를 신뢰 경계로 삼을 수 없다면 앱을 전용 출처로 옮긴다. 경로/DB 이름 변경만으로 해결된다고 보지 않는다.
3. **배포 경계 강화:** Actions 권한을 작업별 최소 권한으로 좁히고 검증된 전체 커밋 SHA 또는 지원되는 워크플로 의존성 잠금 파일을 사용하고 `main` 검토·검사 정책을 검토한다.
4. **업데이트 및 자원 경계:** 패키지 권고를 잠금 파일 단위로 검토하고, 모델 revision·내용 검증과 다운로드 크기 제한, 미디어/작업량 제한의 적용 시점을 점검한다.
5. **배포 헤더 검토:** 실제 호스팅에서 설정 가능한 CSP·프레이밍·기본 보안 헤더를 확인하고 라이브 응답으로 검증한다. 헤더 하나가 R1 또는 출처 공유를 해결하지는 않는다.

## 증거 및 출처

감사 중 생성된 로컬 증거는 `.runtime-audit/security-pages-20261029/`에 있으며 Git 추적 대상이 아니다. 핵심 파일: [브라우저 런타임 결과](../.runtime-audit/security-pages-20261029/browser-security-runtime-report.md), [구조화 결과 JSON](../.runtime-audit/security-pages-20261029/browser-security-runtime.json), [라이브 응답 헤더](../.runtime-audit/security-pages-20261029/deployed-headers.json), [배포 자산 해시](../.runtime-audit/security-pages-20261029/deployed-asset-hashes.json), [공개 경로 응답](../.runtime-audit/security-pages-20261029/public-path-checks.json), [npm 감사 JSON](../.runtime-audit/security-pages-20261029/npm-audit.json). 결과 재현용 명령은 증거 보고서에 기록돼 있다.
외부 기술 근거: [File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access), [파일 시스템 권한 지속](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api), [GitHub Pages 동작](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages), [GitHub Actions 안전 사용](https://docs.github.com/en/actions/reference/security/secure-use), [CSP `frame-ancestors`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors).

**감사 범위 제한:** 이는 지정 커밋·배포·검토 경로에 대한 엄격한 보안 검증이지, 전체 저장소 형식 검증이나 실제 사용자 환경 침투 시험이 아니다. 이번 감사는 프로덕션 수정, 배포, 권한/GitHub 설정 변경, 사용자 데이터 접근을 수행하지 않았다.
