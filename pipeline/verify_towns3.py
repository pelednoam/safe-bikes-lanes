"""Verify the THIRD-ring towns route on the freshly built graph.
Run from pipeline/ after the build: python verify_towns3.py"""
import math
import pickle
import sys

import config
import networkx as nx

with open(config.DATA_DIR / "graph.pkl", "rb") as f:
    G: nx.MultiDiGraph = pickle.load(f)

xs = {n: (nd["x"], nd["y"]) for n, nd in G.nodes(data=True)}


def snap(lon: float, lat: float) -> tuple[int, float]:
    sx = math.cos(math.radians(lat)) * 111_320
    best, bestd = -1, 1e18
    for n, (x, y) in xs.items():
        dx, dy = (x - lon) * sx, (y - lat) * 110_540
        d2 = dx * dx + dy * dy
        if d2 < bestd:
            bestd, best = d2, n
    return best, math.sqrt(bestd)


HUB = (-71.092, 42.362)  # Kendall Sq, Cambridge
hub_node, _ = snap(*HUB)

TOWNS = {
    "Framingham": ((-71.416, 42.279), (-71.408, 42.285)),
    "Ashland": ((-71.463, 42.261), (-71.455, 42.267)),
    "Holliston": ((-71.424, 42.200), (-71.416, 42.206)),
    "Medfield": ((-71.306, 42.187), (-71.298, 42.193)),
    "Millis": ((-71.357, 42.167), (-71.349, 42.173)),
    "Medway": ((-71.396, 42.141), (-71.388, 42.147)),
    "Norfolk": ((-71.325, 42.119), (-71.317, 42.125)),
    "Walpole": ((-71.249, 42.142), (-71.241, 42.148)),
    "Sharon": ((-71.179, 42.124), (-71.171, 42.130)),
    "Stoughton": ((-71.102, 42.125), (-71.094, 42.131)),
    "Wayland": ((-71.361, 42.362), (-71.353, 42.368)),
    "Sudbury": ((-71.416, 42.383), (-71.408, 42.389)),
    "Concord": ((-71.349, 42.460), (-71.341, 42.454)),
    "Carlisle": ((-71.351, 42.531), (-71.343, 42.525)),
    "Billerica": ((-71.269, 42.558), (-71.261, 42.552)),
    "Wilmington": ((-71.173, 42.546), (-71.165, 42.540)),
    "North Reading": ((-71.079, 42.575), (-71.071, 42.569)),
    "Middleton": ((-71.016, 42.595), (-71.024, 42.589)),
    "Peabody": ((-70.929, 42.528), (-70.937, 42.522)),
    "Salem": ((-70.898, 42.519), (-70.906, 42.513)),
    "Marblehead": ((-70.857, 42.500), (-70.865, 42.494)),
    "Danvers": ((-70.930, 42.575), (-70.938, 42.569)),
    "Beverly": ((-70.880, 42.558), (-70.888, 42.552)),
    "Hingham": ((-70.890, 42.242), (-70.898, 42.248)),
    "Cohasset": ((-70.803, 42.242), (-70.811, 42.248)),
    "Hull": ((-70.908, 42.302), (-70.900, 42.296)),
    "Rockland": ((-70.916, 42.131), (-70.908, 42.137)),
    "Abington": ((-70.945, 42.105), (-70.953, 42.111)),
    "Whitman": ((-70.936, 42.081), (-70.944, 42.087)),
    "Brockton": ((-71.018, 42.084), (-71.026, 42.090)),
}

ok = 0
print(f"{'town':<15} snap_m  ->hub          local-trip")
for town, (a, b) in TOWNS.items():
    na, da = snap(*a)
    nb, db = snap(*b)
    row = f"{town:<15} {da:5.0f}  "
    good = da <= 500
    try:
        dist = nx.shortest_path_length(G, na, hub_node, weight="length")
        row += f"OK {dist/1000:5.1f} km   "
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        row += "NO PATH        "
        good = False
    try:
        ld = nx.shortest_path_length(G, na, nb, weight="length")
        row += f"OK {ld:5.0f} m"
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        row += "NO PATH"
        good = False
    if da > 500:
        row += f"  (SNAP {da:.0f}m > 500m!)"
    ok += good
    print(row)

print(f"\n{ok}/{len(TOWNS)} towns fully routable")
sys.exit(0 if ok == len(TOWNS) else 1)
