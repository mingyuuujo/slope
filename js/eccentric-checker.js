// eccentric-checker.js — "편심 지지력 검토" 탭 로직

(function () {
  "use strict";

  function r2(v) { return Math.round(v * 100) / 100; }

  function calcCase(V, H, Mv, Mh, B, D, gammaPrime) {
    if (!isFinite(V) || V === 0 || !isFinite(B) || B <= 0 || !isFinite(D) || !isFinite(gammaPrime)) return null;

    const X    = r2((Mv - Mh) / V);
    const e    = r2(B / 2 - X);
    const dist = e < B / 6 ? "사다리꼴분포" : "삼각형분포";

    let p1, p2;
    if (dist === "삼각형분포") {
      p1 = r2((2 / 3) * V / (B * 0.5 - e));
      p2 = 0;
    } else {
      p1 = r2((V / B) * (1 + (6 * e) / B));
      p2 = r2((V / B) * (1 - (6 * e) / B));
    }

    const b     = r2(dist === "삼각형분포" ? 3 * (B / 2 - e) : B);
    const alpha = Math.atan(H / V) * (180 / Math.PI);
    const L     = r2(b + D * (Math.tan(((30 + alpha) * Math.PI) / 180) + Math.tan(((30 - alpha) * Math.PI) / 180)));
    const p1p   = r2((b / L) * p1 + gammaPrime * D);
    const p2p   = r2((b / L) * p2 + gammaPrime * D);
    const bPrime = r2(B / 2 - e);
    const twoBp  = r2(bPrime * 2);

    let q;
    if (dist === "사다리꼴분포") {
      q = r2((p1 + p2) * B / (4 * bPrime));
    } else {
      q = r2(p1 * b / (4 * bPrime));
    }

    return { X, e, dist, p1, p2, b, alpha: r2(alpha), L, p1p, p2p, q, H: r2(H), bPrime, twoBp };
  }

  function getVal(id) {
    const el = document.getElementById(id);
    return el ? parseFloat(el.value) : NaN;
  }

  function updateCalc() {
    const B        = getVal("ecc-tab-B");
    const D        = getVal("ecc-tab-D");
    const gammaSat = getVal("ecc-tab-gammasat");
    const gammaW   = getVal("ecc-tab-gammaw");
    const gammaPrime = isFinite(gammaSat) && isFinite(gammaW) ? r2(gammaSat - gammaW) : NaN;

    const gpEl = document.getElementById("ecc-tab-gammaprime");
    if (gpEl) gpEl.textContent = isFinite(gammaPrime) ? gammaPrime.toFixed(2) : "-";

    const normal  = calcCase(getVal("ecc-tab-Vn"), getVal("ecc-tab-Hn"), getVal("ecc-tab-Mvn"), getVal("ecc-tab-Mhn"), B, D, gammaPrime);
    const seismic = calcCase(getVal("ecc-tab-Ve"), getVal("ecc-tab-He"), getVal("ecc-tab-Mve"), getVal("ecc-tab-Mhe"), B, D, gammaPrime);

    function fillRes(prefix, res) {
      const keys = ["X", "e", "dist", "p1", "p2", "b", "alpha", "L", "p1p", "p2p", "q", "H", "bPrime", "twoBp"];
      keys.forEach((k) => {
        const el = document.getElementById(`${prefix}-${k}`);
        if (!el) return;
        if (!res) { el.innerHTML = "-"; return; }
        const v = res[k];
        if (k === "dist" && typeof v === "string") {
          const cls = v === "사다리꼴분포" ? "dist-trap" : "dist-tri";
          el.innerHTML = `<span class="dist-badge ${cls}">${v}</span>`;
        } else {
          el.textContent = (v !== null && v !== undefined)
            ? (typeof v === "string" ? v : isFinite(v) ? v.toFixed(2) : "-")
            : "-";
        }
      });
    }

    fillRes("ecc-res-n", normal);
    fillRes("ecc-res-e", seismic);
  }

  function exportJson() {
    const data = {
      B:        getVal("ecc-tab-B"),
      D:        getVal("ecc-tab-D"),
      gamma_sat: getVal("ecc-tab-gammasat"),
      gamma_w:  getVal("ecc-tab-gammaw"),
      V_n:  getVal("ecc-tab-Vn"),
      H_n:  getVal("ecc-tab-Hn"),
      Mv_n: getVal("ecc-tab-Mvn"),
      Mh_n: getVal("ecc-tab-Mhn"),
      V_e:  getVal("ecc-tab-Ve"),
      H_e:  getVal("ecc-tab-He"),
      Mv_e: getVal("ecc-tab-Mve"),
      Mh_e: getVal("ecc-tab-Mhe"),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement("a"), { href: url, download: "편심지지력_기초조건.json" });
    a.click();
    URL.revokeObjectURL(url);
  }

  const KEY_TO_ID = {
    B:         "ecc-tab-B",
    D:         "ecc-tab-D",
    gamma_sat: "ecc-tab-gammasat",
    gamma_w:   "ecc-tab-gammaw",
    V_n:       "ecc-tab-Vn",
    H_n:       "ecc-tab-Hn",
    Mv_n:      "ecc-tab-Mvn",
    Mh_n:      "ecc-tab-Mhn",
    V_e:       "ecc-tab-Ve",
    H_e:       "ecc-tab-He",
    Mv_e:      "ecc-tab-Mve",
    Mh_e:      "ecc-tab-Mhe",
  };

  function importJson() {
    document.getElementById("ecc-tab-import-file").click();
  }

  function onImportFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (ev) {
      try {
        const data = JSON.parse(ev.target.result);
        Object.entries(KEY_TO_ID).forEach(([key, id]) => {
          if (key in data) {
            const el = document.getElementById(id);
            if (el) el.value = data[key];
          }
        });
        updateCalc();
      } catch {
        alert("JSON 파일을 읽을 수 없습니다.");
      }
      e.target.value = "";
    };
    reader.readAsText(file);
  }

  function resetForm() {
    const defaults = { "ecc-tab-gammaw": "10.3", "ecc-tab-gammasat": "20" };
    const clearIds = ["ecc-tab-B", "ecc-tab-D", "ecc-tab-Vn", "ecc-tab-Hn", "ecc-tab-Mvn", "ecc-tab-Mhn",
                      "ecc-tab-Ve", "ecc-tab-He", "ecc-tab-Mve", "ecc-tab-Mhe"];
    clearIds.forEach((id) => { const el = document.getElementById(id); if (el) el.value = ""; });
    Object.entries(defaults).forEach(([id, val]) => { const el = document.getElementById(id); if (el) el.value = val; });
    updateCalc();
  }

  function initEccentricChecker() {
    const inputIds = [
      "ecc-tab-B", "ecc-tab-D", "ecc-tab-gammasat", "ecc-tab-gammaw",
      "ecc-tab-Vn", "ecc-tab-Hn", "ecc-tab-Mvn", "ecc-tab-Mhn",
      "ecc-tab-Ve", "ecc-tab-He", "ecc-tab-Mve", "ecc-tab-Mhe",
    ];
    inputIds.forEach((id) => {
      document.getElementById(id)?.addEventListener("input", updateCalc);
    });
    document.getElementById("ecc-tab-export")?.addEventListener("click", exportJson);
    document.getElementById("ecc-tab-import")?.addEventListener("click", importJson);
    document.getElementById("ecc-tab-import-file")?.addEventListener("change", onImportFileChange);
    document.getElementById("ecc-tab-reset")?.addEventListener("click", resetForm);
    updateCalc();
  }

  document.addEventListener("DOMContentLoaded", initEccentricChecker);
})();
