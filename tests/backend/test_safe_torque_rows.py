"""Task 2.5 — one malformed torque row must not sink the whole page.

``_safe_torque_rows`` validates each row independently: good rows survive, bad
rows (e.g. a degenerate bbox) are skipped and logged."""
from backend.main import _safe_torque_rows


class _FakeEng:
    def __init__(self, rows):
        self._rows = rows

    def get_torque_specs(self, procedure_id):  # noqa: ARG002 - mirror of real API
        return self._rows


def _row(id_, x0, y0, x1, y1):
    return {
        "id": id_,
        "procedure_id": 1,
        "page_id": 7,
        "step_mode": "general",
        "component_name": f"bolt-{id_}",
        "value_nm": 45.0,
        "value_ftlb": None,
        "raw_text": "Tighten to 45 Nm",
        "bbox_x0": x0, "bbox_y0": y0, "bbox_x1": x1, "bbox_y1": y1,
        "bbox_exact": True,
        "angle_deg": None,
    }


def test_good_rows_pass_through():
    rows = [_row(1, 0.1, 0.2, 0.3, 0.4), _row(2, 0.5, 0.6, 0.7, 0.8)]
    out = _safe_torque_rows(_FakeEng(rows), 1)
    assert len(out) == 2


def test_degenerate_bbox_row_is_skipped_not_fatal():
    good = _row(1, 0.1, 0.2, 0.3, 0.4)
    bad = _row(2, 0.9, 0.1, 0.5, 0.4)   # x1 < x0: violates bbox ordering
    out = _safe_torque_rows(_FakeEng([good, bad]), 1)
    assert len(out) == 1
    assert out[0]["id"] == 1
