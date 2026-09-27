// What the build supplies that TypeScript can't see.

/** Filled in by vite.config.ts (define): which build this is, for the About box. */
declare const __BUILD_VERSION__: string;
declare const __BUILD_TIME__: string;
declare const __BUILD_COMMIT__: string;

/** Stylesheets imported for their side effect; Vite bundles them. */
declare module "*.css";
