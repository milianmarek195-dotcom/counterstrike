import type { GameMode } from './constants.js';

export interface DefaultMapDefinition {
  key: string;
  name: string;
  modes: GameMode[];
}

/** Seeded once when the maps table is empty; afterwards maps are managed in the admin panel (never hard-coded). */
export const DEFAULT_MAPS: readonly DefaultMapDefinition[] = [
  { key: 'de_mirage', name: 'Mirage', modes: ['FIVE_V_FIVE'] },
  { key: 'de_inferno', name: 'Inferno', modes: ['FIVE_V_FIVE', 'WINGMAN'] },
  { key: 'de_nuke', name: 'Nuke', modes: ['FIVE_V_FIVE', 'WINGMAN'] },
  { key: 'de_ancient', name: 'Ancient', modes: ['FIVE_V_FIVE'] },
  { key: 'de_anubis', name: 'Anubis', modes: ['FIVE_V_FIVE'] },
  { key: 'de_overpass', name: 'Overpass', modes: ['FIVE_V_FIVE', 'WINGMAN'] },
  { key: 'de_dust2', name: 'Dust2', modes: ['FIVE_V_FIVE'] },
  { key: 'de_vertigo', name: 'Vertigo', modes: ['FIVE_V_FIVE', 'WINGMAN'] },
];

export interface DefaultMapPoolDefinition {
  name: string;
  mode: GameMode;
  mapKeys: string[];
}

export const DEFAULT_MAP_POOLS: readonly DefaultMapPoolDefinition[] = [
  {
    name: 'Standard 5v5',
    mode: 'FIVE_V_FIVE',
    mapKeys: DEFAULT_MAPS.filter((m) => m.modes.includes('FIVE_V_FIVE')).map((m) => m.key),
  },
  {
    name: 'Wingman',
    mode: 'WINGMAN',
    mapKeys: DEFAULT_MAPS.filter((m) => m.modes.includes('WINGMAN')).map((m) => m.key),
  },
];
