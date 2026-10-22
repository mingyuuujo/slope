/**
 * 프로젝트 파일 관리 (.slope JSON)
 * 물성 + 케이스 템플릿 + 규칙 + 기준값을 하나의 파일로 통합
 */

const PROJECT_VERSION = "1.0";

export class Project {
  constructor(name = "새 프로젝트") {
    this.version = PROJECT_VERSION;
    this.name = name;
    this.created = new Date().toISOString();
    this.modified = new Date().toISOString();
    this.materials = {}; // {id: {name, model, uw, dw, c, phi, ...}}
    this.templates = []; // [{name, waterText, khText, pressureText}, ...]
    this.rules = ""; // "지진 = 지진시\n정상 = 정상시\n* = 기본"
    this.benchmarks = {
      normal: 1.3,
      seismic: 1.1,
      construction: 1.2,
    };
    this.dxfPath = "";
    this.notes = "";
  }

  static fromJSON(json) {
    const data = typeof json === "string" ? JSON.parse(json) : json;
    const proj = new Project(data.name);
    Object.assign(proj, data);
    return proj;
  }

  static fromFile(obj) {
    return this.fromJSON(obj);
  }

  toJSON() {
    return {
      version: this.version,
      name: this.name,
      created: this.created,
      modified: new Date().toISOString(),
      materials: this.materials,
      templates: this.templates,
      rules: this.rules,
      benchmarks: this.benchmarks,
      dxfPath: this.dxfPath,
      notes: this.notes,
    };
  }

  download(filename = null) {
    const name = filename || `${this.name}.slope`;
    const json = JSON.stringify(this.toJSON(), null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  addMaterial(id, name, model, values = {}) {
    this.materials[id] = {
      name,
      model,
      uw: values.uw ?? "",
      dw: values.dw ?? "",
      c: values.c ?? "",
      phi: values.phi ?? "",
      c_top: values.c_top ?? "",
      c_rate: values.c_rate ?? "",
      c_datum: values.c_datum ?? "",
      datum_elev: values.datum_elev ?? "",
      color: values.color ?? "",
    };
  }

  addTemplate(name, waterText = "", khText = "", pressureText = "") {
    // 중복 확인
    if (this.templates.find((t) => t.name === name)) return false;
    this.templates.push({ name, waterText, khText, pressureText });
    return true;
  }
}

/**
 * 로컬 저장소에 프로젝트 목록 저장
 */
const PROJECTS_STORAGE_KEY = "slope.projects";

export function getProjectList() {
  try {
    const data = localStorage.getItem(PROJECTS_STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export function saveProjectToStorage(project) {
  try {
    const list = getProjectList();
    const idx = list.findIndex((p) => p.name === project.name);
    const meta = { name: project.name, modified: project.modified, created: project.created };
    if (idx >= 0) list[idx] = meta;
    else list.unshift(meta);
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(list.slice(0, 10))); // 최근 10개
    return true;
  } catch {
    return false;
  }
}

export function loadProjectFromStorage(name) {
  try {
    const key = `slope.project.${name}`;
    const data = localStorage.getItem(key);
    return data ? Project.fromJSON(data) : null;
  } catch {
    return null;
  }
}

export function deleteProjectFromStorage(name) {
  try {
    const key = `slope.project.${name}`;
    localStorage.removeItem(key);
    const list = getProjectList().filter((p) => p.name !== name);
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}
