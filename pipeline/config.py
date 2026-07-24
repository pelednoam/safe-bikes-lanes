"""Central configuration: area of interest, data endpoints, and the safety cost model.

All tuning knobs for "how safe is safe enough" live here. Multipliers scale edge
length, so a multiplier of 15 means "riding 100m here feels as bad as 1.5km on a
protected path" — the router will detour up to that ratio to avoid it.
"""

from pathlib import Path
from typing import Final

DATA_DIR: Final[Path] = Path(__file__).resolve().parent.parent / "data"
RAW_DIR: Final[Path] = DATA_DIR / "raw"

# Cambridge + Somerville + inner-ring neighbors (Arlington, Medford, Everett,
# Belmont, Watertown) + Brookline + Newton + Boston (north of ~42.30). The
# neighbors ride the statewide stack; Boston adds its own facility-typed bike
# network below.
# Expanded July 2026 to a SECOND ring beyond the inner suburbs: W adds
# Natick/Weston/Lincoln/Dover, N adds Woburn/Burlington/Reading/Wakefield,
# NE adds Saugus/Lynn/Nahant/Swampscott, S adds Norwood/Canton/Randolph/
# Braintree/Weymouth. (First ring was W-71.32/S42.20/E-70.93/N42.51.)
BBOX_WEST: Final[float] = -71.45
BBOX_SOUTH: Final[float] = 42.10
BBOX_EAST: Final[float] = -70.88
BBOX_NORTH: Final[float] = 42.57

# Routing-graph tiling: the browser loads only the tiles covering a route's
# corridor instead of the whole graph, so coverage can grow toward all of MA
# without an unbounded download. The origin is a FIXED point SW of MA so tile
# keys stay stable as the bbox widens — expanding coverage only adds tiles, it
# never renumbers existing ones. ~0.02° ≈ 2.2 km lat / 1.6 km lon at 42°N.
TILE_ORIGIN_LON: Final[float] = -73.6
TILE_ORIGIN_LAT: Final[float] = 41.1
TILE_DEG: Final[float] = 0.02

CAMBRIDGE_FACILITIES_URL: Final[str] = (
    "https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/"
    "Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson"
)
# ArcGIS REST endpoint (reliable; the data.boston.gov CKAN/S3 download 403s
# non-browser clients). Same facility-typed layer, ExisFacil field.
BOSTON_FACILITIES_URL: Final[str] = (
    "https://services.arcgis.com/sFnw0xNflSi8J0uh/arcgis/rest/services/"
    "Boston_Bicycle_Network_2024/FeatureServer/0"
)

# ArcGIS REST endpoints (all verified live 2026-07-20).
MASSDOT_BIKE_INVENTORY: Final[str] = (
    "https://gis.massdot.state.ma.us/arcgis/rest/services/Multimodal/BikeInventory/FeatureServer/0"
)
MASSDOT_LTS: Final[str] = (
    "https://gis.massdot.state.ma.us/arcgis/rest/services/Multimodal/"
    "Bike_Level_of_Traffic_Stress/FeatureServer/0"
)
# IMPACT crash records, one FeatureServer per year. Filter to our two cities and
# crashes involving a bicyclist (NON_MTRST_TYPE_CL). ~160-180 rows/year.
IMPACT_CRASH_YEARS: Final[list[int]] = [2021, 2022, 2023, 2024, 2025, 2026]
IMPACT_CRASH_URL: Final[str] = (
    "https://gis.crashdata.dot.mass.gov/arcgis/rest/services/MassDOT/"
    "MASSDOT_ODP_OPEN_{year}/FeatureServer/0"
)
# Some years deviate from the pattern (2023 service is named "...2023v").
IMPACT_CRASH_SERVICE_YEAR: Final[dict[int, str]] = {2023: "2023v"}
IMPACT_CRASH_CITIES: Final[tuple[str, ...]] = (
    "CAMBRIDGE", "SOMERVILLE", "ARLINGTON", "MEDFORD", "EVERETT", "BELMONT",
    "WATERTOWN", "BOSTON", "BROOKLINE", "NEWTON",
    # first ring (July 2026)
    "WALTHAM", "LEXINGTON", "WINCHESTER", "STONEHAM", "MELROSE", "MALDEN",
    "CHELSEA", "REVERE", "WINTHROP", "MILTON", "QUINCY", "DEDHAM",
    "NEEDHAM", "WELLESLEY",
    # second ring (July 2026)
    "BEDFORD", "BURLINGTON", "WOBURN", "READING", "WAKEFIELD", "LYNNFIELD",
    "SAUGUS", "LYNN", "NAHANT", "SWAMPSCOTT", "WESTON", "LINCOLN", "NATICK",
    "DOVER", "SHERBORN", "WESTWOOD", "NORWOOD", "CANTON", "RANDOLPH",
    "BRAINTREE", "WEYMOUTH", "HOLBROOK",
)
IMPACT_CRASH_WHERE: Final[str] = (
    "CITY_TOWN_NAME IN ("
    + ",".join(f"'{c}'" for c in IMPACT_CRASH_CITIES)
    + ") AND NON_MTRST_TYPE_CL LIKE '%Bicycl%'"
)
SOMERVILLE_MOBILITY3: Final[str] = (
    "https://maps.somervillema.gov/arcgis/rest/services/Mobility3/MapServer"
)
SOMERVILLE_HIGH_CRASH_LAYERS: Final[dict[str, int]] = {"intersections": 7, "corridors": 13}

# Construction sources (verified 2026-07-21).
# Cambridge street/excavation permits (Socrata; geocoded, status + start/end).
CAMBRIDGE_PERMITS_URL: Final[str] = "https://data.cambridgema.gov/resource/nuxx-d95m.json"
# MassDOT Connected Work Zones (WZDx). Requires a free API key from the
# MassDOT Work Zones portal — set MASSDOT_WZDX_API_KEY; skipped when unset.
WZDX_FEED_URL: Final[str] = "https://api.massdot-swzm.com/api/v1/cwz/work-zone-feed"
WZDX_KEY_ENV: Final[str] = "MASSDOT_WZDX_API_KEY"

# ---------------------------------------------------------------------------
# Safety cost model — kids-on-their-own-bikes defaults.
# weight = length_m * class_multiplier * crash_factor + node_penalties
# ---------------------------------------------------------------------------

# Protection classes, best → worst. Every edge gets exactly one.
CLASS_MULTIPLIER: Final[dict[str, float]] = {
    "path": 1.0,            # off-street multi-use path / cycleway
    "separated": 1.0,       # physically separated on-street lane
    "buffered": 2.0,        # painted buffer, no physical protection
    "lane": 3.0,            # plain painted lane
    "quiet_street": 1.4,    # residential / living street / shared street, no facility
    "service": 2.0,         # alleys, parking aisles (fine but awkward)
    "sharrow": 6.0,         # shared-lane marking on a real road
    "moderate_street": 8.0, # tertiary etc., no facility
    "busy_street": 25.0,    # primary/secondary/trunk, no protection: near-ban
}

# On busy/moderate streets a painted lane only helps so much with kids —
# these override the base class when the underlying road is busy.
BUSY_ROAD_LANE_MULTIPLIER: Final[float] = 10.0      # painted lane on primary/secondary
BUSY_ROAD_BUFFERED_MULTIPLIER: Final[float] = 6.0   # buffered lane on primary/secondary

# Solo mode (riding without the kids): still safety-leaning, much milder.
SOLO_CLASS_MULTIPLIER: Final[dict[str, float]] = {
    "path": 1.0,
    "separated": 1.0,
    "buffered": 1.1,
    "lane": 1.3,
    "quiet_street": 1.1,
    "service": 1.3,
    "sharrow": 2.0,
    "moderate_street": 2.5,
    "busy_street": 6.0,
}
SOLO_BUSY_ROAD_LANE_MULTIPLIER: Final[float] = 2.5
SOLO_BUSY_ROAD_BUFFERED_MULTIPLIER: Final[float] = 1.8
SOLO_PENALTY_SCALE: Final[float] = 0.3  # crossing penalties scaled down when solo

# Crash overlay: factor = 1 + CRASH_WEIGHT * bike_crashes_per_100m (capped).
CRASH_WEIGHT: Final[float] = 0.6
CRASH_FACTOR_CAP: Final[float] = 2.5
CRASH_JOIN_RADIUS_M: Final[float] = 25.0   # crash point counts toward edges within this
SOMERVILLE_HIGH_CRASH_FACTOR: Final[float] = 1.5  # edges inside official high-crash corridors

# Node (crossing) penalties, in meters-equivalent added to incident edges.
UNSIGNALIZED_BUSY_CROSSING_PENALTY_M: Final[float] = 250.0
SIGNALIZED_BUSY_CROSSING_PENALTY_M: Final[float] = 30.0

# Spatial join of official facility lines onto OSM edges.
FACILITY_JOIN_RADIUS_M: Final[float] = 18.0   # max midpoint distance facility line → edge
FACILITY_JOIN_MAX_ANGLE_DEG: Final[float] = 30.0  # bearing gate (rejects cross streets)

# Cambridge FacilityType → protection class.
CAMBRIDGE_FACILITY_CLASS: Final[dict[str, str]] = {
    "Grade-Separated Bike Lane": "separated",
    "Separated Bike Lane": "separated",
    "Separated Bike Lane with Contra-flow": "separated",
    "Bike Path/Multi-Use Path": "path",
    "Buffered Bike Lane": "buffered",
    "Bike Lane": "lane",
    "Contra-flow": "lane",
    "Bus/Bike Lane": "lane",
    "Shared Street": "quiet_street",
    "Shared Lane Pavement Marking": "sharrow",
}

# Newton publishes its own facility-typed layer (Existing/Programmed/Planned;
# we keep only Existing). FacilityType -> protection class.
NEWTON_FACILITIES_URL: Final[str] = (
    "https://services2.arcgis.com/tzEm6xoZwL8UEMn8/arcgis/rest/services/"
    "BikeFacs_040823/FeatureServer/0"
)
NEWTON_FACILITY_CLASS: Final[dict[str, str]] = {
    "Bicycle Lane": "lane",
    "Separated Bicycle Lane": "separated",
    "Contraflow Bicycle Lane": "lane",
    "Bike Boulevard": "quiet_street",
    "Shared Use Path": "path",
}

# Everett's "Bike Facilities" inventory (FeatureServer layer 1). TYPE -> class.
EVERETT_FACILITIES_URL: Final[str] = (
    "https://services2.arcgis.com/xJ0MjVdyImL1ajyn/arcgis/rest/services/"
    "Everett_Bike_Facilities/FeatureServer/1"
)
EVERETT_FACILITY_CLASS: Final[dict[str, str]] = {
    "Cycle Track": "separated",
    "Raised Bike Lane": "separated",
    "Unprotected Bike Lane": "lane",
    "Bus-Bike Lane": "lane",
    "Trail": "path",
}

# Natick publishes its own existing bike-facility layer (its planned
# "Upcoming" service is deliberately not used). Fac_Type -> class.
NATICK_FACILITIES_URL: Final[str] = (
    "https://services5.arcgis.com/cgVgixFlRPcpfnJj/arcgis/rest/services/"
    "NEW_Bike_Facilities_3/FeatureServer/0"
)
NATICK_FACILITY_CLASS: Final[dict[str, str]] = {
    "Conventional Bike Lane": "lane",
    "Buffered Bike Lane": "buffered",
    "Separated Bike Lane": "separated",
}

# MAPC regional LandLine/AllTrails network — one source that enriches every
# town beyond the MassDOT inventory. Only the EXISTING (built) typed layers are
# used; planned/proposed and pedestrian-only footway layers are skipped so we
# never route bikes onto a facility that isn't there yet or isn't for bikes.
MAPC_ALLTRAILS_URL: Final[str] = (
    "https://geo.mapc.org/server/rest/services/Transportation/AllTrails/FeatureServer"
)
MAPC_ALLTRAILS_LAYERS: Final[dict[int, str]] = {
    0: "separated",  # Existing Protected Bike Lanes
    2: "lane",  # Existing Bike Lanes
    8: "path",  # Existing Paved Shared Use Paths
    11: "path",  # Existing Unimproved Shared Use Paths
}

# Boston 'ExisFacil' facility code -> protection class (data dictionary /
# standard MassDOT abbreviations). Unknown codes are skipped (edge keeps its
# OSM/MassDOT class). SBL=separated, BFBL=buffered, BL=bike lane,
# SLM=shared-lane markings (sharrow), SUP=shared-use path, CFBL=contraflow.
BOSTON_FACILITY_CLASS: Final[dict[str, str]] = {
    "SBL": "separated", "SBLBL": "separated", "SBLSL": "separated",
    "BFBL": "buffered", "BFBLSL": "buffered", "BLBFBL": "buffered",
    "BL": "lane", "BLSL": "lane", "CFBL": "lane", "BL-PEAKBUS": "lane",
    "SLM": "sharrow", "SLMTC": "sharrow", "SLMSUP": "sharrow",
    "SUP": "path", "SUPM": "path", "SUPN": "path",
}

# Display colors (also used by the frontend legend).
CLASS_COLOR: Final[dict[str, str]] = {
    "path": "#1a9850",
    "separated": "#66bd63",
    "buffered": "#a6d96a",
    "quiet_street": "#d9ef8b",
    "service": "#d9ef8b",
    "lane": "#fee08b",
    "sharrow": "#fdae61",
    "moderate_street": "#f46d43",
    "busy_street": "#d73027",
}
