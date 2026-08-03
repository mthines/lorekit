import { describe, expect, it } from 'vitest';

import { SETTINGS_LANDING_HREF, SETTINGS_ROOT, isSettingsPath } from './settings-routes';

describe('settings-routes', () => {
  describe('SETTINGS_LANDING_HREF', () => {
    // The regression this guards: `/settings` was a Server Component whose only
    // job was `redirect('/settings/api-keys')`. Navigating to it client-side
    // crashed React inside Next's app-router (Minified React error #310). The
    // landing href must therefore be a real section page, never the root.
    it('is not the settings root', () => {
      expect(SETTINGS_LANDING_HREF).not.toBe(SETTINGS_ROOT);
    });

    it('is a section nested under the settings root', () => {
      expect(SETTINGS_LANDING_HREF.startsWith(`${SETTINGS_ROOT}/`)).toBe(true);
      expect(SETTINGS_LANDING_HREF.slice(SETTINGS_ROOT.length + 1)).not.toContain('/');
    });

    it('is still recognised as being inside the settings area', () => {
      expect(isSettingsPath(SETTINGS_LANDING_HREF)).toBe(true);
    });
  });

  describe('isSettingsPath', () => {
    it('matches the root itself', () => {
      expect(isSettingsPath('/settings')).toBe(true);
    });

    it('matches nested sections', () => {
      expect(isSettingsPath('/settings/api-keys')).toBe(true);
      expect(isSettingsPath('/settings/organization')).toBe(true);
      expect(isSettingsPath('/settings/user')).toBe(true);
    });

    it('does not match sibling routes that merely share the prefix', () => {
      expect(isSettingsPath('/settings-export')).toBe(false);
      expect(isSettingsPath('/dashboard')).toBe(false);
      expect(isSettingsPath('/lore')).toBe(false);
    });
  });
});
