import type { BrowserContextOptions } from '@playwright/test';
import type { ExecutionProfileId } from '@qa/contracts';

/**
 * Pinned rendering profiles. Viewport emulation establishes responsive-layout
 * coverage only; it is not evidence of native mobile-browser behaviour.
 */
export const EXECUTION_PROFILES: Record<ExecutionProfileId, BrowserContextOptions> = {
  chromium_desktop: {
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  },
  chromium_mobile_viewport: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  },
};
