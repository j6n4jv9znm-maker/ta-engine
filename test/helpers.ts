import type { TntMap } from '../src/formats/tnt';
import type { FeatureDef } from '../src/map/features';
import type { GameMap, PlacedFeature } from '../src/map/mapData';
import type { MovementClass, UnitDef } from '../src/sim/unitDef';
import { parseWeaponDef, type WeaponDef } from '../src/sim/weaponDef';
import type { UnitAssets } from '../src/sim/world';
import { parseTdf } from '../src/formats/tdf';

/** Shared test fixtures: units, weapons and flat maps built in code (no game data needed). */

export const ground: MovementClass = { name: 'G', footprintX: 2, footprintZ: 2, minWaterDepth: 0, maxWaterDepth: 50, maxSlope: 20, maxWaterSlope: 20 };

export function testUnit(over: Partial<UnitDef>): UnitAssets {
  const d: UnitDef = {
    unitName: 'X', name: 'X', description: '', side: 'ARM', objectName: '', footprintX: 2, footprintZ: 2,
    maxVelocity: 2, acceleration: 0.2, brakeRate: 0.3, turnRate: 2000, canMove: true, canFly: false, canHover: false,
    floater: false, bmCode: 1, maxDamage: 100, builder: false, workerTime: 0, buildTime: 100, buildCostMetal: 10,
    buildCostEnergy: 10, buildDistance: 64, energyMake: 0, metalMake: 0, energyUse: 0, metalUse: 0, makesMetal: 0,
    extractsMetal: 0, windGenerator: 0, tidalGenerator: 0, energyStorage: 0, metalStorage: 0, commander: false,
    activateWhenBuilt: false, onOffable: false, yardMap: '', corpse: '', weapons: ['', '', ''], explodeAs: '',
    selfDestructAs: '', sightDistance: 400, radarDistance: 0, damageModifier: 1, movementClass: ground, ownMovement: ground,
    ...over,
  };
  return { def: d, model: undefined, script: undefined };
}

export function testWeapon(name: string, tdf: string): WeaponDef {
  const root = parseTdf(`[${name}]{${tdf}}`);
  return parseWeaponDef(name.toLowerCase(), root[name.toLowerCase()] as never);
}

export function testFeature(over: Partial<FeatureDef>): FeatureDef {
  return {
    name: 'thing', world: '', description: '', category: '', footprintX: 2, footprintZ: 2, height: 10, fileName: '', seqName: '',
    seqNameShadow: '', object: '', animTrans: false, shadTrans: false, blocking: true, indestructible: false, reclaimable: true,
    metal: 0, energy: 0, featureDead: '', damage: 100, ...over,
  };
}

export function flatGameMap(w = 64, h = 64, features: PlacedFeature[] = [], height = 20): GameMap {
  const tnt: TntMap = {
    width: w, height: h, seaLevel: 0, heights: new Uint8Array(w * h).fill(height), features: new Uint16Array(w * h).fill(0xffff),
    featureNames: [], tilesWide: w / 2, tilesHigh: h / 2, tileIndices: new Uint16Array((w / 2) * (h / 2)), tiles: new Uint8Array(1024),
    tileCount: 1, minimap: { width: 1, height: 1, pixels: new Uint8Array(1) },
  };
  return { name: 'flat', tnt, ota: undefined, unknownFeatures: [], widthUnits: w * 16, heightUnits: h * 16, features };
}
