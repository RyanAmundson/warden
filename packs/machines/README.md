# State machine checks

Enable the `machines` pack in `.warden/config.yaml` and run `warden compile`. Activate the resulting configuration and lock with a signed policy change. The pack checks tracked and non-ignored untracked files across the checkout at the boundary tier.

Name a table `<workflow>.machine.json`. Set `initial` to one state from the `states` array. Each entry in `transitions` has a `from` state, an `event`, and a `to` state. Every declared state must be reachable from `initial`. A terminal state can have no outgoing transitions.

Have the application or its test write the observed transitions to `<workflow>.trace.json` beside its table. Record the starting state in `initial` and the ordered `steps` as objects with `event` and the resulting `state`. Include at least one step. Trace checks use optional companions of declared tables. Keep the trace tracked or non-ignored in the checkout where you run Warden.

Run `warden check --base main --tier boundary --rule machine-traces` to compare a recorded trace with its table. Use `--rule machine-tables` to check the tables. The application or its test owns trace capture.
