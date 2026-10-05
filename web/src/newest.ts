// Run an async job again and again so that only the newest run's result is applied, and
// so that a caller is released when the newest run has finished.
//
// The job is told, as it goes, whether it is still the newest (`isCurrent`); a run that
// has been overtaken applies nothing. A call is released when the newest run started so
// far has finished, and not when its own has: someone waiting for "the data is in" must
// not be told so by a read that was overtaken and applied nothing, and one that was
// overtaken and never finishes (a device store that hangs) must not hold its caller for
// ever once a newer one has landed. So a call waiting on an older run is woken when a
// newer one starts, and waits on that instead; an overtaken run's failure is nobody's.

export function newestWins(job: (isCurrent: () => boolean) => Promise<void>): () => Promise<void> {
  let generation = 0;
  let newest: Promise<void> = Promise.resolve();
  const waiting = new Set<() => void>();
  return async () => {
    const mine = ++generation;
    const run = job(() => mine === generation);
    // an overtaken run may fail with nobody awaiting it, and that is not worth a crash
    run.catch(() => undefined);
    newest = run;
    // calls waiting on an older run now wait on this one
    for (const wake of [...waiting]) wake();
    let waited = run;
    for (;;) {
      let wake = (): void => undefined;
      const overtaken = new Promise<void>((resolve) => {
        wake = resolve;
        waiting.add(resolve);
      });
      try {
        await Promise.race([waited, overtaken]);
      } catch (err) {
        // the failure of the newest run is the caller's; of one that was overtaken, nobody's
        if (waited === newest) throw err;
      } finally {
        waiting.delete(wake);
      }
      if (waited === newest) return;
      waited = newest;
    }
  };
}
