import type { BrowserContextOptions } from '@playwright/test';
import type { ExecutionProfileId } from '@qa/contracts';

export type BrowserName = 'chromium' | 'firefox' | 'webkit';

const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', reducedMotion: 'reduce' };

/**
 * Pinned rendering profiles. Viewport emulation establishes responsive-layout
 * coverage only; it is not evidence of native mobile-browser behaviour.
 */
export const EXECUTION_PROFILES: Record<ExecutionProfileId, { browser: BrowserName; options: BrowserContextOptions }> = {
  chromium_desktop: { browser: 'chromium', options: DESKTOP },
  chromium_mobile_viewport: {
    browser: 'chromium',
    options: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', reducedMotion: 'reduce' },
  },
  firefox_desktop: { browser: 'firefox', options: DESKTOP },
  webkit_desktop: { browser: 'webkit', options: DESKTOP },
};
