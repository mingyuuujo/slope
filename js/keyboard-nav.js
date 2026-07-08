/**
 * 키보드 탐색 유틸리티
 * - installTableArrowNav : tbody에 ↑↓ / Enter / Tab 탐색 설치 (이벤트 위임)
 * - installWheelBlockOnNumberInputs : input[type=number] 마우스 휠 차단
 */

/**
 * tbody에 키보드 탐색을 설치합니다.
 * 이벤트 위임 방식이므로 tbody.innerHTML 이 교체되어도 바인딩이 유지됩니다.
 *
 * 동작:
 *   ↑ / ↓  — 같은 열(셀 인덱스)의 위/아래 행으로 포커스 이동
 *   Enter   — 같은 열의 다음 행으로 이동; 마지막 행이면 onEnterLastRow() 호출
 *   Tab     — 행 끝에서 다음 행 첫 칸, 행 처음에서 이전 행 마지막 칸으로 순환
 *             (readonly/disabled 입력은 자동으로 건너뜀)
 *
 * @param {HTMLElement} tbody
 * @param {{
 *   cellSelector?: string,       // 포커스 대상 선택자 (기본값 아래 참조)
 *   onEnterLastRow?: () => void  // 마지막 행에서 Enter 시 콜백
 * }} opts
 */
export function installTableArrowNav(tbody, opts = {}) {
  if (!tbody || tbody._kbNavInstalled) return;
  tbody._kbNavInstalled = true;

  // input[type=color] 는 숨겨진 색상 피커이므로 제외
  const SEL = opts.cellSelector
    ?? 'input:not([readonly]):not([disabled]):not([type=color]), select:not([disabled])';

  function getFocusables(tr) {
    return [...tr.querySelectorAll(SEL)];
  }

  tbody.addEventListener('keydown', (e) => {
    const tgt = e.target;
    if (!tgt.matches('input, select')) return;
    const tr = tgt.closest('tr');
    if (!tr || tr.parentElement !== tbody) return;

    const rows = [...tbody.querySelectorAll(':scope > tr')];
    const rowIdx = rows.indexOf(tr);
    if (rowIdx < 0) return;

    const cells = getFocusables(tr);
    const cellIdx = cells.indexOf(tgt);
    const safeIdx = Math.max(cellIdx, 0);

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const nextRowIdx = rowIdx + (e.key === 'ArrowDown' ? 1 : -1);
      if (nextRowIdx < 0 || nextRowIdx >= rows.length) return;
      const nextCells = getFocusables(rows[nextRowIdx]);
      if (!nextCells.length) return;
      const target = nextCells[Math.min(safeIdx, nextCells.length - 1)];
      target.focus();
      target.select?.();

    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (rowIdx < rows.length - 1) {
        const nextCells = getFocusables(rows[rowIdx + 1]);
        if (!nextCells.length) return;
        const target = nextCells[Math.min(safeIdx, nextCells.length - 1)];
        target.focus();
        target.select?.();
      } else if (opts.onEnterLastRow) {
        opts.onEnterLastRow();
        // rAF: 새 행이 DOM에 추가된 뒤 포커스
        requestAnimationFrame(() => {
          const newRows = [...tbody.querySelectorAll(':scope > tr')];
          const newRow = newRows[newRows.length - 1];
          if (!newRow) return;
          const newCells = getFocusables(newRow);
          const target = newCells[Math.min(safeIdx, newCells.length - 1)] ?? newCells[0];
          if (target) { target.focus(); target.select?.(); }
        });
      }

    } else if (e.key === 'Tab') {
      const nextIdx = e.shiftKey ? cellIdx - 1 : cellIdx + 1;
      if (!e.shiftKey && nextIdx >= cells.length && rowIdx + 1 < rows.length) {
        // 행 끝 → 다음 행 첫 칸
        e.preventDefault();
        const nextCells = getFocusables(rows[rowIdx + 1]);
        if (nextCells[0]) { nextCells[0].focus(); nextCells[0].select?.(); }
      } else if (e.shiftKey && nextIdx < 0 && rowIdx > 0) {
        // 행 처음 ← 이전 행 마지막 칸
        e.preventDefault();
        const prevCells = getFocusables(rows[rowIdx - 1]);
        const target = prevCells[prevCells.length - 1];
        if (target) { target.focus(); target.select?.(); }
      }
      // 그 외: 브라우저 기본 Tab 동작 유지
    }
  });
}

/**
 * input[type=number] 칸에 포커스된 상태에서 마우스 휠로 값이 변경되지 않도록 차단
 */
export function installWheelBlockOnNumberInputs() {
  document.addEventListener('wheel', (e) => {
    if (document.activeElement === e.target &&
        e.target.tagName === 'INPUT' &&
        e.target.type === 'number') {
      e.preventDefault();
    }
  }, { passive: false });
}
