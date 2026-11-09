// Vercel 서버리스 함수: 서울시 실시간 지하철 도착정보 API 프록시
// - 서울시 API는 http라서 https 페이지에서 직접 호출할 수 없으므로 여기서 대신 호출한다.
// - API 키는 환경변수 SEOUL_SUBWAY_KEY 로만 읽는다. (코드에 키를 쓰지 말 것!)

// 참고: sample 키는 '서울'역만 조회된다. sample 키로 '안암'을 조회하면
//       ERROR-336(요청 범위 오류)이 온다. → 연결 확인은 /api/subway?station=서울
const DEFAULT_STATION = '안암';
const TIMEOUT_MS = 8000;

module.exports = async function handler(req, res) {
  const key = process.env.SEOUL_SUBWAY_KEY || 'sample';
  const isSample = key === 'sample';
  const end = isSample ? 5 : 10;
  const station = pickStation(req);
  const url =
    'http://swopenapi.seoul.go.kr/api/subway/' +
    encodeURIComponent(key) +
    '/json/realtimeStationArrival/0/' + end + '/' +
    encodeURIComponent(station);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

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
      return sendError(res, 502, '지하철 API 응답을 해석할 수 없어요.', text.slice(0, 300));
    }

    // 에러일 때 서울시 API는 errorMessage로 감싸지 않고 최상위에 {status, code, message}를 준다.
    // → 항상 errorMessage 모양으로 맞춘다.
    if (!data.errorMessage && data.status !== undefined) {
      data = { errorMessage: { status: data.status, code: data.code, message: data.message }, realtimeArrivalList: [] };
    }
    if (!Array.isArray(data.realtimeArrivalList)) data.realtimeArrivalList = [];

    const em = data.errorMessage;
    if (isSample && em && Number(em.status) !== 200) {
      em.message += ' (sample 키는 서울역만 조회돼요. Vercel 환경변수 SEOUL_SUBWAY_KEY를 설정하세요.)';
    }

    // 키 종류는 알려주되 키 값 자체는 절대 내보내지 않는다.
    data._proxy = { keyType: isSample ? 'sample' : 'env', station, fetchedAt: new Date().toISOString() };
    res.statusCode = 200;
    res.end(JSON.stringify(data));
  } catch (err) {
    const msg = err.name === 'AbortError'
      ? '지하철 API 응답이 너무 늦어요. 잠시 후 다시 시도해 주세요.'
      : '지하철 API에 연결하지 못했어요.';
    sendError(res, 502, msg, String(err && err.message));
  } finally {
    clearTimeout(timer);
  }
};

// ?station=역이름 (테스트용). 한글 역 이름만 허용하고, 없으면 안암.
function pickStation(req) {
  let s = req && req.query && req.query.station;
  if (!s && req && req.url) {
    try { s = new URL(req.url, 'http://x').searchParams.get('station'); } catch {}
  }
  s = String(s || '').trim();
  return /^[가-힣0-9()]{1,20}$/.test(s) ? s : DEFAULT_STATION;
}

// 서울시 API와 같은 errorMessage 모양으로 에러를 돌려줘서 화면 쪽 처리를 하나로 맞춘다.
function sendError(res, status, message, detail) {
  res.statusCode = status;
  res.end(JSON.stringify({
    errorMessage: { status, code: 'PROXY-ERROR', message, detail },
    realtimeArrivalList: [],
  }));
}
