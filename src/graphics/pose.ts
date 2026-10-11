import * as THREE from 'three';
import { angleToRadians, type PieceAnimator } from '../sim/pieces';
import type { UnitModel } from './threeModel';

/**
 * Poses a unit model from its simulated piece state. Read-only on the simulation side: the renderer
 * copies offsets, turns and visibility onto the Three.js groups. Rotation order is Y, X, Z (matrix
 * Ry * Rx * Rz), as in RWE. Hiding a piece hides only its own mesh, not its children, as in TA.
 */
export function applyPose(model: UnitModel, animator: PieceAnimator, hidden?: ReadonlySet<string>): void {
  for (const state of animator.pieces) {
    const g = model.pieces.get(state.name.toLowerCase());
    if (!g) continue;
    const rest = g.userData.rest as [number, number, number];
    g.position.set(rest[0] + state.offset[0], rest[1] + state.offset[1], rest[2] + state.offset[2]);
    g.rotation.set(angleToRadians(state.rotation[0]), angleToRadians(state.rotation[1]), angleToRadians(state.rotation[2]), 'YXZ');
    const mesh = g.children.find((c) => c instanceof THREE.Mesh);
    if (mesh) mesh.visible = state.visible && !hidden?.has(state.name.toLowerCase());
  }
}
