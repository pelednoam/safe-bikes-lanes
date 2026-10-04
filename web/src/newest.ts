// Run an async job again and again so that only the newest run's result is applied, and
// so that a caller waiting on any run is released only when the newest has finished.
//
// The job is told, as it goes, whether it is still the newest (`isCurrent`); a run that
// has been overtaken applies nothing. Every call returns a promise that resolves once the
// newest run started so far has completed, not just its own: someone waiting for "the
// data is in" must not be told so by a read that was overtaken and applied nothing.

export function newestWins(job: (isCurrent: () => boolean) => Promise<void>): () => Promise<void> {
  let generation = 0;
  let newest: Promise<void> = Promise.resolve();
  return async () => {
    const mine = ++generation;
    const run = job(() => mine === generation);
    newest = run;
    let waited = run;
    await waited;
    // a newer run started while this one was going: it is the one to wait for
    while (newest !== waited) {
      waited = newest;
      await waited;
    }
  };
}
