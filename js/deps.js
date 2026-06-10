/** index.html에서 선로드한 vendor 스크립트가 전역에 노출합니다. */
let _JSZip;

export async function getJSZip() {
  if (!_JSZip) {
    _JSZip = globalThis.JSZip;
    if (!_JSZip || typeof _JSZip.loadAsync !== "function") {
      throw new Error(
        "JSZip이 로드되지 않았습니다. vendor/jszip.min.js 로드를 확인하세요.",
      );
    }
  }
  return _JSZip;
}

export async function parseDxfText(text) {
  const DxfParser = globalThis.DxfParser;
  if (!DxfParser || typeof DxfParser !== "function") {
    throw new Error(
      "DxfParser가 로드되지 않았습니다. vendor/dxf-parser.js 로드를 확인하세요.",
    );
  }
  const parser = new DxfParser();
  return parser.parseSync(text);
}

export async function loadGszFromArrayBuffer(buf) {
  const JSZip = await getJSZip();
  const zip = await JSZip.loadAsync(buf);
  const xmlNames = Object.keys(zip.files).filter(
    (n) => !zip.files[n].dir && n.toLowerCase().endsWith(".xml"),
  );
  if (!xmlNames.length) throw new Error("GSZ(ZIP) 안에 XML 파일이 없습니다.");
  const xmlName = xmlNames[0];
  const xmlStr = await zip.file(xmlName).async("string");
  const doc = new DOMParser().parseFromString(xmlStr, "application/xml");
  const pe = doc.querySelector("parsererror");
  if (pe) throw new Error("GSZ 내부 XML 파싱 실패");
  return { zip, xmlName, doc };
}

export async function zipToBlob(zip) {
  return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
}
