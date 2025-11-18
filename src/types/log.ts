export interface PinoLogObject {
  /**
   * Numeric log level (e.g., 10, 20, ... 50).
   */
  level: number;

  /**
   * Timestamp in milliseconds since Unix epoch (Pino uses 'time').
   */
  time: number;

  /**
   * The log message.
   */
  msg: string;

  /**
   * Process ID (from Pino).
   */
  pid?: number;

  /**
   * Hostname of the machine.
   */
  hostname?: string;

  /**
   * Any other metadata fields.
   */
  [key: string]: unknown;
}
