# Review history

The [Capabilities plan](2026-11-19-capabilities-first-slice-plan.md) keeps
`warden review brief` and `warden review triage` stateless. The controller owns
the invocation and the native report. A separate recording step can add history
after it can validate and persist the records below. Existing review callers
can continue to use their reports and previous-round inputs.

## Record completed rounds

A review series covers one registered repository, one Unit or other named
review target, and one Capability. The controller supplies a stable series ID
from its existing change record. A new head in the same change keeps the same
series. Separate changes to the same Unit have separate series. Worktrees of
one registered repository share a history, while unrelated checkouts that use
the same project name do not.

A completed round references its series and the previous completed round. It
records the exact base and reviewed head commits, target, Capability, adapter,
Warden release, resolved review settings, and digests of the requirements and
native report. Store the normalized findings with their original numbers,
kinds, evidence, and locations. Preserve the native report reference so an
independent reviewer can reproduce normalization. The recorder validates the
reported head through the Capability's existing adapter and recomputes triage
from the recorded commits. Use the committed diff from the previous completed
head, or the base for the first round. Preserve any additional adapter input
needed to reproduce the result. The stateless CLI still supports its existing
worktree-aware triage. A missing report, a stale head, or an operational verdict can be
recorded as an attempt. An attempt cannot count toward a completed round.

Use one append-only record per completed round. A retry returns the prior
record only when the series, predecessor, and all immutable inputs match,
including the report digest, commits, requirements, adapter inputs, and review
settings. If a submission names the same predecessor with different inputs or
result, report a conflict and require the caller to reload the series. The
storage operation must check those conditions and write the record together,
including across processes. The caller cannot choose the round number. It
follows from the previous accepted record.

## Derive signals from the records

| Signal | Evidence required | Next action |
| --- | --- | --- |
| Reviewer error | An identified independent reviewer or the repository owner rejects a specific finding and records the rationale and evidence. | Return that finding and the ruling to the controller. Preserve the original report and leave unrelated findings in effect. |
| Repeated finding kind | The same normalized kind appears in two consecutive completed rounds for the same series. Exclude findings with a recorded ruling of reviewer error. | Ask the controller to address the repeated kind with the findings from both rounds. Keep the ordinary finding verdicts. |
| Round limit | The series reaches its configured completed-round limit and still has blocking findings. The plan's fourth-round case uses a limit of four. | Ask the controller to route the series and unresolved findings to the repository owner or designated reviewer. |

The controller can show these signals alongside the triage result. Retries of
one report and malformed or stale reports cannot increase the round count. A
later ruling changes which findings count toward current signals without
changing the original round. Review settings that affect escalation belong in
the Capability's approved configuration.

## Feed learning from confirmed findings

The [learning layer](2026-11-18-warden-guardrail-framework-design.md#the-learning-layer)
can consume normalized findings from recorded rounds. A reviewer confirms the
finding and its Practice before the runner records an escape. The source
identity is the repository registration, series, round, finding number, and
Practice. Keep the exact head and confirming ruling as provenance. Ingestion
must be idempotent for the source identity across retries and confirmations
from different reviewers. Keep malformed
reports, operational findings, and findings ruled erroneous out of proposals.
When a recurring finding supports an Add proposal, link the source findings
and Practices. The existing approval rules govern any proposed Guardrail
change.

## Acceptance

1. Replaying the same scope and report or racing two writers leaves one
   completed successor. A different base or requirement digest cannot reuse it.
2. Two changes to the same Unit cannot count toward each other's round limit.
3. A stale report and an operational attempt leave the next round number
   unchanged. A passing fourth round does not escalate.
4. An upheld reviewer error removes the affected finding from current
   recurrence and learning queries while preserving its source record.
5. Two independent confirmations of one finding and Practice contribute one
   escape. Repeated ingestion of either leaves one escape.
6. Existing brief and triage invocations keep their output and exit status and
   leave history unwritten.
7. Two worktrees at the same commits yield the same recorded verdict even
   when an untracked file exists in only one of them.
