// Custom node:test reporter: one compact JSON object per line, consumed by parseNodeTestEvents.
// Used as: node --test --test-reporter=<abs path to this file> <files>
import path from 'node:path';

const cwd = process.cwd();
const absFile = (f) => (f ? path.resolve(cwd, f) : undefined);
/** File-level tests (one per file run in its own process) are named after the path passed on the command line. */
const isFileLevel = (d) => d.nesting === 0 && !!d.file && absFile(d.name) === absFile(d.file);

function errorText(err) {
  if (!err) return undefined;
  const cause = err.cause;
  const text = cause instanceof Error ? (cause.stack || cause.message) : (cause !== undefined ? String(cause) : err.message);
  return String(text ?? '').slice(0, 4000);
}

/** @param {AsyncIterable<{ type: string, data: any }>} source */
export default async function* trustKitReporter(source) {
  // Errors caught outside any test (e.g. a top-level `await import()` failing after tests ran) arrive as
  // test:diagnostic events without a `file`. A file's events are replayed in order and end with its
  // test:summary (which has a `file`), so pending diagnostics are attributed to the next file summary.
  // The run's final count diagnostics ("tests 3", ...) come after every file summary and are dropped.
  let pendingDiagnostics = [];
  for await (const { type, data: d } of source) {
    if (type === 'test:diagnostic' && !d.file) {
      pendingDiagnostics.push(String(d.message ?? ''));
    } else if (type === 'test:summary' && d.file) {
      for (const message of pendingDiagnostics) {
        yield `${JSON.stringify({ type: 'diagnostic', file: absFile(d.file), message })}\n`;
      }
      pendingDiagnostics = [];
    } else if (type === 'test:diagnostic' && d.file) {
      yield `${JSON.stringify({ type: 'diagnostic', file: absFile(d.file), message: String(d.message ?? '') })}\n`;
    } else if (type === 'test:pass' || type === 'test:fail') {
      yield `${JSON.stringify({
        type: type === 'test:pass' ? 'pass' : 'fail',
        name: d.name,
        file: absFile(d.file),
        nesting: d.nesting,
        isFile: isFileLevel(d),
        suite: d.details?.type === 'suite',
        skip: d.skip !== undefined && d.skip !== false,
        todo: d.todo !== undefined && d.todo !== false,
        failureType: d.details?.error?.failureType,
        message: errorText(d.details?.error),
      })}\n`;
    } else if (type === 'test:complete' && isFileLevel(d) && d.details?.passed === false) {
      // A file that produced test results only reports its own failure via test:complete.
      yield `${JSON.stringify({
        type: 'fail', name: d.name, file: absFile(d.file), nesting: 0, isFile: true, suite: false,
        skip: false, todo: false, failureType: d.details?.error?.failureType, message: errorText(d.details?.error),
      })}\n`;
    } else if (type === 'test:stderr' && d.file) {
      yield `${JSON.stringify({ type: 'stderr', file: absFile(d.file), message: d.message })}\n`;
    }
  }
}
