/**
 * Shared port interfaces used across host subsystems.
 * Lives outside domain/ because ports are boundary contracts, not domain logic.
 */

/**
 * Unified logger port for all host subsystems.
 * Avoids coupling to a specific logging library.
 */
export interface LogPort {
  readonly info: (msg: string, data?: Record<string, unknown>) => void;
  readonly warn: (msg: string, data?: Record<string, unknown>) => void;
  readonly error: (msg: string, data?: Record<string, unknown>) => void;
}
