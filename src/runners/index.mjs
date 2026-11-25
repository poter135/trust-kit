// The only entry point into the runner adapters; code outside src/runners/ imports this file alone.
import { flutterRunner, parseFlutterMachine } from './flutter.mjs';
import { jestRunner, parseJestJson } from './jest.mjs';
import { nodeTestRunner, parseNodeTestEvents } from './node-test.mjs';

/** @typedef {import('./common.mjs').TestResult} TestResult */
/** @typedef {import('./common.mjs').RunOptions} RunOptions */
/** @typedef {import('./common.mjs').Runner} Runner */

const RUNNERS = { flutter: flutterRunner, jest: jestRunner, 'node-test': nodeTestRunner };

/**
 * @param {string} adapter one of RunnerConfig.adapter
 * @returns {Runner}
 */
export function getRunner(adapter) {
  if (!Object.hasOwn(RUNNERS, adapter)) {
    throw new Error(`unknown adapter "${adapter}"; supported: ${Object.keys(RUNNERS).join(', ')}`);
  }
  return RUNNERS[adapter];
}

export { parseFlutterMachine, parseJestJson, parseNodeTestEvents };
