"""GeoStudio 2012 일괄 해석 러너.

폴더(또는 .gsz 파일들)를 GeoCmd.exe /solve 로 순차 해석하고,
해석된 .gsz 와 results.json 을 출력 폴더에 저장한다.
웹 '결과 대시보드'는 results.json 을 불러온다.

사용:
    python run_slope.py 입력폴더_또는_gsz... [--out 출력폴더] [--analysis 이름 ...]
"""
import argparse
import csv
import io
import json
import shutil
import subprocess
import sys
import time
import zipfile
from datetime import datetime
from pathlib import Path

GEOCMD_CANDIDATES = [
    r"C:\Program Files (x86)\GEO-SLOPE\GeoStudio 8\Bin\GeoCmd.exe",
    r"C:\Program Files\GEO-SLOPE\GeoStudio 8\Bin\GeoCmd.exe",
]


def find_geocmd(explicit):
    for p in ([explicit] if explicit else []) + GEOCMD_CANDIDATES:
        if p and Path(p).is_file():
            return p
    sys.exit("GeoCmd.exe 를 찾을 수 없습니다. --geocmd 로 경로를 지정하세요.")


def zip_name(info):
    """GeoStudio ZIP 은 UTF-8 이름에 플래그를 안 달아 Python 이 cp437 로 잘못 읽는다."""
    if info.flag_bits & 0x800:
        return info.filename
    try:
        return info.filename.encode("cp437").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return info.filename


def read_results(gsz_path):
    """해석된 .gsz 에서 해석별 임계 FOS 를 읽는다. FOS 가 비어 있으면 fos=None."""
    out = []
    with zipfile.ZipFile(gsz_path) as z:
        for info in z.infolist():
            name = zip_name(info)
            parts = name.split("/")
            if len(parts) < 2 or not parts[-1].lower().startswith("lambdafos_") or not name.lower().endswith(".csv"):
                continue
            text = z.read(info).decode("utf-8-sig", "replace")
            fos = None
            for row in csv.DictReader(io.StringIO(text)):
                try:
                    v = float(row.get("FOSByMoment") or row.get("FOSByForce") or "")
                except ValueError:
                    continue
                fos = v if fos is None else min(fos, v)
            out.append({"analysis": parts[0], "fos": fos})
    return sorted(out, key=lambda r: r["analysis"])


def read_failures(log_path):
    """GeoCmd 로그에서 'Failed : "해석명", Verify: ...' 와 그 아래 Details 항목을 뽑는다."""
    try:
        lines = Path(log_path).read_text(encoding="utf-8-sig", errors="replace").splitlines()
    except OSError:
        return []
    fails = []
    for i, ln in enumerate(lines):
        if "Failed" in ln and '"' in ln and "Failed to solve" not in ln:
            name = ln.split('"')[1]
            detail = [d.strip() for d in lines[i + 1:i + 8] if d.strip()[:2] in ("1.", "2.", "3.", "4.", "5.")]
            fails.append({"analysis": name, "reason": " / ".join(detail) or ln.split("Failed")[-1].strip(" :")})
    return fails


def collect_inputs(paths):
    files = []
    for p in map(Path, paths):
        files += sorted(p.glob("*.gsz")) if p.is_dir() else [p]
    return [f for f in files if f.is_file()]


def solve_file(geocmd, dst, out, analyses=()):
    """dst(.gsz) 를 제자리에서 해석하고 results.json 의 files[] 항목을 돌려준다."""
    log = out / "logs" / f"{dst.stem}.log"
    (out / "logs").mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    proc = subprocess.run(
        [geocmd, str(dst), *analyses, "/solve", f"/log:{log}"],
        capture_output=True, text=True, errors="replace",
        cwd=out / "logs",  # GeoCmd 가 작업 폴더에 임시 로그를 남긴다
    )
    entry = {"file": dst.name, "seconds": round(time.time() - t0, 1), "exitCode": proc.returncode,
             "analyses": [], "error": None}
    try:
        entry["analyses"] = read_results(dst)
    except Exception as e:  # 깨진 gsz 등
        entry["error"] = f"결과 읽기 실패: {e}"
    entry["failures"] = read_failures(log)
    # 해석에 실패한 항목은 gsz 안에 이전 결과가 남아 있어도 새 결과로 읽지 않는다.
    # (GeoCmd /clean 은 파일을 지워 버리므로 쓰지 않는다.)
    failed = {f["analysis"].replace(":", "&4") for f in entry["failures"]}
    entry["analyses"] = [a for a in entry["analyses"] if a["analysis"] not in failed]
    if proc.returncode != 0:
        entry["error"] = entry["error"] or "; ".join(
            f'{f["analysis"]}: {f["reason"]}' for f in entry["failures"]) or f"GeoCmd 종료코드 {proc.returncode}"
    return entry


def save_run(out, run):
    """results.json 을 쓰고, 덮어쓰기 전의 이전 실행(없으면 None)을 history/ 에 보관해 돌려준다."""
    res = out / "results.json"
    previous = None
    if res.exists():
        hist = out / "history"
        hist.mkdir(exist_ok=True)
        shutil.copy2(res, hist / f"results_{datetime.now():%Y%m%d_%H%M%S}.json")
        try:
            previous = json.loads(res.read_text(encoding="utf-8"))
        except ValueError:
            pass
    res.write_text(json.dumps(run, ensure_ascii=False, indent=2), encoding="utf-8")
    return previous


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", help=".gsz 파일 또는 폴더")
    ap.add_argument("--out", default="solved", help="출력 폴더 (기본: solved)")
    ap.add_argument("--analysis", nargs="*", default=[], help="해석할 해석 이름 (생략 시 전체)")
    ap.add_argument("--geocmd", help="GeoCmd.exe 경로")
    args = ap.parse_args()

    geocmd = find_geocmd(args.geocmd)
    files = collect_inputs(args.inputs)
    if not files:
        sys.exit("해석할 .gsz 파일이 없습니다.")

    out = Path(args.out).resolve()  # cwd 를 바꿔 실행하므로 절대경로로
    out.mkdir(parents=True, exist_ok=True)
    (out / "logs").mkdir(exist_ok=True)

    run = {"runAt": datetime.now().isoformat(timespec="seconds"), "geocmd": geocmd, "files": []}
    for i, src in enumerate(files, 1):
        dst = out / src.name
        if src.resolve() != dst.resolve():
            shutil.copy2(src, dst)  # 원본은 건드리지 않는다
        print(f"[{i}/{len(files)}] {src.name} 해석 중...", flush=True)
        entry = solve_file(geocmd, dst, out, args.analysis)
        no_fos = [a["analysis"] for a in entry["analyses"] if a["fos"] is None]
        print(f"    {entry['seconds']}s, 해석 {len(entry['analyses'])}개, FOS 없음 {len(no_fos)}개"
              + (f", 오류: {entry['error']}" if entry["error"] else ""), flush=True)
        run["files"].append(entry)

    save_run(out, run)
    res = out / "results.json"
    print(f"완료: {res}")


if __name__ == "__main__":
    main()
