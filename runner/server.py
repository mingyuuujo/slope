"""웹 '자동 실행' 탭이 호출하는 로컬 해석 서버.

127.0.0.1 에서만 열리고, 시작할 때 만든 토큰(runner/token.txt)을 아는 요청만 처리한다.
  GET  /health                  -> {"ok": true, "geocmd": ...}
  POST /solve?file=이름.gsz      -> 본문(.gsz)을 solved/ 에 저장·해석하고 files[] 항목을 반환
  POST /finish                  -> 본문(run JSON)을 results.json 으로 저장, {"previous": 이전 실행|null}
  GET  /solved?file=이름.gsz     -> 해석이 끝난 .gsz 내려받기

사용: python server.py [--port 8770] [--out solved]
"""
import argparse
import json
import secrets
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # python -I 로 실행해도 run_slope 를 찾도록

import run_slope  # noqa: E402
MAX_BODY = 512 * 1024 * 1024


def load_token():
    f = HERE / "token.txt"
    if not f.exists():
        f.write_text(secrets.token_urlsafe(16), encoding="utf-8")
    return f.read_text(encoding="utf-8").strip()


def safe_name(name):
    """경로 성분을 떼어내 solved/ 밖으로 못 나가게 하고 .gsz 만 허용한다."""
    n = Path(name or "").name
    if not n.lower().endswith(".gsz") or n.startswith("."):
        raise ValueError("파일 이름은 .gsz 여야 합니다.")
    return n


def make_handler(token, out, geocmd):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *a):
            print("  ", self.address_string(), fmt % a, flush=True)

        def _cors(self):
            origin = self.headers.get("Origin")
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "X-Token, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            # https 웹 페이지에서 로컬 서버를 부르는 Private Network Access 예비 요청 허용
            self.send_header("Access-Control-Allow-Private-Network", "true")

        def _json(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _authed(self):
            if secrets.compare_digest(self.headers.get("X-Token", ""), token):
                return True
            self._json(401, {"error": "토큰이 맞지 않습니다. runner/token.txt 의 값을 입력하세요."})
            return False

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self):
            u = urlparse(self.path)
            if u.path == "/health":
                if self._authed():
                    self._json(200, {"ok": True, "geocmd": geocmd, "out": str(out)})
            elif u.path == "/solved":
                if not self._authed():
                    return
                try:
                    f = out / safe_name(parse_qs(u.query).get("file", [""])[0])
                    data = f.read_bytes()
                except (ValueError, OSError) as e:
                    return self._json(404, {"error": str(e)})
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            else:
                self._json(404, {"error": "없는 경로"})

        def _body(self):
            n = int(self.headers.get("Content-Length", 0))
            if n > MAX_BODY:
                raise ValueError("파일이 너무 큽니다.")
            return self.rfile.read(n)

        def do_POST(self):
            if not self._authed():
                return
            u = urlparse(self.path)
            try:
                if u.path == "/solve":
                    name = safe_name(parse_qs(u.query).get("file", [""])[0])
                    analyses = parse_qs(u.query).get("analysis", [])
                    out.mkdir(parents=True, exist_ok=True)
                    dst = out / name
                    dst.write_bytes(self._body())
                    print(f"해석 시작: {name}", flush=True)
                    entry = run_slope.solve_file(geocmd, dst, out, analyses)
                    print(f"  → {entry['seconds']}s, 해석 {len(entry['analyses'])}개"
                          + (f", 오류: {entry['error']}" if entry["error"] else ""), flush=True)
                    self._json(200, entry)
                elif u.path == "/finish":
                    run = json.loads(self._body().decode("utf-8"))
                    previous = run_slope.save_run(out, run)
                    self._json(200, {"previous": previous})
                else:
                    self._json(404, {"error": "없는 경로"})
            except ValueError as e:  # 잘못된 이름·JSON
                self._json(400, {"error": str(e)})
            except Exception as e:  # noqa: BLE001 — 서버가 죽지 않게 응답으로 돌려준다
                self._json(500, {"error": f"{type(e).__name__}: {e}"})

    return Handler


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--out", default=str(HERE.parent / "solved"))
    ap.add_argument("--geocmd")
    args = ap.parse_args()

    geocmd = run_slope.find_geocmd(args.geocmd)
    out = Path(args.out).resolve()
    token = load_token()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(token, out, geocmd))
    print(f"해석 서버 시작: http://127.0.0.1:{args.port}")
    print(f"출력 폴더: {out}")
    print(f"토큰(웹 '자동 실행' 탭에 한 번 입력): {token}")
    print("종료: Ctrl+C", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
