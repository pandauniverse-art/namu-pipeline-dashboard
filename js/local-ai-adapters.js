/*
 * NAMU Local AI — 어댑터 계층 (js/local-ai-adapters.js)
 * ------------------------------------------------------------
 * 로컬 AI 런타임(Ollama, LM Studio, LocalAI, KoboldCpp, text-generation-webui,
 * ComfyUI, Automatic1111)에 대한 "탐지 / 모델 목록 조회 / 채팅(텍스트·비전) 호출"을
 * 하나의 공통 인터페이스로 감싼다.
 *
 * 이 파일은 순수 <script> 태그로 로드되며(ES 모듈 아님), 기존 index.html의 전역
 * 스크립트와 충돌하지 않도록 모든 것을 window.NamuLocalAI.adapters 아래에만 둔다.
 *
 * 절대 하지 않는 것:
 *  - 임의의 포트를 무작위로 스캔하지 않는다(아래 KNOWN_PROVIDERS의 "잘 알려진 기본 포트"
 *    + 사용자가 직접 등록한 커스텀 주소만 확인한다).
 *  - API 키를 요구하거나 저장하지 않는다(로컬 서버는 보통 인증이 없다는 전제).
 *  - 이 파일 자체는 어떤 값도 Firestore/localStorage에 저장하지 않는다(저장은
 *    local-ai-manager.js의 몫).
 */
(function () {
  'use strict';
  window.NamuLocalAI = window.NamuLocalAI || {};

  // ---------- 자동 탐지 대상 목록 ----------
  // priority 1 = 1차 목표(채팅/비전까지 지원하는 텍스트·이미지 LLM 런타임)
  // priority 2 = 2차 목표(마찬가지로 채팅 가능하지만 상대적으로 덜 흔함)
  // priority 3 = 탐지만 하고 정보 표시용으로만 쓰는 대상(이미지 생성 전용 서버라
  //              우리 텍스트/비전 채팅 인터페이스로는 직접 쓸 수 없음)
  const KNOWN_PROVIDERS = [
    { type: 'ollama',          label: 'Ollama',                    baseUrl: 'http://localhost:11434', priority: 1, chatCapable: true  },
    { type: 'lmstudio',        label: 'LM Studio',                 baseUrl: 'http://localhost:1234',  priority: 1, chatCapable: true  },
    { type: 'localai',         label: 'LocalAI',                   baseUrl: 'http://localhost:8080',  priority: 2, chatCapable: true  },
    { type: 'koboldcpp',       label: 'KoboldCpp',                 baseUrl: 'http://localhost:5001',  priority: 2, chatCapable: true  },
    { type: 'textgen-webui',   label: 'text-generation-webui',     baseUrl: 'http://localhost:5000',  priority: 2, chatCapable: true  },
    { type: 'comfyui',         label: 'ComfyUI(이미지 생성 전용)',    baseUrl: 'http://localhost:8188',  priority: 3, chatCapable: false },
    { type: 'automatic1111',   label: 'Automatic1111(이미지 생성 전용)', baseUrl: 'http://localhost:7860', priority: 3, chatCapable: false },
  ];

  const DEFAULT_TIMEOUT_MS = 1800;

  // ---------- 공통 유틸 ----------

  // fetch에 타임아웃을 강제한다. 로컬 서버가 꺼져 있으면 브라우저가 알아서 빠르게
  // 실패하지만, 방화벽 등으로 응답이 없는 경우를 대비해 항상 타임아웃을 건다.
  function fetchWithTimeout_(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
    return fetch(url, Object.assign({}, options, { signal: controller.signal }))
      .finally(() => clearTimeout(timer));
  }

  // 브라우저 fetch 실패 이유를 사용자에게 설명 가능한 카테고리로 정규화한다.
  // 주의: 브라우저 보안 모델상 "서버가 꺼져있음"과 "서버는 켜져있지만 CORS로
  // 막힘"은 둘 다 동일한 TypeError("Failed to fetch")로 나타나 스크립트에서
  // 구분할 수 없다. 그래서 이 경우 unreachable 하나로 묶고, 사용자 설명 문구에서
  // 두 가능성을 모두 안내한다(불확실한 것을 확실한 것처럼 표시하지 않기 위함).
  function classifyError_(err, baseUrl) {
    if (err && err.name === 'AbortError') return 'timeout';
    if (typeof location !== 'undefined' && location.protocol === 'https:' && /^http:\/\//i.test(baseUrl)) {
      return 'https_blocked'; // 혼합 콘텐츠 - 브라우저가 애초에 요청을 막음
    }
    if (err instanceof TypeError) return 'unreachable'; // not_running 또는 cors_blocked (구분 불가)
    return 'unknown';
  }

  function errorMessageFor_(type, providerLabel, baseUrl) {
    switch (type) {
      case 'https_blocked':
        return `이 대시보드는 HTTPS로 열려 있는데 ${providerLabel}(${baseUrl})는 HTTP 주소라 브라우저가 보안상 연결을 막았습니다(혼합 콘텐츠). 로컬 서버를 HTTPS로 여는 방법이 없다면 이 런타임은 브라우저에서 직접 자동 탐지할 수 없습니다.`;
      case 'timeout':
        return `${providerLabel}(${baseUrl})가 제한 시간 안에 응답하지 않았습니다. 서버가 큰 모델을 로딩 중이거나 응답이 느릴 수 있습니다.`;
      case 'unreachable':
        return `${providerLabel}(${baseUrl})에 연결할 수 없습니다. ① 서버가 꺼져 있거나, ② 서버는 켜져 있지만 이 사이트의 요청을 허용하지 않고 있을 수 있습니다(CORS). 브라우저는 이 두 경우를 구분해서 알려주지 않습니다.`;
      default:
        return `${providerLabel}(${baseUrl}) 확인 중 알 수 없는 오류가 발생했습니다.`;
    }
  }

  // ---------- 모델 목록 조회 (런타임별 API 형태가 달라서 분기) ----------

  function listModelsOllama_(baseUrl, timeoutMs) {
    return fetchWithTimeout_(baseUrl.replace(/\/$/, '') + '/api/tags', { method: 'GET' }, timeoutMs)
      .then(r => { if (!r.ok) throw new Error('http_' + r.status); return r.json(); })
      .then(data => (data && Array.isArray(data.models) ? data.models : []).map(m => ({ id: m.name, raw: m })));
  }

  function listModelsOpenAiCompatible_(baseUrl, timeoutMs) {
    return fetchWithTimeout_(baseUrl.replace(/\/$/, '') + '/v1/models', { method: 'GET' }, timeoutMs)
      .then(r => { if (!r.ok) throw new Error('http_' + r.status); return r.json(); })
      .then(data => (data && Array.isArray(data.data) ? data.data : []).map(m => ({ id: m.id, raw: m })));
  }

  // KoboldCpp는 OpenAI 호환 /v1/models가 없는 구버전도 있어, 실패하면 자체 API로 폴백한다.
  function listModelsKobold_(baseUrl, timeoutMs) {
    return listModelsOpenAiCompatible_(baseUrl, timeoutMs).catch(() =>
      fetchWithTimeout_(baseUrl.replace(/\/$/, '') + '/api/v1/model', { method: 'GET' }, timeoutMs)
        .then(r => { if (!r.ok) throw new Error('http_' + r.status); return r.json(); })
        .then(data => (data && data.result) ? [{ id: String(data.result), raw: data }] : [])
    );
  }

  function listModelsComfyUi_(baseUrl, timeoutMs) {
    // ComfyUI는 "채팅"에 쓸 모델 목록 개념이 없으므로, 서버 반응 여부만 확인한다(정보 표시용).
    return fetchWithTimeout_(baseUrl.replace(/\/$/, '') + '/system_stats', { method: 'GET' }, timeoutMs)
      .then(r => { if (!r.ok) throw new Error('http_' + r.status); return []; });
  }

  function listModelsAutomatic1111_(baseUrl, timeoutMs) {
    return fetchWithTimeout_(baseUrl.replace(/\/$/, '') + '/sdapi/v1/sd-models', { method: 'GET' }, timeoutMs)
      .then(r => { if (!r.ok) throw new Error('http_' + r.status); return r.json(); })
      .then(data => (Array.isArray(data) ? data : []).map(m => ({ id: m.title || m.model_name || 'unknown', raw: m })));
  }

  function listModelsFor_(providerType, baseUrl, timeoutMs) {
    switch (providerType) {
      case 'ollama': return listModelsOllama_(baseUrl, timeoutMs);
      case 'koboldcpp': return listModelsKobold_(baseUrl, timeoutMs);
      case 'comfyui': return listModelsComfyUi_(baseUrl, timeoutMs);
      case 'automatic1111': return listModelsAutomatic1111_(baseUrl, timeoutMs);
      // lmstudio / localai / textgen-webui / 사용자 지정 openai-compatible
      default: return listModelsOpenAiCompatible_(baseUrl, timeoutMs);
    }
  }

  // ---------- 탐지(해당 주소에 실제로 그 런타임이 떠 있는지 확인 + 모델 목록) ----------

  function detect(provider, timeoutMs) {
    const providerLabel = provider.label || provider.type;
    return listModelsFor_(provider.type, provider.baseUrl, timeoutMs)
      .then(models => ({ ok: true, provider, models }))
      .catch(err => {
        const errorType = classifyError_(err, provider.baseUrl);
        return {
          ok: false,
          provider,
          errorType,
          errorMessage: errorMessageFor_(errorType, providerLabel, provider.baseUrl),
        };
      });
  }

  // 알려진 기본 주소 + 사용자가 등록한 커스텀 주소를 병렬로(Promise.allSettled) 확인한다.
  // customEndpoints: [{ type, label, baseUrl }] 형태(모두 사용자가 명시적으로 등록한 것만).
  function detectAll(customEndpoints, timeoutMs) {
    const targets = KNOWN_PROVIDERS.concat(Array.isArray(customEndpoints) ? customEndpoints : []);
    return Promise.allSettled(targets.map(p => detect(p, timeoutMs))).then(results =>
      results.map(r => (r.status === 'fulfilled' ? r.value : {
        ok: false, provider: null, errorType: 'unknown', errorMessage: '탐지 중 알 수 없는 오류',
      }))
    );
  }

  // ---------- 채팅(텍스트/비전 공용) ----------
  // Ollama(신버전)·LM Studio·LocalAI·text-generation-webui·KoboldCpp(신버전)는 모두
  // OpenAI 호환 /v1/chat/completions 형식을 지원하므로 하나의 함수로 통일해서 부른다.
  // images: [{dataUrl}] 형식의 배열(선택) — 있으면 멀티모달 메시지로 함께 보낸다.
  function chat(providerType, baseUrl, model, messages, opts) {
    opts = opts || {};
    const timeoutMs = opts.timeoutMs || (DEFAULT_TIMEOUT_MS * 4); // 채팅 생성은 탐지보다 오래 걸릴 수 있어 여유를 둠
    const url = baseUrl.replace(/\/$/, '') + '/v1/chat/completions';
    const body = {
      model: model,
      messages: messages,
      temperature: (opts.temperature != null) ? opts.temperature : 0.3,
      stream: false,
    };
    return fetchWithTimeout_(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, timeoutMs).then(r => {
      if (!r.ok) {
        const err = new Error('http_' + r.status);
        err.httpStatus = r.status;
        throw err;
      }
      return r.json();
    }).then(data => {
      const reply = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (reply == null) throw new Error('empty_reply');
      return { reply: typeof reply === 'string' ? reply : JSON.stringify(reply), raw: data };
    }).catch(err => {
      const errorType = err && err.httpStatus === 404 ? 'model_missing' : classifyError_(err, baseUrl);
      const providerLabel = (KNOWN_PROVIDERS.find(p => p.type === providerType) || { label: providerType }).label;
      const wrapped = new Error(errorType === 'model_missing'
        ? `모델 "${model}"을(를) ${providerLabel}에서 찾을 수 없습니다(서버에서 모델이 언로드되었을 수 있음).`
        : errorMessageFor_(errorType, providerLabel, baseUrl));
      wrapped.errorType = errorType;
      throw wrapped;
    });
  }

  // 텍스트 메시지 하나 + (선택)이미지 하나로 chat()을 호출하는 간단한 헬퍼.
  function chatSimple(providerType, baseUrl, model, promptText, imageDataUrl, opts) {
    const content = imageDataUrl
      ? [{ type: 'text', text: promptText }, { type: 'image_url', image_url: { url: imageDataUrl } }]
      : promptText;
    return chat(providerType, baseUrl, model, [{ role: 'user', content }], opts);
  }

  window.NamuLocalAI.adapters = {
    KNOWN_PROVIDERS: KNOWN_PROVIDERS,
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
    detect: detect,
    detectAll: detectAll,
    listModelsFor: listModelsFor_,
    chat: chat,
    chatSimple: chatSimple,
    classifyError: classifyError_,
    errorMessageFor: errorMessageFor_,
  };
})();
