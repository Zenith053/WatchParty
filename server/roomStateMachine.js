/**
 * roomStateMachine.js — Finite State Machine Pattern (Design Pattern #2 from Architecture)
 *
 * Models the room lifecycle: idle → paused → playing → ended
 * Prevents invalid state transitions (e.g. ended → paused without loading a new video).
 *
 * States:
 *   idle    — room created, no video loaded yet
 *   paused  — video loaded / paused
 *   playing — video actively playing
 *   ended   — video finished playing
 *
 * Architecture reference: "State Machine: Room lifecycle (Waiting → Active →
 * Paused → Ended) prevents invalid transitions."
 */
'use strict';

const VALID_STATES = ['idle', 'paused', 'playing', 'ended'];

/**
 * Allowed transitions: state → [reachable states]
 */
const TRANSITIONS = {
  idle:    ['paused'],                   // LOAD → video loaded as paused
  paused:  ['playing', 'ended', 'idle'], // PLAY, video finishes, clear
  playing: ['paused', 'ended'],          // PAUSE, video finishes
  ended:   ['paused', 'playing', 'idle'],// LOAD new, auto-play next, clear
};

class RoomStateMachine {
  /**
   * @param {string} initialState  One of VALID_STATES (default: 'idle')
   */
  constructor(initialState = 'idle') {
    if (!VALID_STATES.includes(initialState)) {
      throw new Error(`Invalid initial state: ${initialState}`);
    }
    this._state = initialState;
    this._listeners = [];
    this._history = [{ from: null, to: initialState, at: Date.now() }];
  }

  /** Current state */
  get state() {
    return this._state;
  }

  /** Transition history */
  get history() {
    return [...this._history];
  }

  /**
   * Check if a transition to the target state is valid.
   * Same-state transitions are always allowed (no-op).
   * @param {string} to  Target state
   * @returns {boolean}
   */
  canTransition(to) {
    if (to === this._state) return true; // same-state is always valid
    return (TRANSITIONS[this._state] ?? []).includes(to);
  }

  /**
   * Transition to a new state.
   * @param {string} to  Target state
   * @returns {RoomStateMachine}  this (chainable)
   * @throws {Error} if the transition is invalid
   */
  transition(to) {
    if (!VALID_STATES.includes(to)) {
      throw new Error(`Unknown state: ${to}`);
    }

    // Same-state: no-op, no listeners fired
    if (to === this._state) return this;

    if (!this.canTransition(to)) {
      throw new Error(
        `Invalid state transition: ${this._state} → ${to}. ` +
        `Allowed: [${(TRANSITIONS[this._state] ?? []).join(', ')}]`
      );
    }

    const from = this._state;
    this._state = to;
    this._history.push({ from, to, at: Date.now() });

    // Notify listeners
    for (const fn of this._listeners) {
      try { fn(from, to); } catch (err) {
        console.error('[RoomStateMachine] Listener error:', err.message);
      }
    }

    return this;
  }

  /**
   * Register a listener for state transitions.
   * @param {Function} fn  (fromState, toState) => void
   */
  onTransition(fn) {
    this._listeners.push(fn);
    return this;
  }

  /**
   * Reset the machine to idle state (e.g. when clearing a room).
   */
  reset() {
    const from = this._state;
    this._state = 'idle';
    this._history.push({ from, to: 'idle', at: Date.now() });
    return this;
  }
}

module.exports = { RoomStateMachine, TRANSITIONS, VALID_STATES };
