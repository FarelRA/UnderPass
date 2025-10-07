// =================================================================
// File: lib/logger.js
// Description: Structured logging utility.
// =================================================================

export const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, TRACE: 4 };

let globalLogContext = {};

function formatLogMessage(level, section, message, ...optionalParams) {
  try {
    const timestamp = new Date().toISOString();
    const { logId = 'N/A', clientIP = 'N/A', remoteAddress, remotePort } = globalLogContext;
    const remote = remoteAddress && remotePort ? `[Remote: ${remoteAddress}:${remotePort}] ` : '';
    const optionalData = optionalParams.length > 0 ? ` ${JSON.stringify(optionalParams)}` : '';
    return `[${timestamp}] [${level}] [${logId}] [${section}] [Client: ${clientIP}] ${remote}${message}${optionalData}`;
  } catch (error) {
    return `[LOGGER] Failed to format log message: ${error.message}`;
  }
}

export const logger = {
  logLevel: LOG_LEVELS.INFO,
  setLogContext(context) {
    globalLogContext = { ...context };
  },
  updateLogContext(context) {
    globalLogContext = { ...globalLogContext, ...context };
  },
  setLogLevel(level) {
    try {
      if (!level) {
        console.warn('[LOGGER] setLogLevel called with null/undefined level');
        return;
      }
      const upperLevel = String(level).toUpperCase();
      if (upperLevel in LOG_LEVELS) {
        this.logLevel = LOG_LEVELS[upperLevel];
      } else {
        console.warn(`[LOGGER] Invalid log level: ${level}`);
      }
    } catch (error) {
      console.error(`[LOGGER] setLogLevel error: ${error.message}`);
    }
  },
  debug(section, message, ...optionalParams) {
    try {
      if (this.logLevel >= LOG_LEVELS.DEBUG) {
        console.debug(formatLogMessage('DEBUG', section, message, ...optionalParams));
      }
    } catch (error) {
      console.error(`[LOGGER] debug error: ${error.message}`);
    }
  },
  info(section, message, ...optionalParams) {
    try {
      if (this.logLevel >= LOG_LEVELS.INFO) {
        console.info(formatLogMessage('INFO', section, message, ...optionalParams));
      }
    } catch (error) {
      console.error(`[LOGGER] info error: ${error.message}`);
    }
  },
  warn(section, message, ...optionalParams) {
    try {
      if (this.logLevel >= LOG_LEVELS.WARN) {
        console.warn(formatLogMessage('WARN', section, message, ...optionalParams));
      }
    } catch (error) {
      console.error(`[LOGGER] warn error: ${error.message}`);
    }
  },
  error(section, message, ...optionalParams) {
    try {
      if (this.logLevel >= LOG_LEVELS.ERROR) {
        console.error(formatLogMessage('ERROR', section, message, ...optionalParams));
      }
    } catch (error) {
      console.error(`[LOGGER] error logging failed: ${error.message}`);
    }
  },
  trace(section, message, ...optionalParams) {
    try {
      if (this.logLevel >= LOG_LEVELS.TRACE) {
        console.log(formatLogMessage('TRACE', section, message, ...optionalParams));
      }
    } catch (error) {
      console.error(`[LOGGER] trace error: ${error.message}`);
    }
  },
};

/**
 * Generates a short, random log ID to correlate request logs.
 * @returns {string} A 6-character base-36 log ID.
 */
export function generateLogId() {
  try {
    return Math.random().toString(36).substring(2, 8);
  } catch (error) {
    console.error(`[LOGGER] generateLogId error: ${error.message}`);
    throw new Error(`Failed to generate log ID: ${error.message}`);
  }
}
