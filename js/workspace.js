const descriptions = {
  materials: ['모델 준비', '지반 재료와 강도 모델을 정의하고 GSZ 파일에 적용합니다.'],
  mapping: ['모델 준비', '단면을 확인하고 영역별 재료, 수위 및 하중 조건을 지정합니다.'],
  'gsz-edit': ['모델 준비', '해석별 파라미터와 탐색 조건을 검토하고 수정합니다.'],
  'dxf-convert': ['모델 준비', 'DXF 단면을 GeoStudio 해석 모델로 변환합니다.'],
  eccentric: ['해석 · 검토', '기초 조건과 하중을 입력하고 상시·지진시 지반반력을 비교합니다.'],
  result: ['해석 · 검토', '활동면과 안전율을 검토하고 결과 보고서를 작성합니다.'],
  pipeline: ['일괄 작업', '여러 해석 파일의 실행 순서와 자동화 조건을 설정합니다.'],
  'batch-mat': ['일괄 작업', '공통 재료 조건을 여러 GSZ 파일에 일괄 적용합니다.'],
  'batch-case': ['일괄 작업', '하중과 수위 조건을 케이스 템플릿으로 관리합니다.'],
  batch: ['일괄 작업', '일괄 해석의 안전율을 비교하고 기준 미달 항목을 확인합니다.'],
};

const tabs = [...document.querySelectorAll('.tab-btn')];
function syncWorkspace() {
  const active = tabs.find(button => button.classList.contains('active'));
  if (!active) return;
  const [group, description] = descriptions[active.dataset.tab];
  document.getElementById('workspace-title').textContent = active.textContent;
  document.getElementById('workspace-description').textContent = description;
  document.getElementById('workspace-breadcrumb').textContent = `워크스페이스 / ${group}`;
  document.getElementById('workspace-status').textContent = active.textContent;
  tabs.forEach(button => {
    const selected = button === active;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    button.id ||= `tab-${button.dataset.tab}`;
    button.setAttribute('aria-controls', `panel-${button.dataset.tab}`);
    document.getElementById(`panel-${button.dataset.tab}`).setAttribute('aria-labelledby', button.id);
  });
}

// Observe the existing controller so calculation and canvas lifecycle stay intact.
new MutationObserver(syncWorkspace).observe(document.querySelector('.tabs'), {
  subtree: true, attributes: true, attributeFilter: ['class'],
});
document.querySelector('.tabs').addEventListener('keydown', event => {
  const current = tabs.indexOf(document.activeElement);
  if (current < 0) return;
  let next;
  if (event.key === 'ArrowDown') next = (current + 1) % tabs.length;
  if (event.key === 'ArrowUp') next = (current - 1 + tabs.length) % tabs.length;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = tabs.length - 1;
  if (next === undefined) return;
  event.preventDefault();
  tabs[next].focus();
  tabs[next].click();
});

const resources = document.getElementById('project-resources');
const toggle = document.getElementById('workspace-resources');
function setResources(open) {
  resources.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  // Canvas sizing uses the same resize listeners as a browser window resize.
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}
toggle.addEventListener('click', () => setResources(resources.hidden));
document.getElementById('resources-close').addEventListener('click', () => {
  setResources(false);
  toggle.focus();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !resources.hidden) {
    setResources(false);
    toggle.focus();
  }
});
syncWorkspace();
