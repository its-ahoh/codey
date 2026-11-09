// Read at runtime rather than imported: `rootDir` is ./src, and ../package.json
// resolves to this package from both src/ and dist/.
export const { version: CODEY_VERSION } = require('../package.json') as { version: string };
