// Loads jsnes lazily so that tools that do not emulate (diff, movie parsing) work without it.

let modulePromise = null;

export class JsnesMissingError extends Error {}

export function loadJsnes() {
  modulePromise ??= import('jsnes').catch((err) => {
    modulePromise = null;
    throw new JsnesMissingError(
      'jsnes is not installed. Run `npm install` in tools/oracle (or at the repo root once jsnes ' +
        `is a root devDependency). Cause: ${err.message}`,
    );
  });
  return modulePromise;
}

export async function hasJsnes() {
  try {
    await loadJsnes();
    return true;
  } catch {
    return false;
  }
}
