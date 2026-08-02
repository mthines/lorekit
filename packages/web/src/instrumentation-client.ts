/**
 * Next.js client-side instrumentation hook (Next.js 15.3+).
 * Next.js loads this automatically in the browser before the app mounts.
 *
 * This is the EARLIEST browser entry point, so it is where RUM is initialised:
 * running here rather than in a React effect means early page-load spans are
 * captured, and — since `initDash0Rum` identifies the visitor anonymously
 * before the first event — no event is ever emitted without a `user.id`.
 *
 * `Dash0Provider` calls the same `initDash0Rum()` as a belt-and-braces backup
 * and to attach the authenticated user id once React has the session. The
 * initialisation guard now lives in `lib/dash0-rum.ts` alongside `init()`, so
 * the two entry points genuinely share ONE flag — previously each module had
 * its own copy and the SDK was initialised twice on every dashboard page load.
 *
 * VCS resource attributes are baked into the page at build time via
 * next.config.ts (NEXT_PUBLIC_VCS_* env vars), resolved from Vercel's system
 * env vars which are available to the build process.
 */
import { addSignalAttribute } from '@dash0/sdk-web';

import { initDash0Rum } from './lib/dash0-rum';

initDash0Rum();

export { addSignalAttribute };
