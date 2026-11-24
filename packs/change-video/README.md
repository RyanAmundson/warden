# Change video

Enable the `change-video` pack to have an agent record a video of its UI change
before it pushes. The agent replays only the flow its diff changes. Warden
keeps the WebM and up to five keyframes with the run that checked the change,
and the dashboard plays them on that run's page. The agent checks its own work
with assertions and keyframes and never reads the video, which is for the
owner. A project that doesn't enable the pack records nothing:
`warden video record` refuses to run there.

Put `agent-browser` 0.26 or later
and `jq` on `PATH`. Add this entry under `packs` in `.warden/config.yaml`, run
`warden compile`, and sign the commit that changes `.warden/`:

```yaml
- id: change-video
  paths: []
```

The compiled `change-video` skill tells the agent when to record. Skip it for a
diff that changes nothing a person sees.

## Record a change

1. Run `warden check --base <base>` so that the checkout has a run for the
   change. The video belongs to the checkout's latest run. Pass `--run <id>` to
   `warden video record` to pick another run of the project.
2. Find the URL of the dev server that already serves this checkout. Start one
   only if none does, and stop it when you finish.
3. Write a steps file anywhere outside the repository, such as in your
   scratch folder. It covers only the flow your diff changes:

   ```bash
   ab wait '#save'                          # The page rendered.
   ab screenshot "$OUT/01-before.jpg"
   ab click '#save'
   ab wait --text 'Saved' --timeout 5000    # Fails the replay if it never appears.
   ab screenshot "$OUT/02-after.jpg"
   ```

4. Run the replay:

   ```bash
   warden video record --url http://localhost:5173/settings --steps <file>
   ```

5. If the replay fails, read the failing line. Fix the code when the app is
   wrong. Fix the steps file only when a selector or the expected text is wrong,
   and say which one you changed.
6. Read each keyframe that the command prints. Compare it with what the change
   must show: layout, copy, state, and nothing clipped or overlapping.

The steps file runs inside the recording, in Bash with `set -euo pipefail`, as
part of `packs/change-video/record.sh`. The wrapper sets the viewport to
1280 x 800, starts the recording at `--url`, stops it after your steps, closes
the browser on every exit, and fails the replay when the page threw an error.
`ab` runs `agent-browser` in the replay's own session. `wait <selector>` and
`wait --text` are the assertions: each fails the replay when its target never
appears. For other widths, run `ab set viewport <width> <height>` and take one
keyframe per width.

## Cost rules

The recording costs no tokens. Reading images does: a 1280 x 800 JPEG at
quality 60 costs about 1,400 input tokens.

- Never read the video, and never extract frames from it.
- Take five keyframes or fewer. Warden refuses a replay that takes more.
- Run the replay once per coherent change, not after every edit.
- Use `agent-browser snapshot -i` only to find selectors, scoped to the region
  you changed.
- Don't click through the app one tool call and one screenshot at a time.

## Where recordings live

Warden writes each recording to
`$WARDEN_HOME/videos/<project>/<run>/`, next to the Evidence in
`$WARDEN_HOME/evidence/`. A folder holds `change.webm` and the keyframes. The
folder name is the run ID, which is how a run links to its video. Recordings
are never inside the repository, so they are never committed. A new recording
for the same run replaces the old one. A failed replay keeps nothing.

The daemon serves the files at
`GET /api/video?project=<project>&run=<run>&file=<name>` and adds
`video: { file, keyframes }` to each recorded run in `GET /api/runs`. The run's
page on the dashboard shows the video with its keyframes as thumbnails. The
command prints that page's link.

## Report

State each item in one line:

- The command's exit code and any assertion that failed.
- What each keyframe shows, compared with what the change requires.
- The run page link, and the paths of the video, the keyframes, and the steps
  file.
- What the replay doesn't cover, such as other widths, empty states, or error
  states.

`gh` can't attach a video to a pull request. Give the pull request the run
page link, which works on the owner's machine.

## Limits

- The agent that built the change runs this check on its own work. It doesn't
  replace an independent UI review.
- The run page lists the project's last 100 runs. Once 100 newer runs land,
  open the video by its path instead.
- It covers web pages that agent-browser can open. For native or iOS apps, use
  the simulator's own screenshot and recording tools.
