/*
 * NAMU Local AI — 매니저(js/local-ai-manager.js)
 * ------------------------------------------------------------
 * 자동 탐지 → 모델 목록 조회 → 능력 실측 → 작업별 자동 배정까지의 전체 흐름을 조율하고,
 * 그 결과(및 사용자의 수동 오버라이드)를 이 브라우저의 localStorage에만 저장한다.
 *
 * 중요(사용자 요구사항): 이 설정은 팀 공용 데이터가 아니라 "이 컴퓨터 이 브라우저"에서만
 * 의미 있는 개인 환경 설정이므로 Firestore에는 절대 쓰지 않는다. index.html의 Firestore
 * 저장/동기화 로직(queueAutoSave 등)과 이 파일은 완전히 분리되어 있다.
 */
(function () {
  'use strict';
  window.NamuLocalAI = window.NamuLocalAI || {};

  const CONFIG_KEY = 'namu_localAI_config_v1';

  const TASKS = [
    { key: 'planning',        label: '기획/대본 생성',              needs: ['text', 'korean'] },
    { key: 'cutlist',         label: '컷리스트 생성',                needs: ['text', 'korean', 'json'] },
    { key: 'imagePrompt',     label: '이미지 생성용 프롬프트',        needs: ['text'] },
    { key: 'motionPrompt',    label: '이미지→영상 모션 프롬프트',     needs: ['text'] },
    { key: 'narration',       label: '내레이션 생성',                needs: ['text', 'korean'] },
    { key: 'summarize',       label: '자료 요약/분류/태그',          needs: ['text', 'korean'] },
    { key: 'storyboardVision',label: '스토리보드/레퍼런스 이미지 분석', needs: ['vision'] },
    { key: 'report',          label: '프로젝트 보고서 작성',         needs: ['text', 'korean'] },
  ];

  function defaultConfig() {
    return { knownEndpoints: [], autoDetect: true, modelAssignments: {}, lastScanAt: 0 };
  }

  function loadConfig() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (!raw) return defaultConfig();
      return Object.assign(defaultConfig(), JSON.parse(raw));
    } catch (e) { return defaultConfig(); }
  }

  function saveConfig(cfg) {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch (e) { /* 저장 실패해도 기능은 계속 동작(메모리 상 state만 사용) */ }
  }

  // ---------- 런타임 상태(새로고침하면 사라짐 — 저장 대상 아님) ----------
  const state = {
    scanning: false,
    providers: [],   // [{provider, ok, models:[{id, capabilities}], errorType, errorMessage}]
    models: [],      // 평탄화된 모델 목록: [{providerType, providerLabel, baseUrl, model, capabilities}]
    lastError: null,
    lastScanAt: 0,
  };

  const listeners = [];
  function onChange(fn) { listeners.push(fn); }
  function emitChange_() { listeners.forEach(fn => { try { fn(state); } catch (e) {} }); }

  function adapters_() { return window.NamuLocalAI.adapters; }
  function capabilityTest_() { return window.NamuLocalAI.capabilityTest; }

  // ---------- 1) 탐지 ----------
  function detectProviders() {
    const cfg = loadConfig();
    if (!cfg.autoDetect && cfg.knownEndpoints.length === 0) {
      state.providers = [];
      state.models = [];
      emitChange_();
      return Promise.resolve([]);
    }
    state.scanning = true;
    emitChange_();
    const customEndpoints = cfg.knownEndpoints.map(e => ({ type: e.type || 'openai-compatible', label: e.label || e.baseUrl, baseUrl: e.baseUrl }));
    const targets = cfg.autoDetect ? undefined : []; // autoDetect=false면 알려진 기본 포트는 건너뛰고 커스텀 주소만 확인
    const scanPromise = cfg.autoDetect
      ? adapters_().detectAll(customEndpoints)
      : Promise.allSettled(customEndpoints.map(p => adapters_().detect(p))).then(rs => rs.map(r => r.status === 'fulfilled' ? r.value : { ok: false, errorType: 'unknown', errorMessage: '탐지 실패' }));
    return scanPromise.then(results => {
      state.providers = results;
      state.scanning = false;
      state.lastScanAt = Date.now();
      cfg.lastScanAt = state.lastScanAt;
      saveConfig(cfg);
      emitChange_();
      return results;
    });
  }

  // ---------- 2) 능력 실측(발견된 각 모델에 대해) ----------
  // chatCapable 런타임의 모델만 실측 대상으로 삼는다(ComfyUI/Automatic1111은 정보 표시만).
  function runCapabilityScan() {
    const flatTargets = [];
    state.providers.forEach(p => {
      if (!p.ok || !p.provider) return;
      const providerDef = adapters_().KNOWN_PROVIDERS.find(k => k.type === p.provider.type) || p.provider;
      if (providerDef.chatCapable === false) return;
      (p.models || []).forEach(m => {
        flatTargets.push({ providerType: p.provider.type, providerLabel: p.provider.label, baseUrl: p.provider.baseUrl, model: m.id });
      });
    });
    if (!flatTargets.length) {
      state.models = [];
      emitChange_();
      return Promise.resolve([]);
    }
    state.scanning = true;
    emitChange_();
    // 서버 하나에 동시에 여러 요청을 몰아넣으면(특히 GPU 1장짜리 로컬 환경) 응답이 느려지거나
    // 큐잉되어 타임아웃이 날 수 있어, 모델을 하나씩 순서대로 평가한다.
    return flatTargets.reduce((chain, target) => chain.then(acc =>
      capabilityTest_().runFullCapabilityTest(target.providerType, target.baseUrl, target.model).then(cap => {
        acc.push(Object.assign({ providerType: target.providerType, providerLabel: target.providerLabel, baseUrl: target.baseUrl, model: target.model }, { capabilities: cap }));
        return acc;
      }).catch(() => {
        acc.push(Object.assign({ providerType: target.providerType, providerLabel: target.providerLabel, baseUrl: target.baseUrl, model: target.model }, { capabilities: { text: false, korean: false, json: false, vision: null, tools: false, avgResponseMs: null, error: '평가 중 오류' } }));
        return acc;
      })
    ), Promise.resolve([])).then(models => {
      state.models = models;
      state.scanning = false;
      emitChange_();
      autoAssignTasks();
      return models;
    });
  }

  // ---------- 3) 작업별 자동 배정 ----------
  // 규칙: needs 배열의 능력을 모두 만족하는 모델 중, 응답 속도(avgResponseMs)가 가장 빠른
  // 모델을 선택한다. vision이 필요한 작업은 vision===true인 모델만 후보로 삼는다.
  // 이미 사용자가 수동으로 지정해둔(source==='manual') 작업은 절대 덮어쓰지 않는다.
  function pickBestModelFor_(needs) {
    const candidates = state.models.filter(m => {
      const cap = m.capabilities || {};
      return needs.every(n => n === 'vision' ? cap.vision === true : !!cap[n]);
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      const ams = (a.capabilities && a.capabilities.avgResponseMs) || Infinity;
      const bms = (b.capabilities && b.capabilities.avgResponseMs) || Infinity;
      return ams - bms;
    });
    return candidates[0];
  }

  function autoAssignTasks() {
    const cfg = loadConfig();
    cfg.modelAssignments = cfg.modelAssignments || {};
    TASKS.forEach(task => {
      const existing = cfg.modelAssignments[task.key];
      if (existing && existing.source === 'manual') return; // 사용자 지정은 유지
      const best = pickBestModelFor_(task.needs);
      cfg.modelAssignments[task.key] = best
        ? { source: 'auto', providerType: best.providerType, baseUrl: best.baseUrl, model: best.model }
        : { source: 'auto', providerType: null, baseUrl: null, model: null }; // 적합한 모델 없음
    });
    saveConfig(cfg);
    emitChange_();
  }

  function setManualAssignment(taskKey, providerType, baseUrl, model) {
    const cfg = loadConfig();
    cfg.modelAssignments = cfg.modelAssignments || {};
    cfg.modelAssignments[taskKey] = { source: 'manual', providerType, baseUrl, model };
    saveConfig(cfg);
    emitChange_();
  }

  function clearManualAssignment(taskKey) {
    const cfg = loadConfig();
    if (cfg.modelAssignments) delete cfg.modelAssignments[taskKey];
    saveConfig(cfg);
    autoAssignTasks();
  }

  function getAssignedModel(taskKey) {
    const cfg = loadConfig();
    const a = cfg.modelAssignments && cfg.modelAssignments[taskKey];
    if (!a || !a.model || !a.baseUrl) return null;
    return { providerType: a.providerType, chatEndpoint: a.baseUrl, model: a.model, source: a.source };
  }

  // ---------- 커스텀(사용자 지정) 엔드포인트 관리 ----------
  function addCustomEndpoint(baseUrl, typeHint, label) {
    const cfg = loadConfig();
    baseUrl = String(baseUrl || '').trim().replace(/\/$/, '');
    if (!baseUrl) return cfg;
    if (!cfg.knownEndpoints.some(e => e.baseUrl === baseUrl)) {
      cfg.knownEndpoints.push({ baseUrl, type: typeHint || 'openai-compatible', label: label || baseUrl });
      saveConfig(cfg);
    }
    return cfg;
  }
  function removeCustomEndpoint(baseUrl) {
    const cfg = loadConfig();
    cfg.knownEndpoints = cfg.knownEndpoints.filter(e => e.baseUrl !== baseUrl);
    saveConfig(cfg);
    return cfg;
  }
  function setAutoDetect(enabled) {
    const cfg = loadConfig();
    cfg.autoDetect = !!enabled;
    saveConfig(cfg);
  }

  // ---------- 한 번에 전체(탐지→능력평가→자동배정) ----------
  function rescanAll() {
    return detectProviders().then(() => runCapabilityScan());
  }

  // ---------- 공개 채팅/이미지 분석 API(작업 종류로 자동 배정된 모델을 사용) ----------
  function chat(taskKey, messages, opts) {
    const target = getAssignedModel(taskKey);
    if (!target) return Promise.reject(Object.assign(new Error('배정된 로컬 AI 모델이 없습니다.'), { isLocalAiUnavailable: true }));
    return adapters_().chat(target.providerType, target.chatEndpoint, target.model, messages, opts);
  }
  function analyzeImage(taskKey, promptText, imageDataUrl, opts) {
    const target = getAssignedModel(taskKey);
    if (!target) return Promise.reject(Object.assign(new Error('배정된 로컬 비전 모델이 없습니다.'), { isLocalAiUnavailable: true }));
    return adapters_().chatSimple(target.providerType, target.chatEndpoint, target.model, promptText, imageDataUrl, opts);
  }
  function generateStructuredData(taskKey, promptText, opts) {
    return chat(taskKey, [{ role: 'user', content: promptText }], opts);
  }

  function getState() { return state; }

  window.NamuLocalAI.manager = {
    TASKS: TASKS,
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    detectProviders: detectProviders,
    runCapabilityScan: runCapabilityScan,
    rescanAll: rescanAll,
    autoAssignTasks: autoAssignTasks,
    setManualAssignment: setManualAssignment,
    clearManualAssignment: clearManualAssignment,
    getAssignedModel: getAssignedModel,
    addCustomEndpoint: addCustomEndpoint,
    removeCustomEndpoint: removeCustomEndpoint,
    setAutoDetect: setAutoDetect,
    getState: getState,
    onChange: onChange,
    chat: chat,
    analyzeImage: analyzeImage,
    generateStructuredData: generateStructuredData,
  };
})();
