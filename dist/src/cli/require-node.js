import { requireNode25 } from "./node-version.js";
try {
    requireNode25(process.versions.node);
}
catch (cause) {
    process.stderr.write(`${cause.message}\n`);
    process.exit(2);
}
