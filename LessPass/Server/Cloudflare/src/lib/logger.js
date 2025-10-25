// =================================================================
// File: lib/logger.js
// Description: Structured logging utility.
// =================================================================

const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, TRACE: 4 };

function formatLogMessage(level, section, message, context, optionalParams) {
  const { logId = 'N/A', clientIP = 'N/A', remoteAddress, remotePort } = context;
  const remote = remoteAddress && remotePort ? `[Remote: ${remoteAddress}:${remotePort}] ` : '';
  const optional = optionalParams.length ? ` ${optionalParams.join(' ')}` : '';
  return `[${level}] [${logId}] [${section}] [Client: ${clientIP}] ${remote}${message}${optional}`;
}

export const logger = {
  logLevel: LOG_LEVELS.INFO,
  context: {},

  setLogLevel(level) {
    const upperLevel = String(level).toUpperCase();
    if (upperLevel in LOG_LEVELS) {
      this.logLevel = LOG_LEVELS[upperLevel];
    }
  },

  setLogContext(context) {
    this.context = context;
  },

  updateLogContext(context) {
    Object.assign(this.context, context);
  },

  error(section, message, ...optionalParams) {
    if (this.logLevel >= LOG_LEVELS.ERROR) {
      console.error(formatLogMessage('ERROR', section, message, this.context, optionalParams));
    }
  },

  warn(section, message, ...optionalParams) {
    if (this.logLevel >= LOG_LEVELS.WARN) {
      console.warn(formatLogMessage('WARN', section, message, this.context, optionalParams));
    }
  },

  info(section, message, ...optionalParams) {
    if (this.logLevel >= LOG_LEVELS.INFO) {
      console.info(formatLogMessage('INFO', section, message, this.context, optionalParams));
    }
  },

  debug(section, message, ...optionalParams) {
    if (this.logLevel >= LOG_LEVELS.DEBUG) {
      console.debug(formatLogMessage('DEBUG', section, message, this.context, optionalParams));
    }
  },

  trace(section, message, ...optionalParams) {
    if (this.logLevel >= LOG_LEVELS.TRACE) {
      console.log(formatLogMessage('TRACE', section, message, this.context, optionalParams));
    }
  },
};

/**
 * Generates a short, random log ID to correlate request logs.
 * @returns {string} A 6-character uppercase base-36 log ID.
 */
export function generateLogId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}
