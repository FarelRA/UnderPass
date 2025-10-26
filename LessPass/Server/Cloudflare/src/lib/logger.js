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
 * @param {Array} params - Additional parameters to append to the message.
 * @returns {string} Formatted log message.
 */
function formatMessage(level, section, message, context, params) {
  const { logId = 'N/A', clientIP = 'N/A', remoteAddress, remotePort } = context;
  const remote = remoteAddress && remotePort ? `[Remote: ${remoteAddress}:${remotePort}] ` : '';
  const additional = params.length ? ` ${params.join(' ')}` : '';
  return `[${level}] [${logId}] [${section}] [Client: ${clientIP}] ${remote}${message}${additional}`;
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
    const upper = String(level).toUpperCase();
    if (upper in LOG_LEVELS) {
      this.logLevel = LOG_LEVELS[upper];
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
   * @param {...any} params - Additional parameters.
   */
  error(section, message, ...params) {
    if (this.logLevel >= LOG_LEVELS.ERROR) {
      console.error(formatMessage('ERROR', section, message, this.context, params));
    }
  },

  /**
   * Logs a WARN level message.
   * Use for recoverable errors or unexpected situations.
   *
   * @param {string} section - The code section generating the log.
   * @param {string} message - The warning message.
   * @param {...any} params - Additional parameters.
   */
  warn(section, message, ...params) {
    if (this.logLevel >= LOG_LEVELS.WARN) {
      console.warn(formatMessage('WARN', section, message, this.context, params));
    }
  },

  /**
   * Logs an INFO level message.
   * Use for important operational events.
   *
   * @param {string} section - The code section generating the log.
   * @param {string} message - The info message.
   * @param {...any} params - Additional parameters.
   */
  info(section, message, ...params) {
    if (this.logLevel >= LOG_LEVELS.INFO) {
      console.info(formatMessage('INFO', section, message, this.context, params));
    }
  },

  /**
   * Logs a DEBUG level message.
   * Use for detailed debugging information.
   *
   * @param {string} section - The code section generating the log.
   * @param {string} message - The debug message.
   * @param {...any} params - Additional parameters.
   */
  debug(section, message, ...params) {
    if (this.logLevel >= LOG_LEVELS.DEBUG) {
      console.debug(formatMessage('DEBUG', section, message, this.context, params));
    }
  },

  /**
   * Logs a TRACE level message.
   * Use for very detailed debugging information (byte counts, iterations, etc).
   *
   * @param {string} section - The code section generating the log.
   * @param {string} message - The trace message.
   * @param {...any} params - Additional parameters.
   */
  trace(section, message, ...params) {
    if (this.logLevel >= LOG_LEVELS.TRACE) {
      console.log(formatMessage('TRACE', section, message, this.context, params));
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
