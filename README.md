# GP5 Pedalboard Controller

Valeton GP5 멀티이펙트 페달을 브라우저에서 직접 제어하는 웹앱입니다.
백엔드 서버 없이 브라우저가 **Bluetooth**(Web Bluetooth + SysEx) 또는 **USB**(Web MIDI + CC)로
GP5 하드웨어에 직접 붙습니다. [helvecioneto/gp5-wc](https://github.com/helvecioneto/gp5-wc)의
BLE SysEx 프로토콜을 참고해 갤럭시탭 S6 Lite 가로모드용 페달보드 UI로 새로 만들었습니다.

## GP5에는 어떻게 접속되나요?

- **Bluetooth 모드** — 브라우저의 `navigator.bluetooth.requestDevice()`로 GP5의 BLE 서비스에
  붙고, 이후 모든 명령은 SysEx 바이트 시퀀스(CRC8 체크섬 + 특수 인코딩)를 그 BLE characteristic에
  써서 보냅니다. 프리셋 이름/파라미터까지 세밀하게 제어할 수 있는 완전한 방식입니다.
- **USB 모드** — 브라우저의 `navigator.requestMIDIAccess({sysex:true})`로 GP5를 MIDI 장치로
  인식하고, 프리셋 전환·모듈 on/off·마스터 볼륨·튜너를 표준 MIDI Control Change 메시지로 보냅니다.
  세부 파라미터(게인, 톤 등) 조정과 이펙트 종류 변경은 CC로 매핑되어 있지 않아 이 모드에서는 지원하지 않습니다.

**중요**: 둘 다 브라우저가 하드웨어에 *직접* 붙는 방식이라 별도 앱/드라이버가 필요 없지만,
**secure context**(HTTPS 또는 `localhost`)에서만 동작합니다. `file://`로 열거나 사설 IP로 열면
Web Bluetooth/Web MIDI 권한 자체가 막힙니다.

## 갤럭시탭 S6 Lite에서 실행하기

Android Chrome은 **Web Bluetooth는 잘 지원**하지만 **Web MIDI(USB)는 지원이 매우 제한적**입니다.
따라서 태블릿에서는 **Bluetooth 모드를 기본으로 사용하는 걸 권장**합니다.

### 방법 A — GitHub Pages (가장 간단, HTTPS 자동 확보)
1. 이 폴더를 본인 GitHub 저장소에 올립니다.
2. 저장소 Settings → Pages에서 배포 활성화.
3. 갤럭시탭 Chrome에서 `https://<사용자명>.github.io/<저장소>/`로 접속.
4. 상단에서 Bluetooth 선택 → Connect → GP5 페어링.

### 설치형(PWA)으로 홈 화면에 추가하기
이 앱은 `manifest.json` + 서비스워커(`sw.js`)가 포함된 PWA라, 방법 A로 한 번만 접속하면
그 이후로는 서버를 계속 띄울 필요 없이 앱처럼 쓸 수 있습니다.
1. 위 방법 A대로 GitHub Pages 주소에 한 번 접속합니다.
2. Chrome 우측 상단 메뉴(⋮) → **"홈 화면에 추가"** (또는 자동으로 뜨는 설치 배너에서 설치) 선택.
3. 홈 화면에 생긴 GP5 아이콘을 탭하면 주소창 없이 전체화면 앱처럼 바로 실행됩니다.
4. 서비스워커가 HTML/CSS/JS/이펙트 데이터를 기기에 캐싱해두므로, 이후엔 Wi-Fi가 없어도 앱 화면 자체는
   그대로 뜹니다 (GP5와의 실제 연결은 어차피 Bluetooth/USB지 인터넷이 아니라서 원래도 네트워크가 필요 없었습니다).
5. `app.js`나 데이터 파일을 수정해 GitHub Pages에 다시 배포한 뒤 태블릿에서 새 버전을 받으려면,
   앱을 완전히 종료했다가 다시 열면(서비스워커가 백그라운드에서 새 버전을 받아두고, 다음 실행부터 적용) 됩니다.

### 방법 B — 태블릿에서 직접 로컬 서버 실행 (오프라인)
Termux 등으로 태블릿 자체에서 서버를 띄우면 `http://localhost:port`가 secure context로 인정됩니다.
```bash
python -m http.server 8000
```
그 다음 태블릿 Chrome에서 `http://localhost:8000/index.html` 접속.

> PC에서 서버를 띄우고 태블릿이 같은 Wi-Fi로 `http://<PC IP>:8000`에 접속하는 방식은
> secure context가 아니라서 **동작하지 않습니다**. 반드시 HTTPS 또는 태블릿 자체 localhost를 쓰세요.

## 파일 구성
```
index.html   메인 페이지 (레이아웃)
style.css    가로모드 태블릿용 네온 페달보드 테마
app.js       연결/프로토콜/UI 로직
data/ble_sysex.json   BLE SysEx 명령 + 이펙트/파라미터 테이블
data/cc_commands.json USB MIDI CC 매핑
```

## 파라미터 데이터의 출처

`data/ble_sysex.json`의 블록/이펙트/파라미터 정의(이름, 인덱스, 범위, 기본값)는 **Valeton Suite
앱(`com.sonicake.gp_5`) 안에 번들된 공식 데이터 파일**(`assets/flutter_assets/assets/data/module_data.json`,
Flutter 앱 APK에서 직접 추출)을 그대로 반영한 것입니다. 이전엔 원조 gp5-wc 프로젝트가 관찰만으로
추측한 값을 썼는데, 실기 검증 중 리버브 "Room"의 Decay 노브 값이 저장이 안 되는 문제를 발견하면서
전수 대조했습니다 — 209개 이펙트 중 110개(약 절반)에서 이펙트 이름 자체가 다르거나(예: 우리가
"Analog Delay"라 부르던 게 실제로는 "Pure"), 파라미터 번호(algId)가 배열 순서와 다르게 건너뛰는
경우(예: 리버브 대부분이 Decay=algId 2, Trail=algId 3/4/6 등 이펙트마다 제각각)가 있었습니다.
지금은 이 공식 데이터로 전부 재구축되어 있습니다.

- 이펙트 hex ID(`0000000b` 등)를 리틀엔디안 4바이트 정수로 읽으면 Suite 데이터의 `fxid`와
  정확히 일치합니다 — 이 관계로 209개 이펙트 전부를 이름 매칭 없이 기계적으로 대조했습니다.
- 파라미터 값 자체를 기기에서 읽어오는 것은 여전히 라이브 BLE HCI 캡처로 리버스엔지니어링한
  것이라 공식 문서는 아닙니다. **10개 블록 전부** 오프셋을 찾았습니다 — `dst, amp, cab, eq, mod,
  dly, rvb` 7블록은 patch_data 파트 2/3(각 100바이트)에, `nr, pre`는 파트 1(오프셋 36부터
  블록당 32바이트 간격)에, `ns`(NAM)는 파트 4(오프셋 24부터)에 있습니다.

## 알려진 제한사항
- 패치 저장(`save_patch` SysEx)은 공식 문서가 아니라 Valeton Suite의 실제 저장 동작을 캡처해서
  리버스엔지니어링한 것입니다 — 패치 번호 + 10바이트 ASCII 이름으로 캡처된 패킷과 바이트 단위로
  동일하게 재현되는 것까지 확인했습니다.
- Bluetooth 프로토콜에 마스터 볼륨/튜너 SysEx 커맨드가 문서화되어 있지 않아, 이 두 컨트롤은
  USB 모드에서만 활성화됩니다.
- 이펙트 종류 변경과 세부 파라미터 편집은 Bluetooth 모드에서만 가능합니다.
