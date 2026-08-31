/*
 * NAMU Local AI — 화면 표시(js/local-ai-ui.js)
 * ------------------------------------------------------------
 * 컷리스트 탭의 상태 패널(#localAiStatusPanel), 스토리보드 자동생성 모달의 자동탐색
 * 요약(#cai-local-auto-summary), 로컬 AI 실패 시 4택 선택 UI(#cai-fallback-choice)를
 * 그린다. 이 파일은 window.NamuLocalAI.manager/adapters/capabilityTest에만 의존하고,
 * index.html의 기존 함수(escapeHtml_ 등)가 아직 로드되기 전이어도 동작하도록 자체
 * 이스케이프 함수를 둔다.
 */
(function () {
  'use strict';
  window.NamuLocalAI = window.NamuLocalAI || {};

  let mounted = false;
  let mountedContainerId = null;

  function esc_(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function manager_() { return window.NamuLocalAI.manager; }

  function badge_(label, value) {
    let bg, color, text;
    if (value === true) { bg = 'var(--good)'; color = '#fff'; text = label; }
    else if (value === false) { bg = 'var(--surface-2)'; color = 'var(--text-muted)'; text = label; }
    else { bg = 'var(--surface-2)'; color = 'var(--text-muted)'; text = label + '(미확인)'; }
    return `<span style="display:inline-block; font-size:10.5px; font-weight:700; border-radius:999px; padding:2px 8px; margin:2px 4px 2px 0; background:${bg}; color:${color}; border:1px solid var(--border);">${text}</span>`;
  }

  function optionValue_(m) { return m.providerType + '::' + m.baseUrl + '::' + m.model; }
  function parseOptionValue_(v) { const parts = String(v).split('::'); return { providerType: parts[0], baseUrl: parts[1], model: parts.slice(2).join('::') }; }

  function providerRowHtml_(p) {
    if (p.ok) {
      const label = p.provider.label;
      const modelCount = (p.models || []).length;
      return `<div style="padding:6px 0; border-bottom:1px solid var(--border); font-size:12.5px;">
        <span style="color:var(--good); font-weight:700;">● 연결됨</span>
        &nbsp;<strong>${esc_(label)}</strong>
        <span style="color:var(--text-muted);"> — ${esc_(p.provider.baseUrl)} · 모델 ${modelCount}개</span>
      </div>`;
    }
    if (!p.provider) return '';
    // 탐지 대상이 아닌데(priority 3=이미지 생성 전용) 실패한 경우는 굳이 크게 경고 표시하지 않음
    const isMinor = p.provider.chatCapable === false;
    const ollamaHint = (p.provider.type === 'ollama' && p.errorType === 'unreachable')
      ? `<div style="font-size:11px; color:var(--text-muted); margin-top:2px;">💡 Ollama가 켜져 있는데도 이렇게 뜬다면, 터미널에서 <code>OLLAMA_ORIGINS=*</code> 환경변수를 설정한 뒤 Ollama를 다시 실행해보세요(이 사이트의 요청을 허용하도록 CORS를 열어주는 설정입니다).</div>`
      : '';
    return `<div style="padding:6px 0; border-bottom:1px solid var(--border); font-size:12.5px; ${isMinor ? 'opacity:.55;' : ''}">
      <span style="color:var(--text-muted); font-weight:700;">○ 미발견</span>
      &nbsp;<strong>${esc_(p.provider.label)}</strong>
      <span style="color:var(--text-muted);"> — ${esc_(p.provider.baseUrl)}</span>
      <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">${esc_(p.errorMessage || '')}</div>
      ${ollamaHint}
    </div>`;
  }

  function modelRowHtml_(m) {
    const c = m.capabilities || {};
    const speed = c.avgResponseMs != null ? `<span style="display:inline-block; font-size:10.5px; font-weight:700; border-radius:999px; padding:2px 8px; margin:2px 4px 2px 0; background:var(--surface-2); color:var(--text-secondary); border:1px solid var(--border);">⚡ ${c.avgResponseMs}ms</span>` : '';
    return `<div style="padding:8px 0; border-bottom:1px solid var(--border);">
      <div style="font-size:12.5px; font-weight:700;">${esc_(m.model)} <span style="font-weight:400; color:var(--text-muted);">· ${esc_(m.providerLabel)}</span></div>
      <div style="margin-top:3px;">
        ${badge_('텍스트', c.text)}${badge_('한국어', c.korean)}${badge_('JSON', c.json)}${badge_('비전', c.vision)}${badge_('도구호출', c.tools)}${speed}
      </div>
    </div>`;
  }

  function taskRowHtml_(task, cfg) {
    const assignment = (cfg.modelAssignments && cfg.modelAssignments[task.key]) || null;
    const state = manager_().getState();
    const candidates = state.models.filter(m => {
      const cap = m.capabilities || {};
      return task.needs.every(n => n === 'vision' ? cap.vision === true : !!cap[n]);
    });
    const options = candidates.map(m => `<option value="${esc_(optionValue_(m))}" ${assignment && assignment.source === 'manual' && assignment.model === m.model && assignment.baseUrl === m.baseUrl ? 'selected' : ''}>${esc_(m.model)} (${esc_(m.providerLabel)})</option>`).join('');
    const autoLabel = (assignment && assignment.model) ? `${esc_(assignment.model)} · ${esc_(assignment.providerType || '')}` : '없음';
    const noneNote = candidates.length === 0 ? `<div style="font-size:11px; color:var(--warning);">적합한 로컬 모델 없음</div>` : '';
    return `<div style="display:flex; align-items:center; gap:8px; padding:7px 0; border-bottom:1px solid var(--border); flex-wrap:wrap;">
      <div style="flex:0 0 175px; font-size:12.5px; color:var(--text-secondary);">${esc_(task.label)}</div>
      <select style="flex:1; min-width:180px;" onchange="NamuLocalAI.ui.onAssignmentChange('${task.key}', this.value)">
        <option value="__auto__" ${!assignment || assignment.source !== 'manual' ? 'selected' : ''}>자동 추천 (${autoLabel})</option>
        ${options}
      </select>
      ${assignment && assignment.source === 'manual' ? '<span style="font-size:11px; color:var(--text-muted);">수동 지정</span>' : ''}
      ${noneNote}
    </div>`;
  }

  function render() {
    if (!mountedContainerId) return;
    const container = document.getElementById(mountedContainerId);
    if (!container) return;
    const state = manager_().getState();
    const cfg = manager_().loadConfig();

    const providersHtml = state.providers.length
      ? state.providers.map(providerRowHtml_).join('')
      : `<div style="font-size:12.5px; color:var(--text-muted); padding:6px 0;">${state.scanning ? '탐색 중…' : '아직 탐색하지 않았습니다.'}</div>`;

    const modelsHtml = state.models.length
      ? state.models.map(modelRowHtml_).join('')
      : `<div style="font-size:12.5px; color:var(--text-muted); padding:6px 0;">발견된 모델이 없습니다.</div>`;

    const tasksHtml = manager_().TASKS.map(t => taskRowHtml_(t, cfg)).join('');

    const customRows = cfg.knownEndpoints.map(e => `<div style="display:flex; align-items:center; gap:6px; font-size:12px; padding:3px 0;">
        <span style="color:var(--text-secondary);">${esc_(e.label)}</span>
        <button type="button" style="font-size:11px; padding:2px 8px;" onclick="NamuLocalAI.ui.removeCustomEndpoint('${esc_(e.baseUrl)}')">삭제</button>
      </div>`).join('');

    container.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-bottom:8px;">
        <h3 style="margin:0; font-size:14px;">🖥️ 로컬 AI 자동 탐색</h3>
        <div style="display:flex; gap:6px;">
          <button type="button" onclick="NamuLocalAI.ui.rescan()">${state.scanning ? '탐색 중…' : '다시 탐색'}</button>
          <button type="button" onclick="NamuLocalAI.ui.toggleAdvanced()">고급 설정 ▾</button>
        </div>
      </div>
      <div style="font-size:11.5px; color:var(--text-muted); margin-bottom:8px;">
        이 컴퓨터에서 실행 중인 Ollama·LM Studio 등 로컬 AI 서버를 자동으로 찾아 모델을 실측 평가하고, 아래 작업에 알맞은 모델을 자동으로 배정합니다.
        이 화면의 설정은 이 브라우저에만 저장되며(팀 공유 저장소로 전송되지 않음), 로컬 AI 데이터는 이 컴퓨터 밖으로 나가지 않습니다.
      </div>
      <div id="localAiAdvancedBlock" style="display:none; border-top:1px dashed var(--border); padding-top:8px; margin-top:4px;">
        <div style="font-size:12.5px; font-weight:700; margin-bottom:4px;">발견된 서버</div>
        ${providersHtml}
        <div style="font-size:12.5px; font-weight:700; margin:10px 0 4px;">발견된 모델 능력 평가</div>
        ${modelsHtml}
        <div style="font-size:12.5px; font-weight:700; margin:10px 0 4px;">작업별 자동 배정 (직접 선택 가능)</div>
        ${tasksHtml}
        <div style="font-size:12.5px; font-weight:700; margin:10px 0 4px;">사용자 지정 서버 주소 추가</div>
        ${customRows}
        <div style="display:flex; gap:6px; margin-top:4px;">
          <input type="text" id="localAiCustomEndpointInput" placeholder="예: http://localhost:9000" style="flex:1;">
          <button type="button" onclick="NamuLocalAI.ui.addCustomEndpointFromInput()">추가</button>
        </div>
        <div class="note-box" style="margin-top:10px;">임의의 포트를 무작위로 스캔하지 않습니다 — 위에 나열된 잘 알려진 기본 주소와, 사용자가 직접 추가한 주소만 확인합니다. 각 확인 요청에는 짧은 제한 시간이 적용됩니다.</div>
      </div>
    `;
    renderCutlistSummary_();
  }

  function renderCutlistSummary_() {
    const el = document.getElementById('cai-local-auto-summary');
    if (!el) return;
    const target = manager_().getAssignedModel('storyboardVision');
    if (target) {
      el.innerHTML = `<div class="note-box" style="margin:0 0 8px;">자동 탐색됨: 스토리보드 이미지 분석에 <strong>${esc_(target.model)}</strong>(${esc_(target.providerType)})을 사용할 수 있습니다. 아래 주소를 직접 입력하면 이 자동 추천 대신 그 값을 사용합니다.</div>`;
    } else {
      el.innerHTML = `<div class="note-box" style="margin:0 0 8px;">자동 탐색된 로컬 비전 모델이 없습니다. 로컬 AI 서버(Ollama·LM Studio 등)를 켠 뒤 위 상태 패널에서 "다시 탐색"을 눌러보거나, 아래에 서버 주소를 직접 입력하세요.</div>`;
    }
  }

  function mount(containerId) {
    mountedContainerId = containerId;
    manager_().onChange(render);
    render();
    if (!mounted) {
      mounted = true;
      // 페이지를 열 때 사용자가 아무 설정을 하지 않아도 자동으로 한 번 탐색한다(가벼운 시도 —
      // 기본 포트 몇 개 + 사용자가 등록해둔 주소만, 각 1~2초 타임아웃, 병렬 실행).
      manager_().rescanAll();
    }
  }

  function rescan() { manager_().rescanAll(); }

  function toggleAdvanced() {
    const el = document.getElementById('localAiAdvancedBlock');
    if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
  }

  function onAssignmentChange(taskKey, value) {
    if (value === '__auto__') { manager_().clearManualAssignment(taskKey); return; }
    const parsed = parseOptionValue_(value);
    manager_().setManualAssignment(taskKey, parsed.providerType, parsed.baseUrl, parsed.model);
  }

  function addCustomEndpointFromInput() {
    const input = document.getElementById('localAiCustomEndpointInput');
    if (!input || !input.value.trim()) return;
    manager_().addCustomEndpoint(input.value.trim());
    input.value = '';
    manager_().rescanAll();
  }

  function removeCustomEndpoint(baseUrl) {
    manager_().removeCustomEndpoint(baseUrl);
    manager_().rescanAll();
  }

  // ---------- 로컬 AI 실패 시 4택 선택 UI(#cai-fallback-choice) ----------
  // 사용자 요구사항: 로컬 처리가 실패해도 절대 조용히 클라우드로 넘어가지 않는다.
  function showFallbackChoice(opts) {
    opts = opts || {};
    const el = document.getElementById('cai-fallback-choice');
    if (!el) { if (opts.onCancel) opts.onCancel(); return; }
    el.innerHTML = `
      <div style="margin-bottom:8px; color:var(--critical); font-weight:700; font-size:12.5px;">⚠️ 로컬 AI 처리 실패</div>
      <div style="margin-bottom:8px; font-size:12px; white-space:pre-wrap;">${esc_(opts.message || '로컬 AI 처리 중 문제가 발생했습니다.')}</div>
      <div style="margin-bottom:10px; font-size:11px; color:var(--text-muted);">개인정보·기밀 보호를 위해 실패 시 클라우드 AI로 자동 전환하지 않습니다. 아래에서 직접 선택해주세요.</div>
      <div style="display:flex; flex-wrap:wrap; gap:8px;">
        <button type="button" data-choice="retry">로컬에서 다시 시도</button>
        <button type="button" data-choice="pick">다른 로컬 모델 선택</button>
        <button type="button" class="primary" data-choice="cloud">클라우드 AI 사용</button>
        <button type="button" data-choice="cancel">취소</button>
      </div>`;
    el.style.display = '';
    const bind = (choice, cb) => { const b = el.querySelector(`[data-choice="${choice}"]`); if (b) b.onclick = () => { hideFallbackChoice(); if (cb) cb(); }; };
    bind('retry', opts.onRetryLocal);
    bind('pick', opts.onPickModel);
    bind('cloud', opts.onUseCloud);
    bind('cancel', opts.onCancel);
  }

  function hideFallbackChoice() {
    const el = document.getElementById('cai-fallback-choice');
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  }

  window.NamuLocalAI.ui = {
    mount: mount,
    render: render,
    rescan: rescan,
    toggleAdvanced: toggleAdvanced,
    onAssignmentChange: onAssignmentChange,
    addCustomEndpointFromInput: addCustomEndpointFromInput,
    removeCustomEndpoint: removeCustomEndpoint,
    showFallbackChoice: showFallbackChoice,
    hideFallbackChoice: hideFallbackChoice,
  };
})();
