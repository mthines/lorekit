import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_WIDE_TOOLS,
  OWNER_ROW_TOOLS,
  isRefusedForOrgsOnlyKey,
  orgsOnlyRefusalMessage,
} from './account-wide-tools.js';

describe('isRefusedForOrgsOnlyKey (00116)', () => {
  it('refuses every owner-row tool to an orgs_only key', () => {
    for (const tool of OWNER_ROW_TOOLS) expect(isRefusedForOrgsOnlyKey(tool, 'orgs_only')).toBe(true);
  });

  it('covers the account-wide sweeps and the retention family', () => {
    for (const tool of [...ACCOUNT_WIDE_TOOLS, 'memory.quota', 'memory.protect', 'policy.list',
      'policy.create', 'policy.update', 'policy.delete', 'groom.preview', 'groom.run']) {
      expect(OWNER_ROW_TOOLS.has(tool)).toBe(true);
    }
  });

  it('covers the owner analytics whose RPCs take no tenancy', () => {
    for (const tool of ['memory.read-activity', 'memory.read-ranking', 'memory.utility', 'memory.usage',
      'memory.usage-runs']) {
      expect(isRefusedForOrgsOnlyKey(tool, 'orgs_only')).toBe(true);
    }
  });

  it('refuses the account-level org surface, which ignores the key\'s org list', () => {
    for (const tool of ['org.list', 'org.get', 'org.create', 'org.rename', 'org.delete', 'member.list',
      'member.invite_list', 'member.invite', 'member.revoke', 'member.remove', 'member.role_change']) {
      expect(isRefusedForOrgsOnlyKey(tool, 'orgs_only')).toBe(true);
      expect(isRefusedForOrgsOnlyKey(tool, 'selected')).toBe(false);
    }
    expect(orgsOnlyRefusalMessage('org.list')).toMatch(/organisations.*orgs_only/);
  });

  it('leaves tenancy-narrowed tools alone', () => {
    for (const tool of ['memory.read', 'memory.list', 'memory.search', 'memory.write', 'memory.scopes',
      'memory.list_archived', 'memory.archive', 'memory.restore', 'memory.delete']) {
      expect(isRefusedForOrgsOnlyKey(tool, 'orgs_only')).toBe(false);
    }
  });

  it('changes nothing for the other tenancies or no key', () => {
    for (const access of ['all', 'personal', 'selected', undefined]) {
      expect(isRefusedForOrgsOnlyKey('memory.purge', access)).toBe(false);
      expect(isRefusedForOrgsOnlyKey('groom.run', access)).toBe(false);
    }
  });

  it('names the tool and the tenancy in its refusal', () => {
    expect(orgsOnlyRefusalMessage('memory.quota')).toMatch(/memory\.quota.*orgs_only/);
  });
});
