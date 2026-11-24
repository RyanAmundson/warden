import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadRecords } from "../records/load.js";
import { DEFAULT_PORT, readHeartbeat } from "../runner/daemon.js";
import { readEvidence, wardenHome } from "../runner/evidence.js";
import { runRecords } from "./runs.js";

export const PACK = "change-video";

export const VIDEO = "change.webm";

export const MAX_KEYFRAMES = 5;

export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const VIDEO_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:webm|jpg)$/;

const KEYFRAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.jpg$/;

export interface Recording {
  file: string;
  keyframes: string[];
}

export const videosRoot = (project: string): string => join(wardenHome(), "videos", project);

const list = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
};

const keyframesIn = (dir: string): string[] => list(dir).filter((f) => f !== VIDEO).sort();

export function recordingOf(project: string, run: string): Recording | undefined {
  const dir = join(videosRoot(project), run);
  return SAFE_NAME.test(run) && existsSync(join(dir, VIDEO)) ? { file: VIDEO, keyframes: keyframesIn(dir).filter((f) => KEYFRAME.test(f)) } : undefined;
}

export interface RecordOptions {
  url: string;
  steps: string;
}

export async function runVideoRecord(root: string, wardenRoot: string, opts: RecordOptions): Promise<number> {
  const set = await loadRecords(root, wardenRoot);
  const { project } = set.config;
  if (!set.packs.some((p) => p.id === PACK)) {
    throw new Error(`the ${PACK} pack is not enabled in ${project}, so Warden records no video. Next action: add ${PACK} under packs in .warden/config.yaml, run warden compile, and sign the commit`);
  }
  const url = URL.canParse(opts.url) ? new URL(opts.url) : undefined;
  if (url === undefined || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error(`--url must be an http or https URL, not ${opts.url}. Next action: pass the dev server page your change affects, such as --url http://localhost:5173/settings`);
  }
  const steps = resolve(opts.steps);
  if (!existsSync(steps)) throw new Error(`${steps} does not exist. Next action: write the replay steps there; run warden video record --help for the format`);
  const run = runRecords(readEvidence(project)).filter((r) => r.root === root).at(-1);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (run?.run === undefined || run.commit !== head) {
    throw new Error(`${run === undefined ? `no Warden run is recorded for ${root}` : `this checkout's latest run checked ${run.commit ?? "an unrecorded commit"}, not HEAD ${head}`}, so the video has no run to belong to. Next action: run warden check --base ${set.config.base}, then run warden video record again`);
  }
  if (!SAFE_NAME.test(run.run)) throw new Error(`run id ${run.run} cannot name a folder. Next action: run warden check --base ${set.config.base} for a new run, then record again`);
  const dir = join(videosRoot(project), run.run);
  const partial = join(videosRoot(project), `.partial-${run.run}-${process.pid}`);
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  try {
    const replay = spawnSync("bash", [join(wardenRoot, "packs", PACK, "record.sh")], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, URL: url.href, OUT: partial, STEPS: steps, SESSION: `${PACK}-${process.pid}` },
    });
    if (replay.error !== undefined) throw replay.error;
    if (replay.status !== 0) {
      process.stderr.write(`The replay exited ${replay.status ?? replay.signal}, so no video was kept. Next action: read the failing line above; fix the app when it is wrong, or the steps file only when a selector or expected text is wrong, then run warden video record again\n`);
      return 1;
    }
    if (!existsSync(join(partial, VIDEO)) || statSync(join(partial, VIDEO)).size === 0) {
      process.stderr.write(`The replay wrote no ${VIDEO}. Next action: keep ab record stop out of the steps file, then run warden video record again\n`);
      return 1;
    }
    const keyframes = keyframesIn(partial);
    const other = keyframes.find((f) => !KEYFRAME.test(f));
    if (other !== undefined) {
      process.stderr.write(`The steps wrote ${other}, which the run page cannot show. Next action: save keyframes as "$OUT/NN-name.jpg" and write nothing else to $OUT, then run warden video record again\n`);
      return 1;
    }
    if (keyframes.length > MAX_KEYFRAMES) {
      process.stderr.write(`The steps took ${keyframes.length} keyframes; the limit is ${MAX_KEYFRAMES}. Next action: drop the screenshots that show nothing new, then run warden video record again\n`);
      return 1;
    }
    rmSync(dir, { recursive: true, force: true });
    renameSync(partial, dir);
    const port = readHeartbeat()?.port ?? DEFAULT_PORT;
    process.stdout.write([
      `Recorded run ${run.run} of ${project}.`,
      `Video for the owner (never read it): ${join(dir, VIDEO)}`,
      ...(keyframes.length === 0 ? ["No keyframes. Add ab screenshot \"$OUT/01-name.jpg\" to the steps to see the result."] : ["Keyframes to read and compare with what the change must show:", ...keyframes.map((k) => `  ${join(dir, k)}`)]),
      `Watch it: http://127.0.0.1:${port}/run?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run.run)}`,
      "",
    ].join("\n"));
    return 0;
  } finally {
    rmSync(partial, { recursive: true, force: true });
  }
}
