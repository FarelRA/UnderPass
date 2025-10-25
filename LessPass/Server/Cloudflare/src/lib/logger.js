// =================================================================
// File: lib/logger.js
// Description: Structured logging utility with multiple log levels.
//              Provides contextual logging with request IDs, client IPs,
//              and remote addresses for comprehensive observability.
// =================================================================

/**
 * Log level constants.
 * Higher numbers include all lower levels.
 * ERROR (0) < WARN (1) < INFO (2) < DEBUG (3) < TRACE (4)
 */
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, TRACE: 4 };

/**
 * Formats a log message with context information.
 * Includes log level, request ID, section, client IP, and optional remote address.
 *
 * @param {string} level - The log level (ERROR, WARN, INFO, DEBUG, TRACE).
 * @param {string} section - The code section/module generating the log.
 * @param {string} message - The log message.
 * @param {object} context - Contextual information (logId, clientIP, remoteAddress, remotePort).
 * @param {Array} optionalParams - Additional parameters to append to the message.
 * @returns {string} Formatted log message.
 */
function formatLogMessage(level, section, message, context, optionalParams) {
  const { logId = 'N/A', clientIP = 'N/A', remoteAddress, remotePort } = context;
  const remote = remoteAddress && remotePort ? `[Remote: ${remoteAddress}:${remotePort}] ` : '';
  const optional = optionalParams.length ? ` ${optionalParams.join(' ')}` : '';
  return `[${level}] [${logId}] [${section}] [Client: ${clientIP}] ${remote}${message}${optional}`;
}

/**
 * Logger instance with contextual logging capabilities.
 * Supports five log levels: ERROR, WARN, INFO, DEBUG, TRACE.
 * 
 * Usage:
 * - logger.setLogLevel('DEBUG') - Set logging verbosity
 * - logger.setLogContext({ logId, clientIP }) - Set request context
 * - logger.updateLogContext({ remoteAddress, remotePort }) - Update context
 * - logger.error('SECTION', 'message') - Log error
 * - logger.warn('SECTION', 'message') - Log warning
 * - logger.info('SECTION', 'message') - Log info
 * - logger.debug('SECTION', 'message') - Log debug
 * - logger.trace('SECTION', 'message') - Log trace
 */
export const logger = {
  logLevel: LOG_LEVELS.INFO,
  context: {},

  /**
   * Sets the logging level.
   * Only messages at or below this level will be logged.
   *
   * @param {string} level - The log level (ERROR, WARN, INFO, DEBUG, TRACE).
   */
  setLogLevel(level) {
    const upperLevel = String(level).toUpperCase();
    if (upperLevel in LOG_LEVELS) {
      this.logLevel = LOG_LEVELS[upperLevel];
    }
  },

  /**
   * Sets the logging context for the current request.
   * Replaces the entire context object.
   *
   * @param {object} context - Context object with logId, clientIP, etc.
   */
  setLogContext(context) {
    this.context = context;
  },

  /**
   * Updates the logging context with additional information.
   * Merges new properties into the existing context.
   *
   * @param {object} context - Additional context properties to merge.
   */
  updateLogContext(context) {
    Object.assign(this.context, context);
  },

  /**
   * Logs an ERROR level message.
   * Use for critical errors that require immediate attention.
   *
   * @param {string} section - The code section generating the log.
   * @param {string} message - The error message.
   * @param {...any} optionalParams - Additional parameters.
   */
  error(section, message, ...optionalParams) {
    if (this.logLevel >= LOG_LEVELS.ERROR) {
      console.error(formatLogMessage('ERROR', section, message, this.context, optionalParams));
    }
  },

  /**
   * Logs a WARN level message.
   * Use for recoverable errors or unexpected situations.
   *
   * @param {string} section - The code section generating the log.
   * @param {string} message - The warning message.
   * @param {...any} optionalParams - Additional parameters.
   */
  warn(section, message, ...optionalParams) {
    if (this.logLevel >= LOG_LEVELS.WARN) {
      console.warn(formatLogMessage('WARN', section, message, this.context, optionalParams));
    }
  },

  /**
   * Logs an INFO level message.
   * Use for important operational events.
   *
   * @param {string} section - The code section generating the log.
   * @param {string} message - The info message.
   * @param {...any} optionalParams - Additional parameters.
   */
  info(section, message, ...optionalParams) {
    if (this.logLevel >= LOG_LEVELS.INFO) {
      console.info(formatLogMessage('INFO', section, message, this.context, optionalParams));
    }
  },

  /**
   * Logs a DEBUG level message.
   * Use for detailed debugging information.
   *
   * @param {string} section - The code section generating the log.
   * @param {string} message - The debug message.
   * @param {...any} optionalParams - Additional parameters.
   */
  debug(section, message, ...optionalParams) {
    if (this.logLevel >= LOG_LEVELS.DEBUG) {
      console.debug(formatLogMessage('DEBUG', section, message, this.context, optionalParams));
    }
  },

  /**
   * Logs a TRACE level message.
   * Use for very detailed debugging information (byte counts, iterations, etc).
   *
   * @param {string} section - The code section generating the log.
   * @param {string} message - The trace message.
   * @param {...any} optionalParams - Additional parameters.
   */
  trace(section, message, ...optionalParams) {
    if (this.logLevel >= LOG_LEVELS.TRACE) {
      console.log(formatLogMessage('TRACE', section, message, this.context, optionalParams));
    }
  },
};

/**
 * Generates a short, random log ID to correlate request logs.
 * Uses base-36 encoding for compact, readable IDs.
 *
 * @returns {string} A 6-character uppercase base-36 log ID.
 * @example
 * generateLogId(); // "A3F9K2"
 */
export function generateLogId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}
