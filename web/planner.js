// Ownership of the planner's outputs while a computation waits.
//
// Planning is a chain of waits — the rider's location, the tile manifest, the
// tiles along a corridor — and the rider does not stand still through them. They
// press Reset, pick a second destination, drag the reach slider, close the
// reach map. Each of those starts a newer computation for the same output, or
// withdraws the question altogether, and the one already waiting must not come
// back afterwards and write its answer over the newer state: that is how Reset
// resurrected a cleared trip, how an older destination's route replaced the one
// asked for last, and how a reach map closed mid-load crashed on its own
// missing centre.
//
// A Lane is one output (the route options, the reach map, the search grades).
// Starting work on it takes a Ticket; anything that supersedes the work —
// a newer start, or cancel() — makes every earlier ticket stale. Code checks
// the ticket after every await and gives up quietly when it is stale, leaving
// the output to whoever holds the current one.
export class Lane {
    constructor() {
        this.gen = 0;
    }
    /** Start work on this lane, superseding whatever was already running. */
    begin() {
        const mine = ++this.gen;
        return { stale: () => mine !== this.gen };
    }
    /** Withdraw the question: every ticket issued so far goes stale. */
    cancel() {
        this.gen++;
    }
}
