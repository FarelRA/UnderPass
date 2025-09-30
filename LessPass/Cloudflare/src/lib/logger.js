// =================================================================
// File: lib/logger.js
// Description: Structured logging utility.
// =================================================================

export const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };

function formatLogMessage(level, message, context = {}, additionalInfo = '', ...optionalParams) {
  const timestamp = new Date().toISOString();
  const { logId = 'N/A', section = 'N/A', clientIP = 'N/A', remoteAddress, remotePort } = context;
  const fullSection = additionalInfo ? `${section}:${additionalInfo}` : section;
  const remote = remoteAddress && remotePort ? `[Remote: ${remoteAddress}:${remotePort}]` : '';
  const optionalData = optionalParams.length > 0 ? ` ${JSON.stringify(optionalParams)}` : '';
  return `[${timestamp}] [${level}] [${logId}] [${fullSection}] [Client: ${clientIP}]${remote} ${message}${optionalData}`;
}

export const logger = {
  logLevel: LOG_LEVELS.INFO,
  setLogLevel(level) {
    if (typeof level === 'string') {
      this.logLevel = LOG_LEVELS[level.toUpperCase()] ?? this.logLevel;
    } else if (typeof level === 'number' && level >= LOG_LEVELS.ERROR && level <= LOG_LEVELS.DEBUG) {
      this.logLevel = level;
    }
  },
  debug(context, additionalInfo, message, ...optionalParams) {
    if (this.logLevel >= LOG_LEVELS.DEBUG) {
      console.debug(formatLogMessage('DEBUG', message, context, additionalInfo, ...optionalParams));
    }
  },
  info(context, additionalInfo, message, ...optionalParams) {
    if (this.logLevel >= LOG_LEVELS.INFO) {
      console.info(formatLogMessage('INFO', message, context, additionalInfo, ...optionalParams));
    }
  },
  warn(context, additionalInfo, message, ...optionalParams) {
    if (this.logLevel >= LOG_LEVELS.WARN) {
      console.warn(formatLogMessage('WARN', message, context, additionalInfo, ...optionalParams));
    }
  },
  error(context, additionalInfo, message, ...optionalParams) {
    if (this.logLevel >= LOG_LEVELS.ERROR) {
      console.error(formatLogMessage('ERROR', message, context, additionalInfo, ...optionalParams));
    }
  },
};

/**
 * Generates a short, random log ID to correlate request logs.
 * @returns {string} A 6-character base-36 log ID.
 */
export function generateLogId() {
  return Math.random().toString(36).substring(2, 8);
}
