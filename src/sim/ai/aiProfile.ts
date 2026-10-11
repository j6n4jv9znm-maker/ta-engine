import { latin1 } from '../../formats/hpi';
import type { Vfs } from '../../vfs';

/*
 * TA's own AI profiles (ai/*.txt, e.g. ai/DEFAULT.TXT). Each has a "plan easy", "plan medium" and
 * "plan hard" section of lines:
 *   Weight <name> <w>   how much the AI likes building it (a unit name, or a category word such as ARM,
 *                       PLANT, CONSTR, LEVEL3, matched against the unit's FBI category and tedclass)
 *   Limit <name> <n>    how many it may have at once (unit name or category)
 * We read these as data for our own rule-based AI; the format is plain text documented by the TA
 * modding community. Unlisted things weigh 1 and are unlimited.
 */

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface AiPlan {
  weights: Map<string, number>;
  limits: Map<string, number>;
}

export function parseAiProfile(text: string): Map<Difficulty, AiPlan> {
  const plans = new Map<Difficulty, AiPlan>();
  let current: AiPlan | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    const [kw, name, value] = line.split(/\s+/);
    const k = kw?.toLowerCase();
    if (k === 'plan' && name) {
      const d = name.toLowerCase() as Difficulty;
      current = { weights: new Map(), limits: new Map() };
      plans.set(d, current);
    } else if (current && name && value !== undefined) {
      const v = Number.parseFloat(value);
      if (!Number.isFinite(v)) continue;
      if (k === 'weight') current.weights.set(name.toUpperCase(), v);
      else if (k === 'limit') current.limits.set(name.toUpperCase(), v);
    }
  }
  return plans;
}

export async function loadAiProfile(vfs: Vfs, name = 'DEFAULT'): Promise<Map<Difficulty, AiPlan>> {
  const path = `ai/${name}.txt`;
  if (!vfs.exists(path)) return new Map();
  return parseAiProfile(latin1(await vfs.read(path)));
}

/** All the names a unit answers to in a profile: its own name, its tedclass and its category words. */
export function profileKeys(unitName: string, tedClass: string, categories: string[]): string[] {
  return [unitName.toUpperCase(), tedClass, ...categories].filter(Boolean);
}

/** A unit's weight: the product of every matching weight (our reading; the profile format does not say how they combine). */
export function weightOf(plan: AiPlan | undefined, keys: string[]): number {
  if (!plan) return 1;
  let w = 1;
  for (const k of keys) {
    const v = plan.weights.get(k);
    if (v !== undefined) w *= v;
  }
  return w;
}

/** The tightest matching limit, or Infinity. */
export function limitOf(plan: AiPlan | undefined, keys: string[]): number {
  if (!plan) return Infinity;
  let l = Infinity;
  for (const k of keys) {
    const v = plan.limits.get(k);
    if (v !== undefined) l = Math.min(l, v);
  }
  return l;
}
