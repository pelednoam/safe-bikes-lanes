// The route option cards: one choice among several, drawn from the trip
// (trip.ts). What app.ts built by hand, element by element, and rebuilt on
// every repaint; the markup, classes and roles are the same, so is every test.
import { useEffect, useRef } from "preact/hooks";

import type { RouteOption } from "../types.js";
import { fmtClimb, fmtDist } from "../units.js";

export interface OptionCardsProps {
  options: readonly RouteOption[];
  selectedId: RouteOption["id"] | null;
  /** The card that should have focus once drawn: arrow keys move the choice,
   * and the choice keeps the focus rather than dropping it on the page. */
  focusId: RouteOption["id"] | null;
  gradeColors: Record<string, string>;
  gradeText: Record<string, string>;
  onSelect(id: RouteOption["id"], keepFocus: boolean): void;
  /** Hovering a card previews its route on the map; leaving puts the chosen
   * one back (null). */
  onPreview(option: RouteOption | null): void;
}

export function OptionCards(p: OptionCardsProps) {
  if (p.options.length === 0) return null;
  const move = (from: RouteOption, key: string): RouteOption | undefined => {
    const i = p.options.findIndex((x) => x.id === from.id);
    const step = key === "ArrowDown" || key === "ArrowRight" ? 1 : key === "ArrowUp" || key === "ArrowLeft" ? -1 : 0;
    if (step !== 0) return p.options[(i + step + p.options.length) % p.options.length];
    return key === "Enter" || key === " " ? from : undefined;
  };
  return (
    <>
      {p.options.length > 1 && <div class="options-head">{`${p.options.length} route options`}</div>}
      {p.options.map((o) => (
        <Card
          key={o.id}
          option={o}
          selected={o.id === p.selectedId}
          focus={o.id === p.focusId}
          background={p.gradeColors[o.grade] ?? ""}
          color={p.gradeText[o.grade] ?? ""}
          onSelect={() => p.onSelect(o.id, false)}
          onKey={(key) => {
            const target = move(o, key);
            if (target === undefined) return false;
            p.onSelect(target.id, true);
            return true;
          }}
          onEnter={() => p.onPreview(o)}
          onLeave={() => p.onPreview(null)}
        />
      ))}
    </>
  );
}

interface CardProps {
  option: RouteOption;
  selected: boolean;
  focus: boolean;
  background: string;
  color: string;
  onSelect(): void;
  /** True when the key was handled. */
  onKey(key: string): boolean;
  onEnter(): void;
  onLeave(): void;
}

function Card(p: CardProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (p.focus) ref.current?.focus();
  }, [p.focus]);
  const o = p.option;
  const s = o.payload.summary;
  // the selected card is the hero: just the headline numbers, since the
  // breakdown below it already spells out protected/quiet/climb
  const headline = `${fmtDist(s.meters)} · ${s.minutes} min · ${s.pct_protected}% protected`;
  return (
    <div
      ref={ref}
      class={"option-card" + (p.selected ? " selected" : "")}
      title={o.gradeReason}
      role="radio"
      aria-checked={p.selected}
      // one tab stop for the group, on the chosen one: the radio pattern
      tabIndex={p.selected ? 0 : -1}
      onClick={p.onSelect}
      onKeyDown={(ev) => {
        if (p.onKey(ev.key)) ev.preventDefault();
      }}
      onMouseEnter={p.onEnter}
      onMouseLeave={p.onLeave}
    >
      <b class="grade" style={{ background: p.background, color: p.color }}>
        {o.grade}
      </b>
      {/* name on its own line, the numbers on a second: a single run-on string
          of "·" separators is unreadable at a glance */}
      <span class="opt-body">
        <span class="opt-name">{o.label}</span>
        <span class="opt-stats">{p.selected ? headline : `${headline} · ↗ ${fmtClimb(s.climb_m ?? 0)}`}</span>
      </span>
    </div>
  );
}
