/*
 * NAMU Local AI — 모델 실측 능력 평가 (js/local-ai-capability-test.js)
 * ------------------------------------------------------------
 * "모델 이름"만 보고 능력을 추측하지 않는다(이름에 vision/instruct가 없어도 실제로는
 * 이미지 입력을 받는 모델이 있고, 반대의 경우도 있음). 대신 가볍고 짧은 프롬프트로
 * 실제 호출해보고 결과를 검사해서 텍스트/한국어/JSON/비전 능력과 응답 속도를 측정한다.
 *
 * 모든 테스트는 짧고 저렴하게 설계되어 있으며(수 토큰 이내 응답 기대), 이 파일은
 * js/local-ai-adapters.js의 chat()에만 의존한다.
 */
(function () {
  'use strict';
  window.NamuLocalAI = window.NamuLocalAI || {};

  // 비전 테스트용으로 캔버스에 단색 사각형을 그려 데이터 URL로 만든다(외부 이미지 파일이
  // 필요 없어 어떤 환경에서도 동일하게 재현 가능).
  function makeTestImageDataUrl_(colorName) {
    const colors = { red: '#e02020', blue: '#2050e0', green: '#20a020' };
    const hex = colors[colorName] || colors.red;
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = hex; ctx.fillRect(0, 0, 64, 64);
    return canvas.toDataURL('image/png');
  }

  function timeCall_(promiseFactory) {
    const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    return promiseFactory().then(result => {
      const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
      return { ok: true, ms, result };
    }).catch(err => {
      const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
      return { ok: false, ms, error: err };
    });
  }

  function adapters_() { return window.NamuLocalAI.adapters; }

  // 1) 텍스트 기본 응답 테스트 — 단순 지시를 따르는지만 확인.
  function testText(providerType, baseUrl, model) {
    return timeCall_(() => adapters_().chatSimple(
      providerType, baseUrl, model,
      '다른 말 없이 정확히 "PONG"이라는 한 단어로만 답해줘.',
      null, { timeoutMs: 8000, temperature: 0 }
    )).then(r => ({
      ok: r.ok && /pong/i.test(r.result.reply || ''),
      ms: r.ms,
      raw: r.ok ? r.result.reply : null,
      error: r.ok ? null : r.error,
    }));
  }

  // 2) 한국어 처리 테스트 — 한국어로 묻고 한국어(한글 포함) 답이 오는지 확인.
  function testKorean(providerType, baseUrl, model) {
    return timeCall_(() => adapters_().chatSimple(
      providerType, baseUrl, model,
      '"안녕하세요"에 대해 한국어로 딱 한 문장으로만 답장해줘.',
      null, { timeoutMs: 10000, temperature: 0.2 }
    )).then(r => ({
      ok: r.ok && /[가-힣]/.test(r.result.reply || ''),
      ms: r.ms,
      raw: r.ok ? r.result.reply : null,
      error: r.ok ? null : r.error,
    }));
  }

  // 3) 구조화(JSON) 출력 테스트 — 정해진 키를 가진 JSON을 실제로 뽑아낼 수 있는지 확인.
  function testJson(providerType, baseUrl, model) {
    return timeCall_(() => adapters_().chatSimple(
      providerType, baseUrl, model,
      '설명 없이 정확히 이 JSON 객체만 그대로 출력해줘: {"status":"ok","count":1}',
      null, { timeoutMs: 10000, temperature: 0 }
    )).then(r => {
      let parsed = null;
      if (r.ok) {
        const match = (r.result.reply || '').match(/\{[\s\S]*\}/);
        if (match) { try { parsed = JSON.parse(match[0]); } catch (e) { parsed = null; } }
      }
      return {
        ok: !!(parsed && parsed.status === 'ok'),
        ms: r.ms,
        raw: r.ok ? r.result.reply : null,
        error: r.ok ? null : r.error,
      };
    });
  }

  // 4) 비전(이미지 입력) 테스트 — 색이 뚜렷한 사각형 이미지를 보내 실제로 "보고" 답하는지 확인.
  //    텍스트/JSON 테스트보다 비용이 크므로, 모델이 텍스트 테스트를 통과했을 때만(또는 명시
  //    요청 시) 호출하는 것을 권장한다(호출 여부 판단은 manager.js에서 담당).
  function testVision(providerType, baseUrl, model) {
    const img = makeTestImageDataUrl_('red');
    return timeCall_(() => adapters_().chatSimple(
      providerType, baseUrl, model,
      '이 이미지는 단색 사각형이야. 무슨 색인지 한국어 단어 하나로만 답해줘.',
      img, { timeoutMs: 15000, temperature: 0 }
    )).then(r => ({
      ok: r.ok && /(빨강|빨간|red)/i.test(r.result.reply || ''),
      ms: r.ok ? r.ms : null, // 비전 미지원 모델은 에러/무의미 응답이 나오므로 속도 측정에서 제외
      raw: r.ok ? r.result.reply : null,
      error: r.ok ? null : r.error,
    }));
  }

  // 도구 호출(function calling) 능력은 로컬 런타임마다 API 형태가 크게 달라(OpenAI tools
  // 스키마를 그대로 지원하지 않는 경우가 많음) v1에서는 신뢰성 있게 실측하기 어렵다.
  // 과장해서 "지원"이라 표시하지 않기 위해 항상 false(추후 지원 예정)로 둔다 — 이 결정은
  // 완료 보고서의 "남은 한계"에 명시한다.
  const TOOLS_SUPPORTED_V1 = false;

  // 모델 하나에 대한 전체 능력 평가. skipVision을 true로 주면 비전 테스트를 건너뛴다
  // (텍스트 테스트조차 실패한 모델에게 굳이 무거운 비전 테스트를 돌릴 필요가 없기 때문).
  function runFullCapabilityTest(providerType, baseUrl, model, opts) {
    opts = opts || {};
    return testText(providerType, baseUrl, model).then(textResult => {
      const skipVision = !!opts.skipVision || !textResult.ok;
      return Promise.all([
        textResult.ok ? testKorean(providerType, baseUrl, model) : Promise.resolve({ ok: false, ms: null, raw: null, error: null }),
        textResult.ok ? testJson(providerType, baseUrl, model) : Promise.resolve({ ok: false, ms: null, raw: null, error: null }),
        skipVision ? Promise.resolve({ ok: false, ms: null, raw: null, error: null, skipped: true }) : testVision(providerType, baseUrl, model),
      ]).then(([koreanResult, jsonResult, visionResult]) => {
        const timedResults = [textResult, koreanResult, jsonResult, visionResult].filter(r => r.ok && r.ms != null);
        const avgResponseMs = timedResults.length
          ? Math.round(timedResults.reduce((sum, r) => sum + r.ms, 0) / timedResults.length)
          : null;
        return {
          text: textResult.ok,
          korean: koreanResult.ok,
          json: jsonResult.ok,
          vision: visionResult.skipped ? null : visionResult.ok, // null = 시도하지 않음(모름), false = 시도했지만 실패
          tools: TOOLS_SUPPORTED_V1,
          avgResponseMs: avgResponseMs,
          testedAt: Date.now(),
          error: textResult.ok ? null : (textResult.error ? String(textResult.error.message || textResult.error) : '텍스트 응답 테스트 실패'),
        };
      });
    });
  }

  window.NamuLocalAI.capabilityTest = {
    makeTestImageDataUrl: makeTestImageDataUrl_,
    testText: testText,
    testKorean: testKorean,
    testJson: testJson,
    testVision: testVision,
    runFullCapabilityTest: runFullCapabilityTest,
  };
})();
