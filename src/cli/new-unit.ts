import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parseDocument } from "yaml";
import { RecordError, loadRecords, parseConfig, validateUnits } from "../records/load.js";
import type { UnitDeclaration } from "../records/types.js";

const requireDirectory = (dir: string): void => {
  if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} must be a real directory to scaffold a Unit.`);
};

function takeLock(lock: string): number {
  try {
    return openSync(lock, "wx");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    const owner = readFileSync(lock, "utf8").trim();
    const processInfo = /^\d+$/.test(owner) ? `process ${owner}` : "the previous scaffold process";
    throw new Error(`A Unit scaffold already holds ${lock}. Next action: wait for ${processInfo} to exit. If it already exited, remove its leftover lock and rerun warden new unit.`);
  }
}

function createDocument(doc: string): number {
  try {
    return openSync(doc, "wx");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    throw new Error(`A document already exists at ${doc}. Next action: declare this Unit in .warden/config.yaml to keep the existing document.`);
  }
}

function makeFolders(root: string, folder: string, created: string[]): void {
  let dir = root;
  for (const part of folder === "." ? [] : folder.split("/")) {
    dir = join(dir, part);
    try {
      mkdirSync(dir);
      created.push(dir);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      requireDirectory(dir);
    }
  }
}

export async function runNewUnit(root: string, wardenRoot: string, unit: UnitDeclaration): Promise<number> {
  const control = join(root, ".warden");
  const config = join(control, "config.yaml");
  requireDirectory(control);
  const lock = join(control, "unit-scaffold.lock");
  const temp = join(control, `config.unit-${process.pid}.tmp`);
  const cancelled = new AbortController();
  const stop = (): void => cancelled.abort(new Error("Unit scaffolding was interrupted."));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let lockFd: number | undefined;
  const folders: string[] = [];
  let stagedConfig = false;
  let writtenDocument: string | undefined;
  let documentPath: string;
  try {
    lockFd = takeLock(lock);
    writeFileSync(lockFd, `${process.pid}\n`);
    const mode = lstatSync(config);
    if (!mode.isFile() || mode.nlink !== 1) throw new RecordError(config, "", "Use a regular project-owned config file.");
    const source = readFileSync(config, "utf8");
    const { config: records, packs, unitIgnoreCase } = await loadRecords(root, wardenRoot);
    cancelled.signal.throwIfAborted();
    if (records.units === undefined) {
      throw new RecordError(config, "/units", "Declare the project Units in .warden/config.yaml before scaffolding. Add units: [] for a new project.");
    }
    const amended = parseDocument(source);
    amended.addIn(["units"], unit);
    const output = String(amended);
    const next = parseConfig(config, output);
    validateUnits(config, next, packs, unitIgnoreCase === true);
    const kind = next.unitKinds![unit.kind]!;
    documentPath = posix.join(unit.folder, kind.document);
    const doc = join(root, documentPath);

    makeFolders(root, unit.folder, folders);
    const stageFd = openSync(temp, "wx", mode.mode & 0o777);
    stagedConfig = true;
    try {
      writeFileSync(stageFd, output);
    } finally {
      closeSync(stageFd);
    }

    const docFd = createDocument(doc);
    writtenDocument = doc;
    try {
      writeFileSync(docFd, [`# ${unit.id}`, ...kind.sections.map((section) => `## ${section}`), ""].join("\n\n"));
    } finally {
      closeSync(docFd);
    }
    if (readFileSync(config, "utf8") !== source) {
      throw new RecordError(config, "", "The config changed during scaffolding. Run the command again.");
    }
    renameSync(temp, config);
    stagedConfig = false;
  } catch (cause) {
    if (writtenDocument !== undefined) unlinkSync(writtenDocument);
    for (const folder of folders.reverse()) {
      try {
        rmdirSync(folder);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw cleanupError;
      }
    }
    throw cause;
  } finally {
    try {
      if (stagedConfig) unlinkSync(temp);
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      if (lockFd !== undefined) {
        closeSync(lockFd);
        unlinkSync(lock);
      }
    }
  }
  process.stdout.write(`${unit.id}\t${documentPath}\n`);
  return 0;
}
