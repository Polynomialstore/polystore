import { test as base } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Large OPFS tests need disk-backed storage: Chromium's incognito context
// can exhaust its in-memory storage below 1 GiB even with free host disk.
export const persistentTest = base.extend({
  context: async ({ playwright, launchOptions, headless, baseURL, acceptDownloads, contextOptions }, use, testInfo) => {
    const profile = await mkdtemp(join(tmpdir(), 'polystore-retrieval-browser-'))
    let context: Awaited<ReturnType<typeof playwright.chromium.launchPersistentContext>> | undefined
    try {
      context = await playwright.chromium.launchPersistentContext(profile, {
        ...launchOptions, ...contextOptions, headless, baseURL, acceptDownloads,
      })
      await use(context)
    } finally {
      try { await context?.close() }
      finally {
        if (testInfo.status !== testInfo.expectedStatus) {
          // Keep failed financial journals privately; never attach the profile
          // (wallet material and payload) to public CI artifacts.
          testInfo.annotations.push({ type: 'retained-private-profile', description: profile })
          console.log(`[retrieval diagnostics] Failed browser profile retained privately at ${profile}; remove after diagnosis`)
        } else await rm(profile, { recursive: true, force: true })
      }
    }
  },
})
