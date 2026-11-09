// Vercel 서버리스 함수: 서울시 실시간 지하철 도착정보 API 프록시
// - 서울시 API는 http라서 https 페이지에서 직접 호출할 수 없으므로 여기서 대신 호출한다.
// - API 키는 환경변수 SEOUL_SUBWAY_KEY 로만 읽는다. (코드에 키를 쓰지 말 것!)
// - vercel.json 에서 서울 리전(icn1)으로 실행한다. 미국 리전에서는 서울시 API가 시간 초과된다.
//
// 참고: sample 키는 '서울'역만 조회된다. 연결 확인은 /api/subway?station=서울
//
// 대체 경로: 도착정보(realtimeStationArrival)에 안암 6호선 열차가 없을 때가 있다
// (보문~상월곡 구간 데이터가 통째로 빠지는 경우 확인됨). 그럴 때는 6호선 열차 위치
// (realtimePosition)를 받아서 안암까지 남은 정거장 수로 도착 시간을 추정한다.

const BASE = 'http://swopenapi.seoul.go.kr/api/subway/';
const DEFAULT_STATION = '안암';
const TIMEOUT_MS = 4500; // 최대 두 번 호출하므로 각각 짧게

// 6호선 역 순서 (응암 → 신내 = 하행). 응암순환 구간(역촌~구산)은 안암과 멀어서 뺐다.
const LINE6 = [
  '응암', '새절', '증산', '디지털미디어시티', '월드컵경기장', '마포구청', '망원', '합정', '상수',
  '광흥창', '대흥', '공덕', '효창공원앞', '삼각지', '녹사평', '이태원', '한강진', '버티고개', '약수',
  '청구', '신당', '동묘앞', '창신', '보문', '안암', '고려대', '월곡', '상월곡', '돌곶이', '석계',
  '태릉입구', '화랑대', '봉화산', '신내',
];
const ANAM = LINE6.indexOf('안암');
const SEC_PER_STATION = 120;  // PROJECT.md 4번 규칙 3과 같은 기준
const MAX_STATIONS = 8;       // 이보다 먼 열차는 무시 (약 16분)
// 열차 상태(trainSttus)별 보정: 0 진입, 1 도착, 2 출발, 3 전역출발 (해당 역 기준)
const STTUS_ADJ = { '0': 30, '1': 0, '2': -20, '3': 90 };
const STTUS_TEXT = { '0': '진입', '1': '도착', '2': '출발', '3': '전역 출발' };

module.exports = async function handler(req, res) {
  const key = process.env.SEOUL_SUBWAY_KEY || 'sample';
  const isSample = key === 'sample';
  const end = isSample ? 5 : 10;
  const station = pickStation(req);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  const proxyInfo = { keyType: isSample ? 'sample' : 'env', station, source: 'arrival', fetchedAt: new Date().toISOString() };

  let data;
  try {
    data = await getJson(BASE + encodeURIComponent(key) + '/json/realtimeStationArrival/0/' + end + '/' + encodeURIComponent(station));
  } catch (err) {
    data = { errorMessage: upstreamError(err), realtimeArrivalList: [] };
  }
  if (!Array.isArray(data.realtimeArrivalList)) data.realtimeArrivalList = [];

  // 안암 6호선 도착정보가 없으면 열차 위치로 추정
  const hasLine6 = data.realtimeArrivalList.some(t => String(t.subwayId) === '1006');
  if (station === DEFAULT_STATION && !hasLine6) {
    try {
      const pos = await getJson(BASE + encodeURIComponent(key) + '/json/realtimePosition/0/' + (isSample ? 5 : 100) + '/' + encodeURIComponent('6호선'));
      if (pos.errorMessage && Number(pos.errorMessage.status) === 200) {
        const list = positionsToArrivals(pos.realtimePositionList || []);
        proxyInfo.source = 'position';
        proxyInfo.arrivalError = data.errorMessage || null;
        data = {
          errorMessage: { status: 200, code: 'INFO-000', message: '도착정보가 없어 열차 위치로 추정했어요.' },
          realtimeArrivalList: list,
        };
      }
    } catch {
      // 위치 API도 실패하면 원래 도착정보 결과(에러)를 그대로 보낸다
    }
  }

  const em = data.errorMessage;
  if (isSample && em && Number(em.status) !== 200) {
    em.message += ' (sample 키는 서울역만 조회돼요. Vercel 환경변수 SEOUL_SUBWAY_KEY를 설정하세요.)';
  }

  // 키 종류는 알려주되 키 값 자체는 절대 내보내지 않는다.
  data._proxy = proxyInfo;
  res.statusCode = em && Number(em.status) >= 500 && em.code === 'PROXY-ERROR' ? 502 : 200;
  res.end(JSON.stringify(data));
};

// 서울시 API 호출 → 항상 { errorMessage, ...목록 } 모양으로 돌려준다.
async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(url, { signal: controller.signal });
    const text = await upstream.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // 서울시 API가 XML/HTML 에러 페이지를 줄 때
      return { errorMessage: { status: 502, code: 'PROXY-ERROR', message: '지하철 API 응답을 해석할 수 없어요.', detail: text.slice(0, 300) } };
    }
    // 에러일 때 서울시 API는 errorMessage로 감싸지 않고 최상위에 {status, code, message}를 준다.
    if (!data.errorMessage && data.status !== undefined) {
      data = { errorMessage: { status: data.status, code: data.code, message: data.message } };
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function upstreamError(err) {
  const message = err && err.name === 'AbortError'
    ? '지하철 API 응답이 너무 늦어요. 잠시 후 다시 시도해 주세요.'
    : '지하철 API에 연결하지 못했어요.';
  return { status: 502, code: 'PROXY-ERROR', message, detail: String(err && err.message) };
}

// "안암(고대병원앞)" → "안암", "응암순환(상선)" → "응암순환"
const norm = s => String(s || '').replace(/\(.*?\)/g, '').trim();

// 6호선 열차 위치 목록 → 안암 도착정보와 같은 모양의 목록
function positionsToArrivals(list) {
  const out = [];
  for (const p of list) {
    if (String(p.subwayId) !== '1006') continue;
    const at = LINE6.indexOf(norm(p.statnNm));
    if (at < 0) continue;
    const down = String(p.updnLine) === '1';             // 0 상행(응암 방향), 1 하행(신내 방향)
    const n = down ? ANAM - at : at - ANAM;               // 안암까지 남은 정거장 수
    if (n < 0 || n > MAX_STATIONS) continue;              // 이미 지나갔거나 너무 멂

    const terminal = norm(p.statnTnm);
    const tIdx = LINE6.indexOf(terminal.replace(/순환$/, ''));
    if (tIdx >= 0 && (down ? tIdx <= ANAM : tIdx >= ANAM)) continue; // 안암 전에 끝나는 열차

    const st = String(p.trainSttus);
    if (n === 0 && st === '2') continue;                  // 안암 출발 → 이미 떠남
    const sec = Math.max(0, n * SEC_PER_STATION + (STTUS_ADJ[st] || 0));

    out.push({
      subwayId: '1006',
      updnLine: down ? '하행' : '상행',
      trainLineNm: `${terminal}행 - ${down ? '고려대' : '보문'}방면`,
      barvlDt: '0',
      arvlMsg2: `${norm(p.statnNm)} ${STTUS_TEXT[st] || ''}`.trim() + (n ? ` (${n}정거장 전)` : ''),
      arvlCd: '99',
      recptnDt: p.recptnDt,
      btrainNo: p.trainNo,
      estSec: sec,                                        // 위치 기반 추정 초 (recptnDt 기준)
    });
  }
  return out.sort((a, b) => a.estSec - b.estSec);
}

// ?station=역이름 (테스트용). 한글 역 이름만 허용하고, 없으면 안암.
function pickStation(req) {
  let s = req && req.query && req.query.station;
  if (!s && req && req.url) {
    try { s = new URL(req.url, 'http://x').searchParams.get('station'); } catch {}
  }
  s = String(s || '').trim();
  return /^[가-힣0-9()]{1,20}$/.test(s) ? s : DEFAULT_STATION;
}

module.exports.positionsToArrivals = positionsToArrivals;
