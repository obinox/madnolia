# Madnolia 전문 합성 편집기 명세

- 문서 상태: 구현 동작
- 문서 버전: 1.0
- 작성일: 2026-09-29

## 1. 목적

전문 합성 편집기는 분석된 원본 영상의 발음을 재료로 사용해 새로운 문장을 만드는 보컬로이드형 영상·음성 편집기다.

사용자는 문장을 음소로 변환하고, 원본에서 선택한 연속 구간을 타임라인에 배치한다. 전문 편집은 원본 음성 조각을 연속으로 유지하며, 구간별 상대 음높이·길이·음량·앞 조각과의 겹침을 편집한다. WAV와 영상은 같은 구간 시간 매핑을 사용한다.

> **구현 기준:** 이전 PhoneUnit 피아노롤과 2레인 동작을 설명하는 세부 항목은 레거시 합성 포맷 참고용이다. 현재 편집 동작과 완료 기준은 §23–24의 연속 조각·EditRegion 스키마를 따른다. 새 편집에는 F0 분석이 필요하지 않다.

## 2. 제품 모드

### 2.1 단순 합성

현재 합성 작업 흐름을 유지하는 빠른 조립 모드다.

- 문장 입력 및 음소 변환
- 후보 검색과 순차 배치
- 기본 길이 조절
- 공통 크로스페이드
- 현재 저장 형식과의 하위 호환

### 2.2 전문 합성

연속 음성 조각과 그 안의 비파괴 편집 구간을 다루는 모드다.

전문 합성은 독립 원본이 아니라 저장된 단순 합성을 부모로 참조하는 파생 편집본이다. 부모 합성 ID와 부모의 수정 시각을 저장하며, 부모가 변경되면 전문 합성을 원본에서 다시 생성하기 전까지 저장과 내보내기를 막는다.

- 정확 발음과 유사 발음 통합 검색
- 음소 삽입·누락·교체를 포함한 연속 구간 검색
- 한 줄 조각 타임라인과 내부 구간 선택
- 센트 단위 상대 음높이와 비율 기반 길이 편집
- 조절 가능한 음량 봉투와 실제 타임라인 겹침
- 오디오와 영상의 동기화된 리타이밍

3번 합성 화면은 단순 합성만 편집한다. 4번 전문 편집 화면은 저장된 단순 합성을 불러와 전문 합성 파생본을 생성한다. 전문 합성을 단순 합성으로 역변환하는 기능은 필수 범위에 포함하지 않는다.

## 3. 핵심 용어

| 용어 | 의미 |
| --- | --- |
| Composition | 저장 가능한 합성 편집 프로젝트 |
| Part | 하나의 연속된 원본 영상 구간을 참조하는 타임라인 조각 |
| EditRegion | 원본 조각을 연속으로 유지하면서 상대 음높이와 출력 길이를 기록하는 논리 구간 |
| Target phone | 입력 문장에서 요구하는 목표 음소 |
| Source phone | 원본 영상에서 실제로 선택된 음소 |
| PhoneUnit | 레거시 전문 합성에서 음소별 길이·피치를 저장하는 호환 데이터 |
| Pitch transition | 레거시 PhoneUnit 렌더링에서 사용하는 피치 연결 설정 |
| Ripple edit | 앞 요소의 변경량만큼 뒤 요소가 연쇄적으로 이동하는 편집 방식 |
| Guide point | 원본 phone START 위치를 기본값으로 삼는 편집 구획점. 원본 오디오를 자르지 않는다 |

## 4. 기본 작업 흐름

1. 3번 합성 화면에서 문장을 변환하고 후보를 검색한다.
2. 후보를 배치한 뒤 단순 합성을 저장한다.
3. 4번 전문 편집 화면에서 부모 단순 합성을 선택한다.
4. 시스템이 부모의 연속 음성 조각을 전문 편집 타임라인으로 불러온다.
5. 조각 몸통을 끌거나 숫자 경계를 입력해 내부 구간을 선택하고 안내점을 편집한다.
6. 선택 구간의 센트 피치와 출력 길이를 바꾼다. 길이 변경은 뒤 조각을 리플 이동한다.
7. 오디오·영상 통합 프리뷰로 결과를 확인한다.
8. 부모 참조를 유지한 전문 합성을 저장하거나 내보낸다.

## 5. 음소 변환

- 현재 한국어 발음형 및 IPA 변환 체계를 재사용한다.
- 변환 결과는 문자, 발음형, 내부 phone ID, IPA, 목표 순번을 포함한다.
- 사용자는 변환된 목표 음소열을 확인할 수 있어야 한다.
- 자동 변환 결과의 수동 수정은 초기 필수 범위에서 제외한다.

## 6. 후보 검색

### 6.1 검색 범위

- 정확 후보가 존재해도 유사 후보를 함께 검색한다.
- 단일 음소와 연속 음소열을 모두 검색한다.
- 유사 음소가 후보의 처음, 중간, 끝에 포함된 경우를 모두 허용한다.
- 목표와 원본 사이의 음소 교체, 삽입, 누락을 허용한다.
- 원본 후보는 시간상 연속된 구간이어야 한다.

### 6.2 정렬 연산

검색 결과는 목표 음소열과 원본 음소열을 다음 연산으로 정렬한다.

| 연산 | 의미 |
| --- | --- |
| MATCH | 목표와 원본 음소가 정확히 일치 |
| SUBSTITUTE | 유사하지만 다른 음소로 대응 |
| INSERT | 원본에만 음소가 존재 |
| DELETE | 목표에만 음소가 존재 |

삽입된 원본 음소는 실제 출력에 포함될 수 있으므로 후보 UI에서 명확하게 경고한다. 누락된 목표 음소는 미충족 상태로 표시하고 다른 후보를 추가할 수 있게 한다.

### 6.3 음소 유사도

유사도는 단순한 고정 교체 목록이 아니라 음성학적 특징을 기준으로 계산한다.

- 자음: 조음 위치, 조음 방법, 유성성, 기식, 긴장도
- 모음: 혀의 높이, 전후 위치, 원순성
- 자음과 모음 사이의 대응은 허용하지 않는다.
- 정확 일치 점수는 항상 유사 일치보다 높다.
- 교체, 삽입, 누락에는 각각 별도의 감점값을 적용한다.

### 6.4 후보 점수

후보 순위에는 다음 요소를 반영한다.

- 음소열 유사도
- 연속으로 일치한 음소 수
- 삽입·누락·교체 횟수
- 정렬 신뢰도
- 원본 음소의 분석 신뢰도
- 음량과 음질
- 피치 검출 안정성
- 음소 사이 원본 시간 간격

가중치는 공통 설정 파일에서 관리하며 검색 로직 내부에 임의로 정의하지 않는다.

### 6.5 후보 표시

후보에는 다음 정보를 표시한다.

- 목표 음소열과 실제 원본 음소열
- MATCH, SUBSTITUTE, INSERT, DELETE 위치
- 종합 유사도
- 원본 영상 이름과 재생 구간
- 분석 신뢰도
- 대표 피치
- 미리 듣기 및 원본 영상 보기

## 7. 전문 편집 화면

전문 편집 화면은 OpenUtau 계열의 상·하 편집 레이아웃을 사용하며 다음 영역을 가진다.

1. 부모 단순 합성 및 전문 편집본 선택 영역
2. 영상 Part 트랙 A/B와 재생 헤드
3. 피아노롤과 음소 블록
4. 선택 요소 속성 패널
5. 프리뷰·저장·내보내기 영역

모든 시간 기반 영역은 동일한 확대 배율, 수평 스크롤 위치와 재생 헤드를 공유한다.

## 8. 영상 Part 타임라인

### 8.1 레거시 2레인 표시

Part는 가독성을 위해 A/B 두 레인에 위·아래로 교차 배치한다. 두 레인은 별도의 믹싱 채널이 아니라 시간상 겹침을 보여주는 시각적 레인이다.

동시에 재생되는 Part는 최대 두 개로 제한한다.

```text
part[i].timeline_start >= part[i - 2].timeline_end
```

제약을 위반하는 드래그, 길이 변경 또는 겹침 입력은 허용 범위로 제한하고 사용자에게 이유를 표시한다.

### 8.2 상대 위치

첫 Part를 제외한 모든 Part는 앞 Part와의 관계로 배치한다.

```text
part[0].timeline_start = 0
part[i].timeline_start = part[i - 1].timeline_end + part[i].gap_before
part[i].timeline_end = part[i].timeline_start + part[i].output_duration
```

- `gap_before > 0`: 무음 또는 빈 영상 구간
- `gap_before = 0`: 맞닿음
- `gap_before < 0`: 앞 Part와 겹침

Part의 길이, 순서, 원본 구간 또는 앞 간격이 바뀌면 이후 모든 Part를 자동으로 리타이밍한다. 절대 타임라인 위치는 파생값으로 취급한다.

### 8.3 Part 편집 항목

- 원본 영상
- 원본 시작·종료 시점
- 앞 Part와의 간격 또는 겹침
- 출력 재생 길이
- 페이드 인 시작·종료 위치
- 페이드 인 강도
- 페이드 아웃 시작·종료 위치
- 페이드 아웃 강도
- 페이드 곡선
- 포함된 PhoneUnit 목록

## 9. 원본 구간 편집

- Part의 시작·종료 핸들은 기본적으로 분석된 음소 경계에 스냅한다.
- 사용자는 스냅을 일시적으로 해제해 프레임 또는 밀리초 단위로 편집할 수 있다.
- 원본 영상 범위를 벗어나는 편집은 금지한다.
- 경계 변경으로 제외된 PhoneUnit은 Part에서 제거한다.
- 새로운 음소 경계를 포함하도록 범위를 늘린 경우 해당 PhoneUnit을 Part에 추가할 수 있다.
- 경계 변경 후 피치·길이 편집값을 유지할 수 없는 PhoneUnit은 사용자 확인 없이 임의 재매핑하지 않는다.

## 10. 음소 길이 편집

- 각 PhoneUnit은 독립적인 출력 길이를 가진다.
- 가로 핸들 드래그 또는 숫자 입력으로 편집한다.
- 단축과 연장을 모두 허용한다.
- Part 출력 길이는 포함된 PhoneUnit 출력 길이와 내부 전환 구간을 기반으로 계산한다.
- 음소 길이 변경은 해당 Part 이후의 모든 Part 위치에 리플 반영한다.
- 오디오와 영상은 동일한 시간 매핑을 사용한다.

초기 권장 범위는 원본 음소 길이 대비 1%~3200%다. 실제 제한값은 공통 설정으로 관리한다.

극단적인 단축·연장에서는 품질 저하 가능성을 표시하되 편집 자체를 즉시 차단하지 않는다.

## 11. 피치 편집

### 11.1 상대 음높이

- 사용자는 정수 센트로 상대 음높이를 지정하며 100센트는 반음이다.
- 편집과 렌더링에는 원본 F0 분석이나 절대 음높이 검출이 필요하지 않다.
- 렌더러는 음성 구간 전체에 상대 이동을 적용한다. 0센트·기본 길이는 원본 샘플을 그대로 보존한다.

### 11.2 구간 입력

- 상대 음높이와 선택 범위의 시작·끝은 숫자로 입력할 수 있다.
- 드래그 선택은 인접 구간의 출력 시간에서 원본 시간으로 조각별 선형 변환한다.

### 11.3 무성음 처리

- 피치가 없는 무성 자음은 원음을 유지한다.
- 무성 PhoneUnit에는 일반 피치 블록을 표시하지 않는다.
- F0가 없는 구간을 포함해 선택한 전체 구간에 상대 피치 처리를 적용한다.
- 무성 자음을 임의의 음계로 합성하는 기능은 초기 범위에서 제외한다.

### 11.4 포먼트

- 피치 이동 시 화자의 음색을 유지하도록 포먼트 보존을 기본값으로 사용한다.
- 기존 전문 파일의 PhoneUnit 포먼트 설정은 레거시 경로에서 보존한다. 새 구간 스키마는 이를 변환하거나 추정하지 않는다.

## 12. 피치 전환

인접한 유성 PhoneUnit의 목표 피치가 다르면 기본적으로 부드러운 전환을 생성한다.

### 12.1 조절 항목

| 항목 | 의미 | 초기 권장값 |
| --- | --- | --- |
| transition duration | 피치 이동에 사용하는 시간 | 80ms |
| transition strength | 목표 피치 사이 보간 적용량 | 100% |
| transition curve | 보간 곡선 | smooth |
| transition center | 음소 경계를 기준으로 한 전환 중심 이동 | 0ms |

- 전환 시간 0ms는 즉시 피치 변경을 뜻한다.
- 전환 강도 0%는 자동 연결을 적용하지 않음을 뜻한다.
- 전환 중심이 음수면 앞 음소 쪽에서 일찍 시작하고, 양수면 뒤 음소 쪽에서 늦게 시작한다.
- 전환 시간은 양쪽 PhoneUnit의 사용 가능한 유성 구간을 넘을 수 없다.

초기 권장 입력 범위는 다음과 같다.

- 전환 시간: 0~500ms
- 전환 강도: 0~100%
- 전환 중심: -250~250ms

범위와 기본값은 공통 설정으로 관리한다.

### 12.2 적용 범위

- Composition에 전역 기본값을 둔다.
- 각 음소 경계는 전역 기본값을 개별적으로 덮어쓸 수 있다.
- Part 경계를 넘는 피치 전환도 두 Part가 시간상 연결되어 있으면 허용한다.
- INSERT 또는 DELETE 경계에서는 자동 전환 결과를 미리 듣고 수동 수정할 수 있어야 한다.
- 한쪽이 무성음이면 유성 구간 안에서만 전환을 마치고 무성 구간에는 피치를 적용하지 않는다.

## 13. 페이드와 크로스페이드

각 Part의 양 끝에 독립적인 볼륨 엔벌로프를 둔다.

- fade-in 시작 위치
- fade-in 종료 위치
- fade-in 강도
- fade-out 시작 위치
- fade-out 종료 위치
- fade-out 강도
- 곡선 종류

두 Part가 겹치지 않으면 일반 페이드로 동작한다. 두 Part가 겹치면 같은 엔벌로프 설정이 크로스페이드로 동작한다.

초기 곡선은 linear와 equal-power를 지원한다. 기본값은 equal-power다.

페이드 범위가 Part 길이를 넘거나 3중 겹침을 만들 수 없도록 검증한다.

## 14. 오디오 처리

처리 순서는 다음을 기본으로 한다.

1. 원본 구간 디코딩
2. 음소 경계 기반 분할
3. PhoneUnit별 시간 확장·축소
4. PhoneUnit별 피치 이동
5. 포먼트 보존 또는 이동
6. 피치 전환 적용
7. PhoneUnit 재결합
8. Part 페이드 적용
9. 타임라인 합성
10. 출력 정규화 및 인코딩

시간 조절과 피치 조절은 서로 독립적이어야 한다. 길이를 변경해도 목표 피치가 변하지 않고, 피치를 변경해도 PhoneUnit의 출력 길이가 변하지 않아야 한다.

실시간 프리뷰에는 낮은 지연의 임시 품질을 사용할 수 있다. 최종 내보내기는 고품질 처리 경로를 사용한다.

## 15. 영상 처리

- 각 PhoneUnit의 원본 구간과 출력 구간 사이에 시간 매핑을 생성한다.
- PhoneUnit을 늘리면 대응 영상 구간을 느리게 재생한다.
- PhoneUnit을 줄이면 대응 영상 구간을 빠르게 재생한다.
- 하나의 Part 안에서도 PhoneUnit별로 서로 다른 재생 속도를 허용한다.
- 프레임 보간 사용 여부는 출력 설정으로 제공할 수 있다.
- Part 겹침 구간의 영상 합성 방식은 기본 컷 또는 디졸브로 처리한다.
- 오디오와 영상의 최종 길이는 항상 일치해야 한다.

## 16. 편집 동작

### 16.1 선택

- Part 선택
- 단일 PhoneUnit 선택
- 연속 PhoneUnit 다중 선택
- 음소 경계 선택
- 페이드 핸들 선택

### 16.2 주요 조작

- 드래그로 음소 길이 변경
- 세로 드래그로 피치 변경
- 숫자 입력으로 정확한 길이·피치·전환값 지정
- Part 순서 변경
- 후보 교체
- Part 분할 및 결합
- 실행 취소 및 다시 실행
- 선택 구간 반복 재생
- 원본과 편집 결과 A/B 비교

### 16.3 스냅

- 원본 구간: 음소 경계 스냅 기본 활성화
- 타임라인 위치: 앞 Part 끝과 크로스페이드 경계 스냅
- 피치: 기본 비활성화
- 사용자 조작 중 일시적 스냅 해제를 지원한다.

## 17. 저장 모델

전문 Composition은 최소한 다음 정보를 저장한다.

### 17.1 Composition

- 스키마 버전
- 편집 모드
- 프로젝트 및 원본 참조
- 목표 문장과 발음형
- 전역 피치 전환 기본값
- 출력 설정
- Part 순서

### 17.2 Part

- 고유 ID
- 후보 및 원본 참조
- 원본 시작·종료 시점
- 앞 Part와의 상대 간격
- 파생된 출력 길이
- 레인 표시값
- 페이드 인·아웃 설정
- PhoneUnit 순서

### 17.3 PhoneUnit

- 고유 ID
- 목표 음소 인덱스
- 목표 및 원본 phone ID와 IPA
- 정렬 연산
- 원본 시작·종료 시점
- 원본 및 출력 길이
- 분석된 F0와 피치 신뢰도
- 목표 MIDI pitch
- cent 이동량
- 포먼트 이동량

### 17.4 PitchTransition

- 앞·뒤 PhoneUnit 참조
- 전역값 사용 여부
- 전환 시간
- 전환 강도
- 전환 중심
- 전환 곡선

Python과 TypeScript의 타입, 열거형, 제한값은 각각 지정된 공통 타입 및 공통 상수 파일에서 관리한다. 기능 파일 내부에 별도 타입이나 공통 제한값을 정의하지 않는다.

## 18. 검증 규칙

- 모든 원본 구간은 연결된 원본 영상 범위 안에 있어야 한다.
- 모든 출력 길이는 0보다 커야 한다.
- Part 순서는 목표 음소 순서와 모순되지 않아야 한다.
- 절대 타임라인 위치는 상대 배치값으로부터 다시 계산 가능해야 한다.
- 동시에 재생되는 Part는 최대 두 개여야 한다.
- 피치 전환은 존재하는 두 PhoneUnit을 참조해야 한다.
- 피치 전환 시간은 사용 가능한 유성 구간을 넘지 않아야 한다.
- 오디오와 영상의 PhoneUnit별 출력 길이는 같아야 한다.
- 저장 데이터가 유효하지 않으면 조용히 보정하지 않고 구체적인 오류를 표시한다.

## 19. 프리뷰

- 전체 Composition 재생
- 선택 Part 재생
- 선택 PhoneUnit 반복 재생
- 선택 경계의 피치 전환 반복 재생
- 원본/편집 결과 즉시 비교
- 재생 중 영상, 파형, 음소 블록과 피치 커서를 동기화
- 변경된 구간만 다시 렌더링하는 캐시 사용

## 20. 내보내기

- JSON: 모든 전문 편집 정보를 보존
- WAV: 최종 음성 합성 결과
- MP4: 리타이밍된 영상과 최종 음성
- EDL/FCPXML: 지원 가능한 편집 정보만 변환하고 손실 항목을 사용자에게 알림

피치 이동, 음소별 비선형 속도, 세밀한 피치 전환은 일반 EDL에서 완전히 표현할 수 없으므로 렌더링된 오디오 또는 중간 영상 자산을 함께 제공하는 방식을 고려한다.

## 21. 하위 호환과 마이그레이션

- 기존 합성은 단순 모드로 계속 불러올 수 있어야 한다.
- 기존 `stretch_percent`는 전문 모드 변환 시 PhoneUnit 출력 길이로 변환한다.
- 기존 전역 크로스페이드는 각 Part의 기본 페이드로 변환한다.
- 기존 절대 타임라인 위치는 앞 Part와의 상대 간격으로 변환한다.
- 원본 데이터는 변환 과정에서 덮어쓰지 않는다.
- 전문 모드 저장 형식에는 명시적인 스키마 버전을 둔다.

## 22. 단계별 구현 계획

### 1단계: 모델과 마이그레이션

- 단순/전문 모드 구분
- 전문 Composition, Part, PhoneUnit, PitchTransition 모델
- 상대 위치 계산 및 검증
- 기존 합성 변환

### 2단계: 유사 음소 검색

- 음성학적 특징 기반 유사도
- MATCH, SUBSTITUTE, INSERT, DELETE 정렬
- 연속 후보 검색과 점수화
- 후보 비교 UI

### 3단계: 전문 타임라인

- 2레인 Part 타임라인
- 음소 블록 편집
- 리플 편집
- 음소 경계 스냅
- 3중 겹침 방지
- 실행 취소 및 다시 실행

### 4단계: 오디오 편집

- 음소별 단축·연장
- 대표 피치 표시
- 자유 피치 이동
- 포먼트 보존
- 수치 조절 가능한 피치 전환
- Part별 페이드와 크로스페이드

### 5단계: 영상과 프리뷰

- 음소별 영상 리타이밍
- 오디오·영상 동기 프리뷰
- 부분 렌더 캐시
- MP4 출력

### 6단계: 고급 기능

- 음소 내부 피치 제어점
- 비브라토와 글라이드
- 음계 스냅
- 프레임 보간
- 포먼트 자동화

## 23. 1차 완료 조건

- 입력 문장이 음소열로 변환된다.
- 정확 후보가 존재해도 유사 후보가 함께 검색된다.
- 후보 중간의 교체·삽입·누락이 검색 결과에 포함된다.
- 후보를 전문 타임라인에 배치할 수 있다.
- Part의 원본 구간과 상대 배치를 편집할 수 있다.
- 조각이 한 줄에 표시되고 실제 겹침은 인접 조각 두 개로 제한된다.
- 임의 내부 범위를 선택하고 안내점을 추가·삭제할 수 있다.
- 상대 음높이를 1센트 단위로 지정하고 출력 길이를 1%~3200%로 조절한다.
- 선택 구간 길이 변경에 뒤 조각과 영상의 시간 매핑이 대응한다.
- 음량 점과 앞 조각과의 겹침을 조절한다.
- 저장 후 다시 열어 동일한 편집 상태를 복원할 수 있다.
- WAV와 MP4 결과의 오디오·영상 길이가 일치한다.

## 음소 검색 언어

- 검색 입력은 한국어·영어·일본어를 지원하고 자동 감지 또는 언어 직접 선택을 제공한다.
- 발음 변환은 한국어 G2P, 영어 CMU 발음 사전/예측 G2P, 일본어 Hepburn 변환 기반으로 수행한다.
- 언어별 음소 ID를 유지하되 조음 위치·방법·모음 자질을 이용해 언어 간 유사 음소를 검색한다.
- 중국어는 지원하지 않는다. 한자만 입력한 경우는 자동 판별할 수 없으므로 일본어를 직접 선택한다.

## 24. 구현 상태

### 기존 PhoneUnit 기능 및 호환 상태

- 단순/전문 합성 저장 모드와 기존 합성 복사 변환
- MATCH, SUBSTITUTE, INSERT, DELETE 기반 유사 음소열 검색
- 기존 PhoneUnit 기반 렌더러는 기존 저장 파일을 위해 유지한다.
- 느려진 영상 구간의 프레임 유지 방식 리타이밍
- 두 Part 겹침 구간의 영상 디졸브
- 전문 합성 MP4 출력

## 전문 구간 편집 스키마 (2026-09-30)

Professional segments now store `edit_regions`, a contiguous partition of the fragment's original source bounds. Each region has `region_id`, `source_start_ms`, `source_end_ms`, `output_duration_ms`, and integer `relative_pitch_cents`. Region starts are guided by existing phone START timestamps; detected phone ends are not used as source cuts. Adjacent regions with the same pitch and equivalent stretch after millisecond rounding are coalesced before DSP. Stretch changes output duration and ripples subsequent fragments. The same region map drives WAV and professional MP4 timing.

Segments store `volume_envelope` as normalized `{position, gain}` points. Position spans 0 to 1 and gain spans 0 to 2. Professional editing presents fragments in one horizontal sequence row. The envelope and overlap controls sit below it. Negative `gap_before_ms` creates actual adjacent-fragment timeline overlap; overlap rendering applies opposing fades and preserves user gain without mixer normalization.

Relative pitch uses integer cents, limited to -2400..2400. A zero-cent, unchanged-duration region returns the source PCM unchanged. Relative pitch rendering does not require source F0 or an absolute MIDI target.

새 단순 합성에서 파생본을 만들 때 phone START 위치를 안내점으로 사용하며, 부모 조각의 전체 출력 길이를 원본 구간 비율로 분배한다. Phone end 위치나 기존 음소 길이로 새 길이를 추론하지 않는다.

기존 전문 합성은 로드 시 변환하지 않는다. 기존 음소별 길이·삭제 음소의 무음·포먼트 이동·전환 설정은 기존 WAV/영상 렌더링 경로에서 계속 사용하며, 저장해도 해당 필드는 유지된다. 새 구간 편집으로 전환하는 동작은 사용자가 직접 선택해야 하고, 변환 안내에는 기존 음소별 포먼트·전환·삭제 무음이 새 스키마에 보존되지 않을 수 있음을 표시한다. 원본 파일을 자동 수정하거나 마이그레이션하지 않는다.

새 구간 스키마의 음소 안내 데이터는 검증 대상이 아니다. 음소 데이터가 새 구간의 길이·연속 범위·렌더링을 막지 않으며, 구간 경계 및 정수 센트·밀리초와 유한 음량 수치만 새 편집의 유효성을 결정한다.

## Implemented professional editor behavior (2026-10-01)

The professional editor displays each TimelineSegment as one syllable containing consecutive editable intervals. A left click selects the interval under the pointer without seeking or splitting. Right-clicking an audio interval adds a split at that source position. Right-clicking a user marker removes it; generated phone boundaries remain. Pitch and volume curve point add/delete behavior is unchanged.

Every interval boundary uses the selected interval's front/rear handle rules:

- NORMAL at an internal front boundary adds delta to the preceding interval and subtracts it from the selected interval. NORMAL at an internal rear boundary adds delta to the selected interval and subtracts it from the following interval. The syllable's start, end, and all other output boundaries stay fixed.
- NORMAL at the outer front moves the syllable start by delta and subtracts delta from its first interval. NORMAL at the outer rear adds delta to its last interval. All other boundaries stay fixed.
- CTRL at a front boundary moves the syllable start and every preceding boundary by delta, keeps preceding durations fixed, subtracts delta from the selected interval, and keeps the selected interval's rear and later boundaries fixed. CTRL at a rear boundary adds delta to the selected interval, moves that boundary and every following boundary by delta, and keeps following durations fixed.
- SHIFT moves the whole syllable by delta while preserving all interval durations and relative envelope positions. ALT does not edit.

Each pointer movement is calculated from the pointer-down snapshot, preserves fixed source bounds and region details, enforces nonnegative starts and the shared 1%–3200% duration limits, and leaves other syllable start times unchanged. Pitch and gain envelope positions are warped once from the captured envelope to the new region map. Overlap lanes are recalculated automatically.

Ctrl+Shift-dragging an audio syllable, its label, or a boundary handle moves that syllable and every syllable whose pointer-down `timeline_start_ms` is strictly later. Equal-start peers and earlier syllables stay fixed, including peers in other overlap lanes. The group uses one shared delta clamped at zero; durations, source splits, envelopes, and crossfades stay intact. Ctrl+Z undoes and Ctrl+Y redoes composition edits. Each completed drag is one history entry; selection and transport do not create entries. Loading a composition resets history, and new edits discard redo.

An empty timeline click pauses playback and seeks the playhead, including the blank visual tail. Clicking a syllable, interval, handle, or curve point does not seek. Space toggles playback at the playhead; Shift+Space renders or reuses the current unsaved composition preview and starts from zero. A stale preview is refreshed before playback. Pending preview requests are coalesced, and an empty-timeline seek cancels pending autoplay. The playhead follows audio time updates.

Pitch and volume are separate aligned lanes under the audio lane. All three use one scrollable, zoomable time axis, playhead, fragment positions, and sticky lane labels. Ctrl+vertical wheel zooms around the cursor; plain vertical wheel scrolls vertically; horizontal wheel movement and Shift+wheel scroll horizontally. Right-click empty curve space adds a point; right-click a point removes it. Endpoint points remain fixed. Left-drag moves points, with selected pitch cents and gain available for numeric adjustment. Generated phone guides, user markers, and curve points have distinct colors.

Pitch points store normalized positions and integer relative cents from -2400 to 2400. The curve is sampled over normalized output time, then its pitch ratios define one variable-rate resampling pass followed by one duration-restoring stretch, without F0 detection or mixing independent pitch renders. Existing `edit_regions.relative_pitch_cents` is added once as the base pitch, so the curve is additive and old edits are retained. Empty pitch curves continue through the legacy region renderer. The rendered curve is used by preview, WAV, and MP4 audio.

Tempo defaults to 120 BPM and 4/4 for new professional projects. Integer BPM, beats per bar, display subdivisions 1/4, 1/8, 1/16, 1/24, 1/32, 1/48, 1/64, 1/96, and the signed integer grid offset in 1/96 whole-note units are saved in the composition. The ruler labels bar numbers only. Bar starts and quarter-bar divisions have separate grid colors, while the selected fine subdivision remains visible. These settings only define timeline labels and grid spacing; audio timing is not changed automatically and snapping is not applied. Missing offsets in older compositions default to zero.
