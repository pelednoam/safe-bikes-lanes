// The routing worker: tiles, graph and every route search, off the page's
// thread (see routing.ts, and rpc.ts for how the page calls in).
import { createRoutingApi } from "./routing.js";
import { expose } from "./rpc.js";

expose(createRoutingApi(), self);
