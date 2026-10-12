/*
 * A player's metal and energy, following RWE (src/rwe/sim/GameSimulation.cpp updateResources and
 * GamePlayerInfo):
 *   - production and spending are collected in buffers during each second and applied together once a
 *     second;
 *   - spending is only accepted while the player isn't stalled on that resource; a player is stalled
 *     for the next second when the stock was at or below zero at the last settlement, which pauses
 *     every building job and powered machine that needs it (TA's "stalling");
 *   - storage is recomputed each second: each finished unit adds its storage, the Commander adds the
 *     player's starting storage; stock above storage is lost.
 *
 * "Desired" spending (what everything asked for, even when refused) is kept for the resource bar.
 */

export interface ResourceStats {
  stock: number;
  storage: number;
  /** Per second, from the last settlement. */
  income: number;
  spending: number;
  wanted: number;
  stalled: boolean;
}

export class PlayerEconomy {
  metal: number;
  energy: number;
  maxMetal: number;
  maxEnergy: number;
  metalStalled = false;
  energyStalled = false;

  private metalIn = 0;
  private energyIn = 0;
  private metalOut = 0;
  private energyOut = 0;
  private metalWanted = 0;
  private energyWanted = 0;

  /** Last second's totals, for display. */
  lastMetalIn = 0;
  lastEnergyIn = 0;
  lastMetalOut = 0;
  lastEnergyOut = 0;
  lastMetalWanted = 0;
  lastEnergyWanted = 0;

  constructor(
    readonly startingMetal: number,
    readonly startingEnergy: number,
  ) {
    this.metal = startingMetal;
    this.energy = startingEnergy;
    this.maxMetal = startingMetal;
    this.maxEnergy = startingEnergy;
  }

  /** Adds production (positive values) right away into this second's buffer. */
  /** Extra storage of each resource from the +atm cheat. */
  cheatStorage = 0;

  /** Sets the stock of both resources (the +atm cheat). */
  fill(metal: number, energy: number): void {
    this.metal = metal;
    this.energy = energy;
  }

  produce(energy: number, metal: number): void {
    this.energyIn += Math.max(0, energy);
    this.metalIn += Math.max(0, metal);
  }

  /**
   * Asks to spend. Returns false (and spends nothing) if the player is stalled on either resource the
   * request needs; the caller should then not do the work this time.
   */
  trySpend(energy: number, metal: number): boolean {
    this.energyWanted += energy;
    this.metalWanted += metal;
    if ((energy > 0 && this.energyStalled) || (metal > 0 && this.metalStalled)) return false;
    this.energyOut += energy;
    this.metalOut += metal;
    return true;
  }

  /** Settles the second's buffers. `maxMetal`/`maxEnergy` are the storage for the coming second. */
  settle(maxMetal: number, maxEnergy: number): void {
    this.maxMetal = maxMetal + this.cheatStorage;
    this.maxEnergy = maxEnergy + this.cheatStorage;
    this.lastMetalIn = this.metalIn;
    this.lastEnergyIn = this.energyIn;
    this.lastMetalOut = this.metalOut;
    this.lastEnergyOut = this.energyOut;
    this.lastMetalWanted = this.metalWanted;
    this.lastEnergyWanted = this.energyWanted;

    this.metal += this.metalIn;
    this.energy += this.energyIn;
    if (this.metal > 0) {
      this.metal -= this.metalOut;
      this.metalStalled = false;
    } else {
      this.metalStalled = true;
    }
    if (this.energy > 0) {
      this.energy -= this.energyOut;
      this.energyStalled = false;
    } else {
      this.energyStalled = true;
    }
    this.metal = Math.min(this.metal, this.maxMetal);
    this.energy = Math.min(this.energy, this.maxEnergy);
    this.metalIn = this.energyIn = this.metalOut = this.energyOut = this.metalWanted = this.energyWanted = 0;
  }

  stats(): { metal: ResourceStats; energy: ResourceStats } {
    return {
      metal: {
        stock: this.metal,
        storage: this.maxMetal,
        income: this.lastMetalIn,
        spending: this.lastMetalOut,
        wanted: this.lastMetalWanted,
        stalled: this.metalStalled,
      },
      energy: {
        stock: this.energy,
        storage: this.maxEnergy,
        income: this.lastEnergyIn,
        spending: this.lastEnergyOut,
        wanted: this.lastEnergyWanted,
        stalled: this.energyStalled,
      },
    };
  }
}
