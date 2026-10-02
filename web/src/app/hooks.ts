// A function that a module needs from one that imports it (the planner calls
// navigation, and navigation calls the planner). Importing both ways makes a
// cycle, so the one that comes later in the start-up order sets it, and the
// earlier one calls it. Calling one that was never set is a bug in the order
// things start in, and says so instead of failing as "undefined is not a function".
export interface Hook<A extends unknown[], R> {
  /** Called once, by the module that has the function. */
  set(fn: (...args: A) => R): void;
  call(...args: A): R;
}

export function hook<A extends unknown[], R = void>(name: string): Hook<A, R> {
  let fn: ((...args: A) => R) | null = null;
  return {
    set(f) {
      if (fn !== null) throw new Error(`hook ${name} was set twice`);
      fn = f;
    },
    call(...args) {
      if (fn === null) throw new Error(`hook ${name} was called before it was set`);
      return fn(...args);
    },
  };
}
