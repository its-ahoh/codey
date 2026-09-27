// Electron in RUN_AS_NODE mode still advertises process.versions.electron.
// Commander needs defaultApp=true to parse [executable, script, ...args].
const { pathToFileURL } = require('node:url');
const { isAbsolute } = require('node:path');
const cli = process.argv[2];
if (!cli || !isAbsolute(cli)) throw new Error('An absolute Co-memo CLI path is required');
process.defaultApp = true;
process.argv.splice(1, 1);
import(pathToFileURL(cli).href).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
