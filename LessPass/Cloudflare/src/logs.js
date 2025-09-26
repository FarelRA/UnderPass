// logs.js

/**
 * Formats log messages with context information, including timestamp, log ID,
 * section, client IP, remote address (if available), the message itself,
 * and any optional parameters. The context is mutable.
 *
 * @param {string} message - The primary log message.
 * @param {object} context - The logging context (mutable).
 * @param {string} additionalInfo - Additional context info, appended to the section.
 * @param  {...any} optionalParams - Optional parameters to include in the log.
 * @returns {string} - The formatted log message.
 */
function formatLogMessage(message, context = {}, additionalInfo = '', ...optionalParams) {
  const timestamp = new Date().toISOString();
  const { logId = 'N/A', section = 'N/A', clientIP = 'N/A', remoteAddress, remotePort } = context;

  // Combine section and additionalInfo for more detailed context.
  const fullSection = additionalInfo ? `${section}:${additionalInfo}` : section;
  // Include remote address and port if available.
  const remote = remoteAddress && remotePort ? ` [Remote: ${remoteAddress}:${remotePort}]` : '';
  // Stringify optional parameters for inclusion in the log.
  const optionalData = optionalParams.length ? ` ${JSON.stringify(optionalParams)}` : '';

  return `[${timestamp}] [${logId}] [${fullSection}] [Client: ${clientIP}]${remote} ${message}${optionalData}`;
}

/**
 * Generates a short, random log ID. This helps correlate log messages
 * related to the same request across different parts of the system.
 *
 * @returns {string} A 6-character base-36 log ID.
 */
export function generateLogId() {
  return Math.random().toString(36).substring(2, 8);
}

/**
 *  Log levels, with increasing verbosity. Using numeric values allows
 *  for easy comparison (e.g., `if (this.logLevel >= LOG_LEVELS.INFO)`).
 */
export const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

/**
 * Centralized logging object. Provides methods for logging at different levels
 * (debug, info, warn, error), and manages the current log level.
 */
export const log = {
  logLevel: LOG_LEVELS.INFO, // Default log level: INFO.

  /**
   * Sets the log level. Accepts either a string (case-insensitive)
   * or a numeric level from `LOG_LEVELS`. Handles invalid inputs gracefully.
   *
   * @param {string | number} level - The desired log level.
   */
  setLogLevel(level) {
    if (typeof level === 'string') {
      // Convert string to uppercase for case-insensitivity.
      this.logLevel = LOG_LEVELS[level.toUpperCase()] ?? this.logLevel;
    } else if (typeof level === 'number' && level >= LOG_LEVELS.ERROR && level <= LOG_LEVELS.DEBUG) {
      this.logLevel = level;
    }
    // If level is invalid, the existing log level is maintained.
  },

  /**
   * Logs a debug message. Only logs if the current log level is DEBUG.
   *
   * @param {object} context - The logging context.
   * @param {string} additionalInfo - Additional info for the log section.
   * @param {string} message - The log message.
   * @param  {...any} optionalParams - Optional parameters.
   */
  debug(context, additionalInfo, message, ...optionalParams) {
    if (this.logLevel >= LOG_LEVELS.DEBUG) {
      console.debug(formatLogMessage(message, context, additionalInfo, ...optionalParams));
    }
  },

  /**
   * Logs an info message. Logs if the current log level is INFO or DEBUG.
   *
   * @param {object} context - The logging context.
   * @param {string} additionalInfo - Additional info for the log section.
   * @param {string} message - The log message.
   * @param  {...any} optionalParams - Optional parameters.
   */
  info(context, additionalInfo, message, ...optionalParams) {
    if (this.logLevel >= LOG_LEVELS.INFO) {
      console.info(formatLogMessage(message, context, additionalInfo, ...optionalParams));
    }
  },

  /**
   * Logs a warning message. Logs if the current log level is WARN, INFO, or DEBUG.
   *
   * @param {object} context - The logging context.
   * @param {string} additionalInfo - Additional info for the log section.
   * @param {string} message - The log message.
   * @param  {...any} optionalParams - Optional parameters.
   */
  warn(context, additionalInfo, message, ...optionalParams) {
    if (this.logLevel >= LOG_LEVELS.WARN) {
      console.warn(formatLogMessage(message, context, additionalInfo, ...optionalParams));
    }
  },

  /**
   * Logs an error message. Always logs, regardless of the current log level.
   *
   * @param {object} context - The logging context.
   * @param {string} additionalInfo - Additional info for the log section.
   * @param {string} message - The log message.
   * @param  {...any} optionalParams - Optional parameters.
   */
  error(context, additionalInfo, message, ...optionalParams) {
    if (this.logLevel >= LOG_LEVELS.ERROR) {
      console.error(formatLogMessage(message, context, additionalInfo, ...optionalParams));
    }
  },
};
