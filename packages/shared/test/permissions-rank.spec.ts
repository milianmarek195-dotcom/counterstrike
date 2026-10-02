import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RANK_TIERS,
  DEFAULT_ROLES,
  PERMISSIONS,
  effectivePermissions,
  hasAllPermissions,
  hasPermission,
  isPermission,
  maxGrantableSkinLevel,
  nextRank,
  resolveRank,
  validateRankTiers,
  type RankTier,
} from '../src/index.js';

describe('permissions', () => {
  it('wildcard grants everything', () => {
    const all = effectivePermissions(['*']);
    for (const p of PERMISSIONS) expect(hasPermission(all, p)).toBe(true);
  });

  it('ignores unknown permission strings', () => {
    const granted = effectivePermissions(['tournament.create', 'totally.fake']);
    expect(granted.size).toBe(1);
    expect(isPermission('totally.fake')).toBe(false);
  });

  it('a higher skin level implies the lower ones', () => {
    const granted = effectivePermissions(['skin.assign', 'skin.level.3']);
    expect(hasAllPermissions(granted, ['skin.level.1', 'skin.level.2', 'skin.level.3'])).toBe(true);
    expect(maxGrantableSkinLevel(granted)).toBe(3);
    expect(maxGrantableSkinLevel(effectivePermissions(['skin.assign', 'skin.level.2']))).toBe(2);
  });

  it('cannot hand out skin levels without skin.assign', () => {
    expect(maxGrantableSkinLevel(effectivePermissions(['skin.level.3']))).toBe(0);
  });

  it('does not let a lower level imply a higher one', () => {
    const granted = effectivePermissions(['skin.level.1']);
    expect(hasPermission(granted, 'skin.level.2')).toBe(false);
  });

  describe('default roles', () => {
    const role = (key: string) => effectivePermissions(DEFAULT_ROLES.find((r) => r.key === key)!.permissions);

    it('owner can do everything', () => {
      expect(role('owner').size).toBe(PERMISSIONS.length);
    });

    it('admin can do everything except manage roles', () => {
      const admin = role('admin');
      expect(hasPermission(admin, 'role.manage')).toBe(false);
      expect(hasPermission(admin, 'tournament.delete')).toBe(true);
      expect(hasPermission(admin, 'skin.level.3')).toBe(true);
    });

    it('moderator can ban but not create tournaments or manage servers', () => {
      const mod = role('moderator');
      expect(hasPermission(mod, 'player.ban')).toBe(true);
      expect(hasPermission(mod, 'tournament.create')).toBe(false);
      expect(hasPermission(mod, 'server.manage')).toBe(false);
      expect(maxGrantableSkinLevel(mod)).toBe(1);
    });

    it('tournament admin runs tournaments and matches but cannot ban or touch servers', () => {
      const ta = role('tournament_admin');
      expect(hasAllPermissions(ta, ['tournament.create', 'tournament.start', 'match.cancel', 'match.forceteam'])).toBe(true);
      expect(hasPermission(ta, 'player.ban')).toBe(false);
      expect(hasPermission(ta, 'server.manage')).toBe(false);
    });

    it('server admin manages servers but cannot create tournaments', () => {
      const sa = role('server_admin');
      expect(hasAllPermissions(sa, ['server.manage', 'server.keys', 'match.restart'])).toBe(true);
      expect(hasPermission(sa, 'tournament.create')).toBe(false);
    });

    it('every role grants admin.access except none', () => {
      for (const r of DEFAULT_ROLES) expect(hasPermission(effectivePermissions(r.permissions), 'admin.access')).toBe(true);
    });

    it('every permission string in the roles is a real permission', () => {
      for (const r of DEFAULT_ROLES) {
        for (const p of r.permissions) expect(p === '*' || isPermission(p), `${r.key}:${p}`).toBe(true);
      }
    });
  });
});

describe('rank tiers', () => {
  it('resolves boundaries inclusively at the lower bound', () => {
    expect(resolveRank(0).key).toBe('bronze');
    expect(resolveRank(899).key).toBe('bronze');
    expect(resolveRank(900).key).toBe('silver');
    expect(resolveRank(1000).key).toBe('silver');
    expect(resolveRank(1432).key).toBe('diamond');
    expect(resolveRank(1800).key).toBe('master');
    expect(resolveRank(99999).key).toBe('master');
  });

  it('treats negative ratings as the lowest tier', () => {
    expect(resolveRank(-50).key).toBe('bronze');
  });

  it('works with custom tiers in any order', () => {
    const custom: RankTier[] = [
      { key: 'b', name: 'B', minElo: 1500, color: '#000', position: 2 },
      { key: 'a', name: 'A', minElo: 0, color: '#000', position: 1 },
    ];
    expect(resolveRank(1499, custom).key).toBe('a');
    expect(resolveRank(1500, custom).key).toBe('b');
  });

  it('finds the next tier', () => {
    expect(nextRank(resolveRank(1000))!.key).toBe('gold');
    expect(nextRank(resolveRank(2000))).toBeNull();
  });

  it('validates tier definitions', () => {
    expect(validateRankTiers(DEFAULT_RANK_TIERS)).toEqual([]);
    expect(validateRankTiers([{ key: 'x', name: 'X', minElo: 100, color: '#fff', position: 1 }])).toContain(
      'The lowest tier must start at 0 Elo',
    );
    expect(
      validateRankTiers([
        { key: 'x', name: 'X', minElo: 0, color: '#fff', position: 1 },
        { key: 'x', name: 'Y', minElo: 0, color: '#fff', position: 2 },
      ]).length,
    ).toBeGreaterThanOrEqual(2);
    expect(validateRankTiers([])).toHaveLength(1);
  });
});
