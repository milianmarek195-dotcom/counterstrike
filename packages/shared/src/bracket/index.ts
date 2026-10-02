import type { TournamentFormat } from '../constants.js';
import { doubleEliminationGenerator, singleEliminationGenerator } from './elimination.js';
import { BracketError, type BracketGenerator } from './types.js';

export * from './types.js';
export * from './engine.js';
export {
  MAX_BRACKET_PARTICIPANTS,
  doubleEliminationGenerator,
  nextPowerOfTwo,
  seedOrder,
  singleEliminationGenerator,
} from './elimination.js';

/** Registry of implemented formats; add a generator here (and to SUPPORTED_TOURNAMENT_FORMATS) to enable one. */
const GENERATORS: Partial<Record<TournamentFormat, BracketGenerator>> = {
  SINGLE_ELIMINATION: singleEliminationGenerator,
  DOUBLE_ELIMINATION: doubleEliminationGenerator,
};

export function getBracketGenerator(format: TournamentFormat): BracketGenerator {
  const generator = GENERATORS[format];
  if (!generator) throw new BracketError(`Tournament format ${format} is not implemented`);
  return generator;
}
