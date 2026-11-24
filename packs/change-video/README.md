# Change video

Enable the `change-video` pack to have an agent record a video of its UI change
before it pushes. The agent replays only the flow its diff changes. Warden
keeps the WebM and up to five keyframes with the run that checked the change,
and the dashboard plays them on that run's page. The agent checks its own work
with assertions and keyframes and never reads the video, which is for the
owner. A project that doesn't enable the pack records nothing:
`warden video record` refuses to run there.

Put `agent-browser` 0.26 or later and `jq` on `PATH`. Add this entry under
`packs` in `.warden/config.yaml`, run `warden compile`, and sign the commit
that changes `.warden/`:

```yaml
- id: change-video
  paths: []
```

## Record a change

The compiled `change-video` skill gives the agent three steps:

1. `warden check --base <base>`, so that the checkout has a run for `HEAD`.
2. `warden video record --help`, which gives the steps file format, the cost
   rules, and the report format.
3. `warden video record --url <url> --steps <file>`.

The steps file runs inside `packs/change-video/record.sh`, in Bash with
`set -euo pipefail`. The wrapper sets the viewport to 1280 x 800, saves
screenshots as JPEG at quality 60, starts the recording at `--url`, stops it
after the steps, closes the browser on every exit, and fails the replay when
the page threw an error. Warden refuses more than five keyframes and keeps
nothing from a failed replay.

## Where recordings live

Each recording is in `$WARDEN_HOME/videos/<project>/<run>/`, next to the
Evidence in `$WARDEN_HOME/evidence/`. A folder holds `change.webm` and the
keyframes. The folder name is the run ID, which is how a run links to its
video. The run is the checkout's latest run, and it must have checked the
current `HEAD`. Recordings are never inside the repository, so they are never
committed. A new recording for the same run replaces the old one.

The daemon serves the files at
`GET /api/video?project=<project>&run=<run>&file=<name>` and adds
`video: { file, keyframes }` to each recorded run in `GET /api/runs`. The run's
page on the dashboard shows the video with its keyframes as thumbnails. The
command prints that page's link. `gh` can't attach a video to a pull request.

## Limits

- The agent that built the change runs this check on its own work. It doesn't
  replace an independent UI review.
- The run page lists the project's last 100 runs. Once 100 newer runs land,
  open the video by its path instead.
- Warden never deletes recordings. Remove old folders under
  `$WARDEN_HOME/videos/` by hand.
- It covers web pages that agent-browser can open. For native or iOS apps, use
  the simulator's own screenshot and recording tools.
