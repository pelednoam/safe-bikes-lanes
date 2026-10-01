// The small cards the map's points and areas show: a place, a safe crossing,
// a hazard a rider reported, a construction site, and the two overlays' blocks.
// Drawn as text into the popup's element, where they were HTML strings set with
// setHTML: permit feeds, OpenStreetMap and a rider's own notes all reach these,
// and each field had to be escaped by hand, which the click card for a permit
// once forgot while the hover card beside it remembered.
import { type ComponentChild, type ComponentChildren, render } from "preact";

import { fmtClimb, fmtDist } from "../units.js";

/** A card drawn into an element of its own, for a popup's setDOMContent. */
export function cardElement(card: ComponentChild): HTMLDivElement {
  const el = document.createElement("div");
  render(card, el);
  return el;
}

/** Text a feed may have sent as null, a number, or spaces: absent unless it
 * says something. */
export function textOf(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function Line({ children }: { children: ComponentChildren }) {
  return (
    <>
      <br />
      {children}
    </>
  );
}

export interface PlaceCardProps {
  emoji: string;
  name: string;
  /** What kind of place, when it adds to the name ("playground"). */
  kind: string;
}

export function PlaceCard({ emoji, name, kind }: PlaceCardProps) {
  return (
    <>
      {`${emoji} `}
      <b>{name}</b>
      {kind !== "" ? (
        <Line>
          <small>{kind}</small>
        </Line>
      ) : null}
    </>
  );
}

export function CrossingCard() {
  return (
    <>
      {"🚦 "}
      <b>safe crossing</b>
      <Line>
        <small>signalized crossing of a busy street</small>
      </Line>
    </>
  );
}

export interface HazardCardProps {
  label: string;
  note: string;
  /** When it was reported, as the rider reads a date. */
  when: string | null;
  /** The photo, once it has been read from the device; null while it is, or
   * if there is none. */
  photo: string | null;
}

export function HazardCard({ label, note, when, photo }: HazardCardProps) {
  return (
    <>
      {"⚠ "}
      <b>{label}</b>
      {note !== "" ? <Line>{note}</Line> : null}
      {photo !== null ? (
        <img
          src={photo}
          alt=""
          style={{ maxWidth: "180px", display: "block", borderRadius: "6px", marginTop: "4px" }}
        />
      ) : null}
      {when !== null ? (
        <Line>
          <small>{`${when} · click to remove`}</small>
        </Line>
      ) : null}
    </>
  );
}

export interface ConstructionCardProps {
  name: string;
  kind: string;
  address: string;
  detail: string;
  /** Which feed: "massdot_wzdx", or a city's permits. */
  src: string;
  start: string;
  end: string;
}

/** What the card says, from a permit feature's properties: each field the feed
 * may have sent as null, a number, or spaces. One place, so the hover and the tap
 * can't read the same permit two ways. */
export function constructionProps(p: Record<string, unknown>): ConstructionCardProps {
  return {
    name: textOf(p["name"]),
    kind: textOf(p["kind"]),
    address: textOf(p["address"]),
    detail: textOf(p["detail"]),
    src: textOf(p["src"]),
    start: textOf(p["start"]),
    end: textOf(p["end"]),
  };
}

/** A construction site, the same whether hovered or tapped: the two cards
 * worded the same permit differently, and only one of them escaped it. */
export function ConstructionCard(p: ConstructionCardProps) {
  const title = p.name !== "" ? p.name : p.kind !== "" ? p.kind : "construction";
  const source = p.src === "massdot_wzdx" ? "MassDOT work zone" : "Cambridge street permit";
  const dates = p.start !== "" || p.end !== "" ? ` · ${p.start || "?"} → ${p.end || "?"}` : "";
  return (
    <>
      {"🚧 "}
      <b>{title}</b>
      {p.name !== "" && p.kind !== "" ? ` · ${p.kind}` : null}
      {p.address !== "" ? <Line>{p.address}</Line> : null}
      {p.detail !== "" ? <Line>{p.detail}</Line> : null}
      <Line>
        <small>{source + dates}</small>
      </Line>
    </>
  );
}

/** The lane overlay's block: how much bike facility, and how much protected. */
export function BlockCard({ facilityM, protectedM }: { facilityM: number; protectedM: number }) {
  return (
    <>
      {`🚴 ${fmtDist(facilityM)} of bike facilities in this block`}
      <Line>
        <small>{`${fmtDist(protectedM)} protected (path/separated)`}</small>
      </Line>
    </>
  );
}

export function ElevationCard({ elevM }: { elevM: number }) {
  return <>{`elevation ~${fmtClimb(elevM)}`}</>;
}
