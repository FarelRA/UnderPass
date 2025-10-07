// =================================================================
// File: lib/logger.js
// Description: Structured logging utility.
// =================================================================

export const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, TRACE: 4 };

let globalLogContext = {};

function formatLogMessage(level, message, context = {}, additionalInfo = '', ...optionalParams) {
  try {
    const timestamp = new Date().toISOString();
    const mergedContext = { ...globalLogContext, ...context };
    const { logId = 'N/A', section = 'N/A', clientIP = 'N/A', remoteAddress, remotePort } = mergedContext;
    const fullSection = additionalInfo ? `${section}:${additionalInfo}` : section;
    const remote = remoteAddress && remotePort ? `[Remote: ${remoteAddress}:${remotePort}] ` : '';
    const optionalData = optionalParams.length > 0 ? ` ${JSON.stringify(optionalParams)}` : '';
    return `[${timestamp}] [${level}] [${logId}] [${fullSection}] [Client: ${clientIP}] ${remote}${message}${optionalData}`;
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
  debug(context, additionalInfo, message, ...optionalParams) {
    try {
      if (this.logLevel >= LOG_LEVELS.DEBUG) {
        console.debug(formatLogMessage('DEBUG', message, context, additionalInfo, ...optionalParams));
      }
    } catch (error) {
      console.error(`[LOGGER] debug error: ${error.message}`);
    }
  },
  info(context, additionalInfo, message, ...optionalParams) {
    try {
      if (this.logLevel >= LOG_LEVELS.INFO) {
        console.info(formatLogMessage('INFO', message, context, additionalInfo, ...optionalParams));
      }
    } catch (error) {
      console.error(`[LOGGER] info error: ${error.message}`);
    }
  },
  warn(context, additionalInfo, message, ...optionalParams) {
    try {
      if (this.logLevel >= LOG_LEVELS.WARN) {
        console.warn(formatLogMessage('WARN', message, context, additionalInfo, ...optionalParams));
      }
    } catch (error) {
      console.error(`[LOGGER] warn error: ${error.message}`);
    }
  },
  error(context, additionalInfo, message, ...optionalParams) {
    try {
      if (this.logLevel >= LOG_LEVELS.ERROR) {
        console.error(formatLogMessage('ERROR', message, context, additionalInfo, ...optionalParams));
      }
    } catch (error) {
      console.error(`[LOGGER] error logging failed: ${error.message}`);
    }
  },
  trace(context, additionalInfo, message, ...optionalParams) {
    try {
      if (this.logLevel >= LOG_LEVELS.TRACE) {
        console.log(formatLogMessage('TRACE', message, context, additionalInfo, ...optionalParams));
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
    return 'ERROR';
  }
}
