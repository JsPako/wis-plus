"""Task 2.2 — _clean_variants: keep recognised tags, flag unknowns, never ALL.

Contract (docs/review-log.md row 2.2):
  * recognised tags are kept (canonical ids, sourced from shared/variants.json);
  * unrecognised tags are flagged as ``unknown_variant:<tag>`` and dropped;
  * an empty result is stored as ``[]`` plus a ``variant_unspecified`` flag;
  * the wildcard ``ALL`` is never stored — absence means "not specified"."""
from forge.vlm_enricher import _clean_variants

ENGINES = frozenset({"M102_1.8", "M102_2.0", "M103_2.6"})


def test_recognised_tags_are_kept():
    tags, flags = _clean_variants(["M102_1.8", "M103_2.6"], ENGINES)
    assert tags == ["M102_1.8", "M103_2.6"]
    assert not any("unknown_variant" in f for f in flags)


def test_unknown_tag_is_flagged_and_dropped():
    tags, flags = _clean_variants(["M102_1.8", "W124_3.0"], ENGINES)
    assert tags == ["M102_1.8"]
    assert "unknown_variant:W124_3.0" in flags


def test_empty_result_stores_empty_list_plus_unspecified_flag():
    tags, flags = _clean_variants([], ENGINES)
    assert tags == []
    assert "variant_unspecified" in flags


def test_all_is_never_stored():
    # The VLM may still emit the legacy 'ALL' wildcard; it must be dropped,
    # leaving an empty list + variant_unspecified (never widened to all).
    tags, flags = _clean_variants(["ALL"], ENGINES)
    assert "ALL" not in tags
    assert tags == []
    assert "variant_unspecified" in flags
