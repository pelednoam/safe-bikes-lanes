"""Export the routing graph to web/data/graph.json for in-browser routing.

Compact format (index-based, flat coordinate arrays):
  nodes:   [[lon, lat], ...]                     graph nodes
  names:   ["", "Main Street", ...]              deduped street names
  classes: ["path", ...]                         protection classes
  edges:   [[u, v, len_m, w_kids, w_solo, clsIdx, nameIdx, geomIdx], ...]
  geoms:   [[lon, lat, lon, lat, ...], ...]      flat coords, edge u->v order;
           geomIdx = -1 when the edge is a straight line between its nodes
Also copies network.geojson alongside it for the map display layer.
"""

import json
import pickle
import shutil
from typing import Any

import config
import networkx as nx

WEB_DATA = config.DATA_DIR.parent / "web" / "data"


def export() -> None:
    with open(config.DATA_DIR / "graph.pkl", "rb") as f:
        graph: nx.MultiDiGraph = pickle.load(f)

    node_index: dict[int, int] = {}
    nodes: list[list[float]] = []
    for n, nd in graph.nodes(data=True):
        node_index[n] = len(nodes)
        nodes.append([round(nd["x"], 6), round(nd["y"], 6)])

    name_index: dict[str, int] = {"": 0}
    names: list[str] = [""]
    classes: list[str] = sorted(config.CLASS_MULTIPLIER)
    cls_index = {c: i for i, c in enumerate(classes)}

    edges: list[list[float]] = []
    geoms: list[list[float]] = []
    for u, v, d in graph.edges(data=True):
        name = d.get("name")
        if isinstance(name, list):
            name = name[0]
        if not isinstance(name, str):
            name = ""
        if name not in name_index:
            name_index[name] = len(names)
            names.append(name)

        geom_idx = -1
        if "geometry" in d:
            coords = list(d["geometry"].coords)
            if len(coords) > 2:
                ux, uy = graph.nodes[u]["x"], graph.nodes[u]["y"]
                # geometry keeps original way direction; flip to u->v order
                if abs(coords[-1][0] - ux) + abs(coords[-1][1] - uy) < abs(
                    coords[0][0] - ux
                ) + abs(coords[0][1] - uy):
                    coords.reverse()
                flat: list[float] = []
                for x, y in coords:
                    flat.extend((round(x, 6), round(y, 6)))
                geom_idx = len(geoms)
                geoms.append(flat)

        edges.append(
            [
                node_index[u],
                node_index[v],
                round(float(d["length"]), 1),
                round(float(d["weight"]), 1),
                round(float(d["weight_solo"]), 1),
                cls_index[d["cls"]],
                name_index[name],
                geom_idx,
            ]
        )

    out: dict[str, Any] = {
        "nodes": nodes,
        "names": names,
        "classes": classes,
        "edges": edges,
        "geoms": geoms,
    }
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    path = WEB_DATA / "graph.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    shutil.copy(config.DATA_DIR / "network.geojson", WEB_DATA / "network.geojson")
    print(
        f"wrote {path} ({path.stat().st_size / 1e6:.1f} MB): "
        f"{len(nodes)} nodes, {len(edges)} edges, {len(geoms)} geometries"
    )


if __name__ == "__main__":
    export()
