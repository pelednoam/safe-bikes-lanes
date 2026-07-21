"""Generate the data-QA review page (web/data/review/index.html).

Merges the aerial audit (paint verification + 2023→2025 change flags) with the
Mapillary imagery worklist (when present) into one static page: each flagged
site shows its side-by-side aerial crops, class/source, marking ratios, and
links (Mapillary viewer + app). Confirmed findings become one-line entries in
data/overrides.geojson, which the router already respects.
"""

import html
import json
from typing import Any

import config

REVIEW_DIR = config.DATA_DIR.parent / "web" / "data" / "review"

VERDICT_LABEL = {
    "changed": "🔀 markings changed 2023 → 2025",
    "no_markings": "❓ painted facility, no visible markings",
}


def site_card(site: dict[str, Any]) -> str:
    lon, lat = site["lon"], site["lat"]
    name = html.escape(site.get("name") or "unnamed")
    crops = ""
    idx = site.get("crop_idx")
    if idx is not None:
        crops = (
            f'<div class="crops">'
            f'<figure><img src="crops/{idx}_2023.jpg" alt=""><figcaption>2023</figcaption></figure>'
            f'<figure><img src="crops/{idx}_2025.jpg" alt=""><figcaption>2025</figcaption></figure>'
            f"</div>"
        )
    ratios = (
        f"green {site.get('g2023')} → {site.get('g2025')} · "
        f"white {site.get('w2023')} → {site.get('w2025')}"
    )
    links = (
        f'<a href="https://www.mapillary.com/app/?lat={lat}&lng={lon}&z=17" '
        f'target="_blank" rel="noopener">street-level photos</a> · '
        f'<a href="https://pelednoam.github.io/safe-bikes-lanes/#s={lon},{lat}" '
        f'target="_blank" rel="noopener">open in app</a> · '
        f"{lat:.5f}, {lon:.5f}"
    )
    return (
        f'<div class="card"><b>{VERDICT_LABEL.get(site["verdict"], site["verdict"])}</b>'
        f"<div>{name} — <code>{site['cls']}</code> (source: {site['source']})</div>"
        f"{crops}<div class='ratios'>{ratios}</div><div class='links'>{links}</div></div>"
    )


def build() -> None:
    report_path = config.DATA_DIR / "aerial_report.json"
    if not report_path.exists():
        raise SystemExit("no aerial_report.json — run aerial_audit.py first")
    report = json.loads(report_path.read_text())
    flagged: list[dict[str, Any]] = report["flagged"]
    cards = "\n".join(site_card(s) for s in flagged)

    mapillary_note = ""
    mp = config.DATA_DIR / "mapillary_report.json"
    if mp.exists():
        entries = json.loads(mp.read_text())
        covered = sum(1 for e in entries if "captured_at" in e)
        mapillary_note = (
            f"<p>Mapillary audit: {covered}/{len(entries)} OSM-only facility sites "
            f"have street-level imagery (see <code>data/mapillary_report.json</code>).</p>"
        )

    counts = report["counts"]
    page = f"""<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lane data QA review</title>
<style>
 body {{ font-family: system-ui, sans-serif; max-width: 760px; margin: 24px auto;
        padding: 0 14px; font-size: 14px; color: #222; }}
 .card {{ border: 1px solid #ddd; border-radius: 10px; padding: 12px 14px; margin: 12px 0; }}
 .crops {{ display: flex; gap: 10px; margin: 8px 0; }}
 .crops figure {{ margin: 0; text-align: center; }}
 .crops img {{ width: 160px; height: 160px; border-radius: 6px; image-rendering: pixelated; }}
 .ratios {{ color: #666; font-size: 12px; }}
 .links {{ margin-top: 4px; font-size: 12px; }}
 code {{ background: #f4f4f4; padding: 1px 5px; border-radius: 4px; }}
</style>
<h1>🚲 Lane data QA — aerial review</h1>
<p>{report["audited"]} network sites audited against MassGIS 15 cm orthoimagery
(2023 vs 2025): {counts.get("ok", 0)} ok, {counts.get("changed", 0)} changed,
{counts.get("no_markings", 0)} without visible markings,
{counts.get("no_imagery", 0)} without imagery. {html.escape(report["coverage_note"])}</p>
<p>These are <b>heuristic flags for human review</b> — confirm with the linked
street-level photos, then record real changes in
<code>data/overrides.geojson</code> (class overrides feed the router directly).</p>
{mapillary_note}
{cards if cards else "<p>✅ nothing flagged.</p>"}
"""
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    (REVIEW_DIR / "index.html").write_text(page)
    print(f"wrote {REVIEW_DIR / 'index.html'} ({len(flagged)} flagged sites)")


if __name__ == "__main__":
    build()
