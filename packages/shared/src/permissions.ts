/**
 * Granular permission model. There is deliberately no "isAdmin": every protected operation names the
 * permission it needs, and roles are just named sets of permissions (editable in the admin panel).
 */

export const PERMISSIONS = [
  'admin.access',

  'tournament.create',
  'tournament.edit',
  'tournament.delete',
  'tournament.start',
  'tournament.manage',
  'tournament.teams',
  'tournament.bracket',

  /** Full control over any match (start/stop, teams, map, server, pause …) – what a party leader has for their own match. */
  'match.control',
  'match.pause',
  'match.resume',
  'match.restart',
  'match.forcemap',
  'match.editscore',
  'match.cancel',
  'match.assignserver',
  'match.forceteam',
  'match.removeplayer',

  'player.view',
  'player.ban',
  'player.unban',
  'player.pardon',
  'player.elo.edit',
  'player.rank.edit',

  'skin.assign',
  'skin.level.1',
  'skin.level.2',
  'skin.level.3',
  'skin.catalog',
  'skin.prices',

  'server.view',
  'server.manage',
  'server.keys',

  'map.manage',
  'team.edit.any',
  'role.manage',
  'settings.manage',
  'audit.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export const WILDCARD_PERMISSION = '*' as const;
export type GrantedPermission = Permission | typeof WILDCARD_PERMISSION;

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

export function isGrantedPermission(value: string): value is GrantedPermission {
  return value === WILDCARD_PERMISSION || PERMISSION_SET.has(value);
}

/** All permissions starting with `prefix` (e.g. "tournament."), used to define roles without typos. */
export function permissionsWithPrefix(prefix: string): Permission[] {
  return PERMISSIONS.filter((p) => p.startsWith(prefix));
}

export type SkinLevel = 0 | 1 | 2 | 3;

const SKIN_LEVEL_PERMISSIONS: ReadonlyArray<readonly [Permission, SkinLevel]> = [
  ['skin.level.3', 3],
  ['skin.level.2', 2],
  ['skin.level.1', 1],
];

/**
 * Turns role grants into the effective set: a wildcard grants everything, and a higher skin level
 * implies the lower ones (skin.level.3 ⊃ skin.level.2 ⊃ skin.level.1).
 */
export function effectivePermissions(granted: Iterable<string>): ReadonlySet<Permission> {
  const input = new Set(granted);
  if (input.has(WILDCARD_PERMISSION)) return new Set(PERMISSIONS);
  const result = new Set<Permission>();
  for (const p of input) if (isPermission(p)) result.add(p);
  for (const [permission, level] of SKIN_LEVEL_PERMISSIONS) {
    if (!result.has(permission)) continue;
    for (const [lower, lowerLevel] of SKIN_LEVEL_PERMISSIONS) if (lowerLevel < level) result.add(lower);
  }
  return result;
}

export function hasPermission(granted: ReadonlySet<Permission>, required: Permission): boolean {
  return granted.has(required);
}

export function hasAllPermissions(granted: ReadonlySet<Permission>, required: readonly Permission[]): boolean {
  return required.every((p) => granted.has(p));
}

/** Highest skin level this holder may hand out (0 if none). */
export function maxGrantableSkinLevel(granted: ReadonlySet<Permission>): SkinLevel {
  if (!granted.has('skin.assign')) return 0;
  for (const [permission, level] of SKIN_LEVEL_PERMISSIONS) if (granted.has(permission)) return level;
  return 0;
}

export const ROLE_KEYS = ['owner', 'admin', 'moderator', 'tournament_admin', 'server_admin'] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export interface RoleDefinition {
  key: RoleKey;
  name: string;
  description: string;
  position: number;
  permissions: readonly GrantedPermission[];
}

export const DEFAULT_ROLES: readonly RoleDefinition[] = [
  {
    key: 'owner',
    name: 'Owner',
    description: 'Full access, including role management.',
    position: 1,
    permissions: [WILDCARD_PERMISSION],
  },
  {
    key: 'admin',
    name: 'Admin',
    description: 'Everything except role management.',
    position: 2,
    permissions: PERMISSIONS.filter((p) => p !== 'role.manage'),
  },
  {
    key: 'moderator',
    name: 'Moderator',
    description: 'Moderates players and running matches.',
    position: 3,
    permissions: [
      'admin.access',
      'player.view',
      'player.ban',
      'player.unban',
      'player.pardon',
      'match.pause',
      'match.resume',
      'match.removeplayer',
      'skin.assign',
      'skin.level.1',
      'audit.view',
    ],
  },
  {
    key: 'tournament_admin',
    name: 'Tournament Admin',
    description: 'Creates and runs tournaments and matches.',
    position: 4,
    permissions: [
      'admin.access',
      ...permissionsWithPrefix('tournament.'),
      ...permissionsWithPrefix('match.'),
      'map.manage',
      'team.edit.any',
      'player.view',
      'server.view',
    ],
  },
  {
    key: 'server_admin',
    name: 'Server Admin',
    description: 'Manages game servers and server-side match operations.',
    position: 5,
    permissions: [
      'admin.access',
      ...permissionsWithPrefix('server.'),
      'match.pause',
      'match.resume',
      'match.restart',
      'match.assignserver',
    ],
  },
];

/** Roles whose removal would lock everyone out of role management. */
export const PROTECTED_ROLE_KEY: RoleKey = 'owner';
