// pipe.js
import { log } from './logs.js';

/**
 * Creates a symmetrical, bidirectional pipe between two transports.
 * Handles graceful shutdown and error propagation.
 * @param {object} transportA - The first transport { readable, writable }.
 * @param {object} transportB - The second transport { readable, writable }.
 */
export function pipeStreams(transportA, transportB, logContext) {
  const pipeLogContext = { ...logContext, section: 'PIPE' };
  let hasClosed = false;

  const closePipes = () => {
    if (hasClosed) return;
    hasClosed = true;
    log.debug(pipeLogContext, 'CLOSE', 'Closing pipes.');
    // The streams API should handle closing writable streams automatically on pipe completion.
    // We can add explicit aborts if needed for more aggressive cleanup.
  };

  const pipe1 = transportA.readable.pipeTo(transportB.writable).catch((err) => {
    log.error(pipeLogContext, 'A->B:ERROR', 'Pipe A->B failed:', err);
  });

  const pipe2 = transportB.readable.pipeTo(transportA.writable).catch((err) => {
    log.error(pipeLogContext, 'B->A:ERROR', 'Pipe B->A failed:', err);
  });

  Promise.all([pipe1, pipe2]).finally(closePipes);
}
