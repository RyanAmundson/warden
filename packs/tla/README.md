# TLA+ protocol checks

Enable the `tla` pack to check one finite TLA+ model at the boundary. Put Java on `PATH` and set `WARDEN_TLC_JAR` to the absolute path of the official [TLC 1.7.4 JAR](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4). Warden checks the JAR against the pack's SHA-256 pin before starting Java.

Add this entry under `packs` in `.warden/config.yaml` and run `warden compile`. Activate the configuration and lock with a signed policy change.

```yaml
- id: tla
  paths: []
  settings:
    model: protocol/Token
```

Keep the selected module (`Token.tla`), its TLC configuration (`Token.cfg`), and any project-local TLA+ dependencies in the same directory. The default model is `Token` at the project root. The configuration defines which properties TLC checks. TLC uses one worker, at most 512 MiB of Java heap, and a 20-second time limit. Its state files live in a temporary directory.

Run `warden check --base main --tier boundary --rule concurrency-protocol-model` to check the model. TLC reports invariant failures, deadlocks, and other model violations as findings. A runtime setup, parse, evaluation, or time-limit error interrupts the check and needs correction.

Run `warden bench --pack tla` to measure the declared passing example within the boundary budget. Model complexity depends on the number of reachable states, which does not grow when the repository gains unrelated files.
