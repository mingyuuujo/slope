#!/usr/bin/env python3
"""
DXF 닫힌 폴리선(LWPOLYLINE) → GeoStudio Slope/W Points/Regions Excel 변환기

GeoStudio 모델 구조에 맞춘 기본값:
  - Points: ID, X (m), Y (m), Label="Point+Number", Pinned="No"
  - Regions: Region, Points(쉼표 구분 ID), Type="Domain Polygon"
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass, field, replace
from math import hypot
from pathlib import Path
from typing import Iterable, Sequence

import ezdxf
import pandas as pd
from ezdxf.document import Drawing
from ezdxf.entities import LWPolyline
from ezdxf.enums import TextEntityAlignment


# ---------------------------------------------------------------------------
# GeoStudio Slope/W 기본 파라미터 (온산항 3구간 XML 기준 역분석)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class GeoStudioConfig:
    """GeoStudio Slope/W Excel import 형식 및 좌표 처리 규칙."""

    # Points 시트 상수 (GeoStudio Define → KeyIn/Import 형식)
    point_label: str = "Point+Number"
    point_pinned: str = "No"

    # Regions 시트 상수
    region_type: str = "Domain Polygon"

    # 좌표 중복 판별 허용오차 [m]
    # GeoStudio 모델에서 서로 다른 Point 간 최소 거리 ≈ 2e-5 m → 1e-5 m 미만으로 설정
    coordinate_tolerance: float = 1e-5

    # Excel 출력 소수 자릿수 (GeoStudio XML 좌표 표현과 동일 수준)
    coordinate_decimals: int = 5

    # Point ID 부여 순서
    #   discovery : DXF 폴리선 순서 → 꼭짓점 순서 (GeoStudio에서 순차 작도 시와 유사)
    #   sort_yx   : Y↑, X↑ (검증·재현용)
    #   sort_xy   : X↑, Y↑
    point_id_mode: str = "discovery"

    # Point ID 시작 번호 (첫 신규 노드에 부여 후 1씩 증가)
    point_id_start: int = 1

    # 닫힌 폴리선에서 첫/끝 꼭짓점이 tolerance 이내면 끝점 제거
    skip_closing_duplicate: bool = True

    # Region 내 연속 중복 꼭짓점/Point ID 제거 (GeoStudio "Duplicate points assigned to region" 방지)
    remove_consecutive_duplicate_points: bool = True

    # 처리 대상
    layer_filter: str | None = None          # 예: "@re" — None이면 전체
    entity_types: tuple[str, ...] = ("LWPOLYLINE",)
    require_closed: bool = True              # GeoStudio Region = 닫힌 Domain Polygon

    # Excel 시트명 (GeoStudio import 관례)
    points_sheet_name: str = "Points"
    regions_sheet_name: str = "Regions"

    # DXF 라벨 출력
    annotate_dxf: bool = True
    point_label_layer: str = "GS_POINT_ID"
    region_label_layer: str = "GS_REGION_ID"
    # None이면 도면 크기에 따라 자동 계산
    label_text_height: float | None = None


DEFAULT_CONFIG = GeoStudioConfig()


@dataclass
class PointRecord:
    point_id: int
    x: float
    y: float


@dataclass
class RegionRecord:
    region_id: int
    point_ids: list[int]


@dataclass
class ConversionResult:
    points: list[PointRecord]
    regions: list[RegionRecord]
    config: GeoStudioConfig
    source_path: Path
    warnings: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# 좌표 / Point ID
# ---------------------------------------------------------------------------
def _dedupe_consecutive_vertices(
    vertices: Sequence[tuple[float, float]],
    tolerance: float,
) -> tuple[list[tuple[float, float]], int]:
    """연속으로 같은 좌표(tolerance 이내)인 꼭짓점을 제거."""
    if not vertices:
        return [], 0

    result = [vertices[0]]
    removed = 0
    for x, y in vertices[1:]:
        px, py = result[-1]
        if hypot(x - px, y - py) <= tolerance:
            removed += 1
        else:
            result.append((x, y))
    return result, removed


def _dedupe_consecutive_point_ids(point_ids: Sequence[int]) -> tuple[list[int], int]:
    """Region Points 목록에서 연속으로 반복된 Point ID를 제거."""
    if not point_ids:
        return [], 0

    result = [point_ids[0]]
    removed = 0
    for pid in point_ids[1:]:
        if pid == result[-1]:
            removed += 1
        else:
            result.append(pid)
    return result, removed


def _normalize_vertices(
    vertices: Sequence[tuple[float, float]],
    tolerance: float,
    skip_closing_duplicate: bool,
    remove_consecutive_duplicate_points: bool = True,
) -> tuple[list[tuple[float, float]], int]:
    """폴리선 꼭짓점 정규화. 반환: (정규화된 꼭짓점, 제거된 중복 수)."""
    if len(vertices) < 3:
        return list(vertices), 0

    verts = list(vertices)
    removed = 0

    if remove_consecutive_duplicate_points:
        verts, n = _dedupe_consecutive_vertices(verts, tolerance)
        removed += n

    if skip_closing_duplicate and len(verts) >= 2:
        x0, y0 = verts[0]
        x1, y1 = verts[-1]
        if hypot(x0 - x1, y0 - y1) <= tolerance:
            verts = verts[:-1]
            removed += 1

    return verts, removed


def _find_point_index(
    x: float,
    y: float,
    coords: list[tuple[float, float]],
    tolerance: float,
) -> int | None:
    for idx, (cx, cy) in enumerate(coords):
        if hypot(x - cx, y - cy) <= tolerance:
            return idx
    return None


def _round_coord(value: float, decimals: int) -> float:
    return round(value, decimals)


class PointRegistry:
    """좌표 → Point ID 매핑 (GeoStudio tolerance 규칙)."""

    def __init__(self, config: GeoStudioConfig) -> None:
        self.config = config
        self._coords: list[tuple[float, float]] = []
        self._ids: list[int] = []
        self._next_id = config.point_id_start
        self._pending: list[tuple[float, float]] = []

    def register(self, x: float, y: float) -> int:
        tol = self.config.coordinate_tolerance
        dec = self.config.coordinate_decimals
        xr = _round_coord(x, dec)
        yr = _round_coord(y, dec)

        idx = _find_point_index(xr, yr, self._coords, tol)
        if idx is not None:
            return self._ids[idx]

        if self.config.point_id_mode == "discovery":
            point_id = self._next_id
            self._next_id += 1
            self._coords.append((xr, yr))
            self._ids.append(point_id)
            return point_id

        self._pending.append((xr, yr))
        return -1  # sort 모드에서는 나중에 확정

    def finalize_sorted(self) -> None:
        if self.config.point_id_mode not in {"sort_yx", "sort_xy"}:
            return
        if not self._pending:
            return

        unique: dict[tuple[float, float], None] = {}
        for x, y in self._pending:
            idx = _find_point_index(x, y, list(unique.keys()), self.config.coordinate_tolerance)
            if idx is None:
                unique[(x, y)] = None

        items = list(unique.keys())
        if self.config.point_id_mode == "sort_yx":
            items.sort(key=lambda p: (p[1], p[0]))
        else:
            items.sort(key=lambda p: (p[0], p[1]))

        start = self.config.point_id_start
        self._coords = items
        self._ids = list(range(start, start + len(items)))
        self._next_id = start + len(items)

    def lookup(self, x: float, y: float) -> int:
        tol = self.config.coordinate_tolerance
        dec = self.config.coordinate_decimals
        xr = _round_coord(x, dec)
        yr = _round_coord(y, dec)
        idx = _find_point_index(xr, yr, self._coords, tol)
        if idx is None:
            raise KeyError(f"등록되지 않은 좌표: ({xr}, {yr})")
        return self._ids[idx]

    def all_points(self) -> list[PointRecord]:
        return [
            PointRecord(point_id=pid, x=x, y=y)
            for (x, y), pid in sorted(zip(self._coords, self._ids), key=lambda t: t[1])
        ]


def _finalize_region_point_ids(
    point_ids: list[int],
    config: GeoStudioConfig,
) -> tuple[list[int], int]:
    """Region Point ID 목록 최종 정리 (GeoStudio import 규칙)."""
    if not config.remove_consecutive_duplicate_points:
        return point_ids, 0

    ids, removed = _dedupe_consecutive_point_ids(point_ids)

    # ID 기준으로도 첫/끝이 같으면 제거 (좌표 dedupe 후에도 남는 경우)
    if len(ids) >= 2 and ids[0] == ids[-1]:
        ids = ids[:-1]
        removed += 1

    return ids, removed


# ---------------------------------------------------------------------------
# DXF 읽기
# ---------------------------------------------------------------------------
def _iter_polylines(doc: Drawing, config: GeoStudioConfig) -> list[LWPolyline]:
    msp = doc.modelspace()
    result: list[LWPolyline] = []

    for entity in msp:
        if entity.dxftype() not in config.entity_types:
            continue
        if config.layer_filter and entity.dxf.layer != config.layer_filter:
            continue
        if config.require_closed and not entity.closed:
            continue
        if entity.dxftype() == "LWPOLYLINE":
            result.append(entity)

    return result


def convert_dxf(path: Path, config: GeoStudioConfig = DEFAULT_CONFIG) -> ConversionResult:
    warnings: list[str] = []
    doc = ezdxf.readfile(str(path))
    polylines = _iter_polylines(doc, config)

    if not polylines:
        raise ValueError(
            "처리할 닫힌 LWPOLYLINE이 없습니다. "
            f"layer_filter={config.layer_filter!r}, require_closed={config.require_closed}"
        )

    registry = PointRegistry(config)
    region_point_ids: list[list[int]] = []

    if config.point_id_mode == "discovery":
        for poly in polylines:
            raw = [(float(x), float(y)) for x, y in poly.get_points("xy")]
            verts, n_removed = _normalize_vertices(
                raw,
                config.coordinate_tolerance,
                config.skip_closing_duplicate,
                config.remove_consecutive_duplicate_points,
            )
            if n_removed and config.remove_consecutive_duplicate_points:
                warnings.append(
                    f"Region {len(region_point_ids) + 1}: "
                    f"연속 중복 꼭짓점 {n_removed}개 제거 (handle={poly.dxf.handle})"
                )
            if len(verts) < 3:
                warnings.append(
                    f"폴리선(handle={poly.dxf.handle}): 꼭짓점 {len(verts)}개 — Region으로 부적합"
                )
                continue
            ids = [registry.register(x, y) for x, y in verts]
            ids, id_removed = _finalize_region_point_ids(ids, config)
            if id_removed:
                warnings.append(
                    f"Region {len(region_point_ids) + 1}: "
                    f"연속 중복 Point ID {id_removed}개 제거"
                )
            region_point_ids.append(ids)
    else:
        # sort 모드: 먼저 모든 좌표 수집 후 ID 부여
        all_polys_verts: list[list[tuple[float, float]]] = []
        for poly in polylines:
            raw = [(float(x), float(y)) for x, y in poly.get_points("xy")]
            verts, n_removed = _normalize_vertices(
                raw,
                config.coordinate_tolerance,
                config.skip_closing_duplicate,
                config.remove_consecutive_duplicate_points,
            )
            if n_removed and config.remove_consecutive_duplicate_points:
                warnings.append(
                    f"Region {len(all_polys_verts) + 1}: "
                    f"연속 중복 꼭짓점 {n_removed}개 제거 (handle={poly.dxf.handle})"
                )
            if len(verts) < 3:
                warnings.append(
                    f"폴리선(handle={poly.dxf.handle}): 꼭짓점 {len(verts)}개 — Region으로 부적합"
                )
                continue
            all_polys_verts.append(verts)
            for x, y in verts:
                registry.register(x, y)
        registry.finalize_sorted()
        for verts in all_polys_verts:
            ids = [registry.lookup(x, y) for x, y in verts]
            ids, id_removed = _finalize_region_point_ids(ids, config)
            if id_removed:
                warnings.append(
                    f"Region {len(region_point_ids) + 1}: "
                    f"연속 중복 Point ID {id_removed}개 제거"
                )
            region_point_ids.append(ids)

    points = registry.all_points()
    regions = [
        RegionRecord(region_id=i + 1, point_ids=pids)
        for i, pids in enumerate(region_point_ids)
    ]

    return ConversionResult(
        points=points,
        regions=regions,
        config=config,
        source_path=path,
        warnings=warnings,
    )


# ---------------------------------------------------------------------------
# Excel / CSV 출력
# ---------------------------------------------------------------------------
def _format_coord(value: float, decimals: int) -> float:
    return round(value, decimals)


def result_to_dataframes(result: ConversionResult) -> tuple[pd.DataFrame, pd.DataFrame]:
    cfg = result.config
    dec = cfg.coordinate_decimals

    points_df = pd.DataFrame(
        {
            "ID": [p.point_id for p in result.points],
            "X (m)": [_format_coord(p.x, dec) for p in result.points],
            "Y (m)": [_format_coord(p.y, dec) for p in result.points],
            "Label": cfg.point_label,
            "Pinned": cfg.point_pinned,
        }
    )

    regions_df = pd.DataFrame(
        {
            "Region": [r.region_id for r in result.regions],
            "Points": [",".join(str(pid) for pid in r.point_ids) for r in result.regions],
            "Type": cfg.region_type,
        }
    )

    return points_df, regions_df


def export_excel(result: ConversionResult, output_path: Path) -> Path:
    points_df, regions_df = result_to_dataframes(result)
    output_path = output_path.with_suffix(".xlsx")

    with pd.ExcelWriter(output_path, engine="openpyxl") as writer:
        points_df.to_excel(writer, sheet_name=result.config.points_sheet_name, index=False)
        regions_df.to_excel(writer, sheet_name=result.config.regions_sheet_name, index=False)

    return output_path


def export_csv(result: ConversionResult, output_dir: Path) -> tuple[Path, Path]:
    points_df, regions_df = result_to_dataframes(result)
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = result.source_path.stem

    points_path = output_dir / f"{stem}_points.csv"
    regions_path = output_dir / f"{stem}_regions.csv"
    points_df.to_csv(points_path, index=False, encoding="utf-8-sig")
    regions_df.to_csv(regions_path, index=False, encoding="utf-8-sig")
    return points_path, regions_path


# ---------------------------------------------------------------------------
# DXF 라벨 출력 (Point / Region 번호)
# ---------------------------------------------------------------------------
def _compute_label_text_height(
    points: Sequence[PointRecord],
    configured_height: float | None,
    ratio: float = 0.02,
    min_height: float = 0.1,
) -> float:
    if configured_height is not None:
        return configured_height
    if not points:
        return 1.0

    xs = [p.x for p in points]
    ys = [p.y for p in points]
    span = max(max(xs) - min(xs), max(ys) - min(ys))
    if span <= 0:
        return min_height
    return max(min_height, span * ratio)


def _region_centroid(
    point_ids: Sequence[int],
    points_by_id: dict[int, PointRecord],
) -> tuple[float, float]:
    coords = [points_by_id[pid] for pid in point_ids]
    cx = sum(p.x for p in coords) / len(coords)
    cy = sum(p.y for p in coords) / len(coords)
    return cx, cy


def export_annotated_dxf(
    result: ConversionResult,
    output_path: Path | None = None,
) -> Path:
    """원본 DXF에 Point/Region 번호 TEXT를 추가해 저장."""
    cfg = result.config
    doc = ezdxf.readfile(str(result.source_path))
    msp = doc.modelspace()

    for layer_name in (cfg.point_label_layer, cfg.region_label_layer):
        if layer_name not in doc.layers:
            doc.layers.add(layer_name)

    text_height = _compute_label_text_height(result.points, cfg.label_text_height)
    offset = text_height * 0.35
    points_by_id = {p.point_id: p for p in result.points}

    for point in result.points:
        text = msp.add_text(
            str(point.point_id),
            dxfattribs={
                "layer": cfg.point_label_layer,
                "height": text_height,
                "color": 1,
            },
        )
        text.set_placement(
            (point.x + offset, point.y + offset),
            align=TextEntityAlignment.MIDDLE_CENTER,
        )

    for region in result.regions:
        cx, cy = _region_centroid(region.point_ids, points_by_id)
        text = msp.add_text(
            f"R{region.region_id}",
            dxfattribs={
                "layer": cfg.region_label_layer,
                "height": text_height * 1.2,
                "color": 3,
            },
        )
        text.set_placement((cx, cy), align=TextEntityAlignment.MIDDLE_CENTER)

    if output_path is None:
        output_path = result.source_path.with_name(f"{result.source_path.stem}_labeled.dxf")
    else:
        output_path = output_path.with_suffix(".dxf")

    doc.saveas(str(output_path))
    return output_path


# ---------------------------------------------------------------------------
# GeoStudio XML 참조 검증 (선택)
# ---------------------------------------------------------------------------
def validate_against_geostudio_xml(
    result: ConversionResult,
    xml_path: Path,
) -> dict[str, object]:
    import xml.etree.ElementTree as ET

    root = ET.parse(xml_path).getroot()
    gs_points = {
        int(p.get("ID")): (float(p.get("X")), float(p.get("Y")))
        for p in root.iter("Point")
    }
    gs_regions = {
        int(r.find("ID").text): [int(x) for x in r.find("PointIDs").text.split(",")]
        for r in root.iter("Region")
    }

    tol = result.config.coordinate_tolerance
    matched = 0
    for pid, (gx, gy) in gs_points.items():
        for p in result.points:
            if hypot(p.x - gx, p.y - gy) <= tol:
                matched += 1
                break

    return {
        "gs_point_count": len(gs_points),
        "gs_region_count": len(gs_regions),
        "output_point_count": len(result.points),
        "output_region_count": len(result.regions),
        "gs_points_matched_in_output": matched,
        "gs_points_match_ratio": matched / len(gs_points) if gs_points else 0.0,
    }


# ---------------------------------------------------------------------------
# CLI / GUI
# ---------------------------------------------------------------------------
def _print_summary(result: ConversionResult) -> None:
    cfg = result.config
    print(f"\n{'=' * 60}")
    print(f"입력: {result.source_path}")
    print(f"Points: {len(result.points)}개  |  Regions: {len(result.regions)}개")
    print(f"허용오차: {cfg.coordinate_tolerance} m  |  소수점: {cfg.coordinate_decimals}")
    print(
        f"Point ID 모드: {cfg.point_id_mode}  |  시작 ID: {cfg.point_id_start}"
        f"  |  레이어: {cfg.layer_filter or '(전체)'}"
    )
    print(
        f"연속 중복 제거: {'ON' if cfg.remove_consecutive_duplicate_points else 'OFF'}"
    )
    if result.warnings:
        print(f"\n경고 ({len(result.warnings)}건):")
        for w in result.warnings[:10]:
            print(f"  - {w}")
        if len(result.warnings) > 10:
            print(f"  ... 외 {len(result.warnings) - 10}건")
    print(f"{'=' * 60}\n")


def pick_file(title: str, filetypes: list[tuple[str, str]]) -> Path | None:
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    path = filedialog.askopenfilename(title=title, filetypes=filetypes)
    root.destroy()
    return Path(path) if path else None


def ask_point_id_start(default_start: int = 1) -> int | None:
    import tkinter as tk
    from tkinter import simpledialog

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    value = simpledialog.askinteger(
        "Point ID 시작 번호",
        "노드(Point) ID 시작 번호를 입력하세요:",
        initialvalue=default_start,
        minvalue=1,
        parent=root,
    )
    root.destroy()
    return value


def pick_save_file(title: str, default_name: str) -> Path | None:
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    path = filedialog.asksaveasfilename(
        title=title,
        defaultextension=".xlsx",
        initialfile=default_name,
        filetypes=[("Excel", "*.xlsx"), ("All files", "*.*")],
    )
    root.destroy()
    return Path(path) if path else None


def run_gui(config: GeoStudioConfig) -> int:
    dxf_path = pick_file("GeoStudio 변환 — DXF 파일 선택", [("DXF", "*.dxf"), ("All", "*.*")])
    if not dxf_path:
        print("취소됨.")
        return 1

    point_id_start = ask_point_id_start(config.point_id_start)
    if point_id_start is None:
        print("취소됨.")
        return 1

    config = replace(config, point_id_start=point_id_start)
    result = convert_dxf(dxf_path, config)
    _print_summary(result)

    out_path = pick_save_file("Excel 저장", f"{dxf_path.stem}_geostudio.xlsx")
    if not out_path:
        print("저장 취소됨.")
        return 1

    saved = export_excel(result, out_path)
    print(f"Excel 저장: {saved}")

    if config.annotate_dxf:
        dxf_out = export_annotated_dxf(result)
        print(f"DXF 라벨 저장: {dxf_out}")

    return 0


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="DXF 닫힌 폴리선 → GeoStudio Slope/W Points/Regions Excel 변환"
    )
    p.add_argument("dxf", nargs="?", help="입력 DXF 경로 (생략 시 GUI)")
    p.add_argument("-o", "--output", help="출력 Excel 경로 (.xlsx)")
    p.add_argument("--csv", action="store_true", help="CSV도 함께 출력")
    p.add_argument("--gui", action="store_true", help="파일 선택 GUI 강제 실행")
    p.add_argument("--layer", default=None, help="레이어 필터 (예: @re)")
    p.add_argument(
        "--tolerance",
        type=float,
        default=DEFAULT_CONFIG.coordinate_tolerance,
        help=f"좌표 중복 허용오차 [m] (기본: {DEFAULT_CONFIG.coordinate_tolerance})",
    )
    p.add_argument(
        "--decimals",
        type=int,
        default=DEFAULT_CONFIG.coordinate_decimals,
        help=f"좌표 소수 자릿수 (기본: {DEFAULT_CONFIG.coordinate_decimals})",
    )
    p.add_argument(
        "--point-id-mode",
        choices=["discovery", "sort_yx", "sort_xy"],
        default=DEFAULT_CONFIG.point_id_mode,
        help="Point ID 부여 순서",
    )
    p.add_argument(
        "--point-id-start",
        type=int,
        default=DEFAULT_CONFIG.point_id_start,
        help=f"Point ID 시작 번호 (기본: {DEFAULT_CONFIG.point_id_start})",
    )
    p.add_argument(
        "--allow-open",
        action="store_true",
        help="열린 폴리선도 포함 (기본: 닫힌 것만)",
    )
    p.add_argument(
        "--keep-duplicate-points",
        action="store_true",
        help="Region 내 연속 중복 꼭짓점/Point ID 유지 (기본: 제거)",
    )
    p.add_argument(
        "--validate-xml",
        help="GeoStudio XML 참조 파일 (검증용, 예: 온산항 3구간.xml)",
    )
    p.add_argument(
        "--no-annotate-dxf",
        action="store_true",
        help="DXF에 Point/Region 번호 라벨 추가 안 함 (기본: 추가)",
    )
    return p


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    if args.point_id_start < 1:
        parser.error("--point-id-start는 1 이상이어야 합니다.")

    config = replace(
        DEFAULT_CONFIG,
        layer_filter=args.layer,
        coordinate_tolerance=args.tolerance,
        coordinate_decimals=args.decimals,
        point_id_mode=args.point_id_mode,
        point_id_start=args.point_id_start,
        require_closed=not args.allow_open,
        remove_consecutive_duplicate_points=not args.keep_duplicate_points,
        annotate_dxf=not args.no_annotate_dxf,
    )

    if args.gui or not args.dxf:
        return run_gui(config)

    dxf_path = Path(args.dxf)
    if not dxf_path.is_file():
        print(f"파일 없음: {dxf_path}", file=sys.stderr)
        return 1

    result = convert_dxf(dxf_path, config)
    _print_summary(result)

    if args.validate_xml:
        stats = validate_against_geostudio_xml(result, Path(args.validate_xml))
        print("GeoStudio XML 검증:")
        for k, v in stats.items():
            print(f"  {k}: {v}")

    if args.output:
        out = export_excel(result, Path(args.output))
        print(f"Excel 저장: {out}")
    elif not args.csv:
        out = export_excel(result, dxf_path.with_name(f"{dxf_path.stem}_geostudio.xlsx"))
        print(f"Excel 저장: {out}")

    if args.csv:
        csv_dir = Path(args.output).parent if args.output else dxf_path.parent
        p_path, r_path = export_csv(result, csv_dir)
        print(f"CSV 저장: {p_path}")
        print(f"CSV 저장: {r_path}")

    if config.annotate_dxf:
        dxf_out = export_annotated_dxf(result)
        print(f"DXF 라벨 저장: {dxf_out}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
