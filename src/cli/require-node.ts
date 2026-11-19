import { requireNode25 } from "./node-version.js";

try {
  requireNode25(process.versions.node);
} catch (cause) {
  process.stderr.write(`${(cause as Error).message}\n`);
  process.exit(2);
}
