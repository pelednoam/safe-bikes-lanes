// The ride banner's words: the next instruction, and the trip line under it.
// Drawn from one piece of state (app.ts rideView), which what the ride engine
// says (ride.ts effects) is turned into, instead of five elements written to
// from five places: the next turn, off route, at a stop, arrived, the ETA.
// The ids are the ones the page, its styles and its tests have always used.

/** What the big slot says: the turn, how far, and on to where. */
export interface Headline {
  icon: string;
  dist: string;
  street: string;
}

/** The line under it: what is left, and how fast. */
export interface TripLine {
  remaining: string;
  speed: string;
}

export function NavHeadline({ icon, dist, street }: Headline) {
  return (
    <>
      <span id="nav-icon">{icon}</span>
      <div id="nav-texts">
        <div id="nav-dist">{dist}</div>
        <div id="nav-street">{street}</div>
      </div>
    </>
  );
}

export function NavTripLine({ remaining, speed }: TripLine) {
  return (
    <>
      <span id="nav-remaining">{remaining}</span>
      <span id="nav-speed">{speed}</span>
    </>
  );
}
