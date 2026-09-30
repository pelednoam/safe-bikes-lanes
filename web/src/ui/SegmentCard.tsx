// The card shown for a street, on the planner and on the city pages: its
// grade, what it is, what that means for a child, how far they'd detour to
// avoid it, whether anyone has crashed there, and a street-level photo.
//
// One component for both pages, because it is a safety claim made to a parent,
// and the two must not be able to describe the same street differently (see
// segment.ts). Drawn into an element the popup keeps, rather than written as
// HTML: street names come from OpenStreetMap, which anyone can edit, and as
// text here they can't become markup, where the HTML version had to remember
// to escape each one. And a photo that arrives is a change of state, not a
// write into a slot that a redraw of the card could throw away.
import { type ComponentChildren, h, render } from "preact";

import {
  CLASS_LABELS,
  CLASS_SAFETY,
  classGrade,
  FACILITY_CLASSES,
  fetchSegmentPhoto,
  GRADE_COLORS,
  GRADE_TEXT,
  photosPaused,
  type SegmentProps,
} from "../segment.js";
import { PROFILES } from "../router.js";

/** The card's photo: none asked for (no token), on its way, or its answer. */
export type Photo =
  | { state: "off" }
  | { state: "waiting" }
  | { state: "none" }
  /** No answer, because the lookup is backing off a rate limit: "no photo here"
   * would be a claim about the world we can't make. */
  | { state: "paused" }
  | { state: "shown"; url: string; captured: number | null };

export interface SegmentCardProps {
  seg: SegmentProps;
  photo: Photo;
  /** What the page adds under the card: how to mark it, which network it's on. */
  children?: ComponentChildren;
}

export function SegmentCard({ seg, photo, children }: SegmentCardProps) {
  const cls = seg.cls;
  // a class we can't grade is a class we can't describe either: say nothing
  // rather than something confident and wrong
  const grade = cls !== undefined ? classGrade(cls) : null;
  const known = cls !== undefined && grade !== null;
  const mult = known ? PROFILES.young_kids.mult[cls] : null;
  const crashes = seg.crashes ?? 0;
  const name = seg.name !== undefined && seg.name !== null && seg.name !== "" ? seg.name : "unnamed";
  return (
    <>
      {grade !== null ? (
        <>
          <span
            style={{
              background: GRADE_COLORS[grade],
              color: GRADE_TEXT[grade],
              borderRadius: "5px",
              padding: "0 6px",
              fontWeight: 700,
            }}
          >
            {grade}
          </span>{" "}
        </>
      ) : null}
      <b>{name}</b>
      <br />
      {known ? CLASS_LABELS[cls] : "type unknown"}
      {known ? (
        <>
          <br />
          {CLASS_SAFETY[cls]}
        </>
      ) : null}
      {mult !== null && mult !== undefined ? (
        <>
          <br />
          <small>
            {`kid-stress ×${mult} — young kids would detour up to ${mult}× the distance to avoid ` +
              (mult > 1.6 ? "this" : "worse")}
          </small>
        </>
      ) : null}
      {crashes > 0 ? (
        <>
          <br />
          <small>{`⚠ ${crashes} bike crash${crashes > 1 ? "es" : ""} recorded nearby (2021–26)`}</small>
        </>
      ) : null}
      {seg.source === "osm" && known && FACILITY_CLASSES.includes(cls) ? (
        <>
          <br />
          <small>
            <i>facility per OSM only (not in official layers yet)</i>
          </small>
        </>
      ) : null}
      {photo.state === "off" ? null : (
        <div data-seg-photo="">
          <PhotoLine photo={photo} />
        </div>
      )}
      {children}
    </>
  );
}

function PhotoLine({ photo }: { photo: Photo }) {
  switch (photo.state) {
    case "shown":
      return (
        <>
          <img
            src={photo.url}
            alt=""
            style={{ maxWidth: "210px", borderRadius: "6px", display: "block", marginTop: "4px" }}
          />
          📷
          {photo.captured !== null ? (
            <>
              {" "}
              <small>{new Date(photo.captured).toLocaleDateString()}</small>
            </>
          ) : null}
        </>
      );
    case "none":
      return (
        <small>
          <i>no street-level photo here</i>
        </small>
      );
    case "paused":
      return (
        <small>
          <i>street-level photos are rate-limited right now</i>
        </small>
      );
    default:
      return null;
  }
}

/** The photo for a point, as the card shows it. */
export async function photoFor(lon: number, lat: number, token: string): Promise<Photo> {
  if (token === "") return { state: "off" };
  const { url, captured } = await fetchSegmentPhoto(lon, lat, token);
  if (url === null) return { state: photosPaused() ? "paused" : "none" };
  return { state: "shown", url, captured };
}

/** A street card in a popup: one element the popup keeps, drawn again for each
 * street and again when its photo arrives. */
export class SegmentCardView {
  readonly el: HTMLDivElement = document.createElement("div");
  private seg: SegmentProps = {};
  private extra: ComponentChildren = null;
  private photo: Photo = { state: "off" };
  /** Which card is up, so a photo for a card since replaced is dropped. */
  private shown = 0;

  /** Draw a street, with a photo to come if there's a token to ask with. */
  show(seg: SegmentProps, extra: ComponentChildren, withPhoto: boolean): void {
    this.shown++;
    this.seg = seg;
    this.extra = extra;
    this.photo = withPhoto ? { state: "waiting" } : { state: "off" };
    this.draw();
  }

  /** Ask for the photo of the street on the card now, and put it on the card
   * if it is still that street's card when it comes, and still wanted. */
  loadPhoto(lon: number, lat: number, token: string, stillWanted: () => boolean): void {
    if (this.photo.state !== "waiting") return;
    const card = this.shown;
    void photoFor(lon, lat, token).then((photo) => {
      if (card !== this.shown || !stillWanted()) return; // the pointer moved on
      this.photo = photo;
      this.draw();
    });
  }

  private draw(): void {
    render(h(SegmentCard, { seg: this.seg, photo: this.photo }, this.extra), this.el);
  }
}
