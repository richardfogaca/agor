# Pocock token-efficiency isolated overnight plan

**Date:** 2026-07-20

**Status:** Ready for autonomous implementation and isolated validation

**Scope:** Measure and reduce context-replay and mechanical-coordination cost in the Pocock engineering teammate without creating a second workflow state machine, affecting the primary Agor instance, or retaining any Agor product change.

**Change authorization:** Durable implementation belongs only to the Pocock/teammate setup: skills, contracts, teammate-owned scripts/tests, and KB files. Agor Markdown under `context/` may retain the experiment plans and a sanitized report. Temporary Agor runtime-isolation and lab-harness changes are allowed only inside a disposable, push-disabled clone below the external lab-run directory. They must never touch the primary checkout, be committed, pushed, merged, or proposed for adoption. Capture their private patch and validation evidence, stop dependent processes, and remove the clone before completion. Any product capability the experiment reveals is a recommendation, not an Agor implementation deliverable.

## Executive decision

The strategy has two independent levers:

1. **Context rollover:** replace accumulated conversation history with a fresh session plus a bounded, pointer-based handoff at safe boundaries.
2. **Deterministic reduction:** handle only proven mechanical callback/gate outcomes in code, leaving meaning, judgment, authority, and unresolved decisions with Ponytail.

Implement and validate rollover first. Build a reducer only if measured coordinator cost remains material after rollover.

The overnight run must use two separate databases:

```text
PRIMARY AGOR SQLITE DATABASE
            │
            ├── online backup ──► IMMUTABLE ANALYSIS SNAPSHOT
            │                       historical measurement only
            │                       never started as an Agor daemon
            │
            └── no runtime connection from the lab

FRESH LAB SQLITE DATABASE
            │
            ├── offline clean template after migrations/bootstrap
            ├── fresh database + worktree instance per case/variant
            ├── isolated Agor daemon on separate localhost ports
            ├── new lab-only users, sessions, tasks, and branches
            ├── dedicated repository copies with push disabled
            └── controlled rollover and shadow-reducer experiments
```

Do **not** start a daemon against a raw copy of the primary database. A copied database contains live session status, schedules, gateway configuration, encrypted credentials, and branch paths that may still target primary worktrees. A fresh writable lab database is the safer execution boundary; the snapshot exists only to select cases and calculate historical baselines.

## Objective

Produce an evidence-backed answer to four questions:

1. How much objective cost comes from context replay versus mechanical coordination?
2. Can fresh sessions with bounded handoffs preserve PR-review quality while reducing cost?
3. Are enough coordinator decisions deterministic to justify a reducer?
4. Can the selected optimization operate inside Pocock's existing owners without adding parallel state or weakening fail-closed behavior?

The run is complete when it leaves:

- temporary isolation and experiment tooling implemented and tested in the disposable lab clone, captured privately, and removed;
- the Pocock rollover contracts clarified and contract-tested;
- a frozen benchmark manifest and raw private results;
- a final report with baseline, variant comparisons, proof limits, and a reducer decision;
- any justified reducer implemented in shadow mode only;
- zero durable Agor application, package, script, configuration, schema, CLI, UI, or test changes;
- the primary Agor daemon, database, worktrees, schedules, gateways, and provider state untouched.

## Why this is relevant

The current system can spend tokens for two different reasons:

| Cost             | Cause                                                                                 | Correct intervention                                |
| ---------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Context replay   | Long-lived sessions repeatedly send an expanding transcript                           | Fresh sessions plus bounded handoffs                |
| Coordination tax | The coordinator wakes to check duplicates, terminal state, retries, hashes, and gates | Deterministic handling of already-decided mechanics |

Agor already records task usage, estimated cost, context-window snapshots, session/task lineage, callback provenance, and duration. Pocock already has compact objective state, bounded worker briefs, role-session pins, deterministic validation, and canonical callback matching. The plan therefore formalizes and measures existing boundaries rather than introducing a new workflow engine.

Raw input-token sums are not literal spend. Codex turn input includes the full transcript and can be mostly cached. Every report must separate:

- uncached input;
- cached input;
- cache creation where available;
- output;
- estimated API-equivalent cost;
- wall time;
- context occupancy at the end of each turn.

## Governing boundary

> Ponytail owns meaning, judgment, and unresolved decisions. Code enforces only the consequences of decisions already recorded in canonical state.

### Canonical owners

| Responsibility                                                | Owner                           |
| ------------------------------------------------------------- | ------------------------------- |
| Request interpretation, authority, and next useful action     | Pocock `selection.md`           |
| Objective state, revisions, and implementation approval       | Pocock `approval.md`            |
| Semantic callback identity and role-session reuse/replacement | Pocock `dispatch.md`            |
| Callback transport, queueing, and delivery deduplication      | Agor `TasksService`             |
| Bounded context transfer                                      | Pocock `worker-brief.md`        |
| Validation, review, QA, and closure order                     | Pocock `mutation.md`            |
| Deterministic PR orientation                                  | `github-review-orientation.mjs` |

New rules must extend these owners. Do not create a separate kernel contract, objective ledger, evidence index, question ledger, or second persisted state shape.

### Deterministic inputs

A deterministic transition may consume:

- compact objective state and revision;
- owner, child session, and child task identities;
- task/session terminal states;
- callback transport metadata;
- checked base/head/diff hashes;
- existing evidence pointers;
- explicit scoped approvals;
- policy, Knowledge, repository, branch, model, and effort pins;
- previously decided quality requirements;
- freshly fetched provider facts.

It may not infer from:

- hidden reasoning chains or complete transcripts;
- implied user intent or approval;
- informal or unrecorded team knowledge;
- stale provider snapshots;
- semantic correctness or severity of a finding;
- unresolved product, architecture, security, or trust decisions.

Missing or inconsistent deterministic input produces `require_judgment` or a fail-closed result, never a guess.

## Safety and isolation invariants

The overnight agent must verify these before starting any lab daemon or agent run:

1. The source database is opened only long enough to create a SQLite online backup.
2. The analysis snapshot is integrity-checked, hashed, made read-only, and never used as a daemon database.
3. The writable lab database is newly initialized from current migrations.
4. Lab runtime home, data home, database, uploads, temporary files, logs, PID, sentinel, repos, and worktrees resolve below one recorded lab-run directory.
5. The lab daemon binds only to `127.0.0.1` on probed non-primary ports.
6. The lab uses fresh JWT and master secrets and does not copy encrypted user API keys.
7. The lab database begins with no schedules or gateway channels; telemetry, web terminal, and external listeners are disabled.
8. Every experiment repository and branch path points into the lab data directory, never into the primary Agor data home or a primary worktree.
9. Lab repository copies have push disabled or no push-capable remote. Provider reads do not authorize comments, reviews, pushes, PR changes, merges, deploys, or tracker updates.
10. The harness owns the exact child PID it starts and may stop only that PID. It must not use the normal detached daemon manager, shared PID file, or shared daemon log.
11. No experiment artifact containing database content, prompts, transcripts, credentials, or private PR data is committed.
12. Cleanup is non-destructive by default: stop the lab daemon gracefully and retain the run directory for inspection.
13. Temporary Agor source changes exist only in the disposable lab clone. Before completion, save their exact diff and hashes under the private run directory, remove the clone after all dependent processes stop, and verify the primary checkout has no experiment-created code changes.

Any failed isolation assertion is a hard stop for live experiments. Static implementation and unit tests may continue, but the agent must not weaken an assertion to make the run proceed.

## Runtime layout

Use a stable private location outside the repository. Resolve it to an absolute path before any write. A run has this conceptual shape:

```text
<agor-lab-root>/token-efficiency/<run-id>/
├── tooling/
│   ├── agor-lab-clone/       # temporary, push disabled, removed at completion
│   └── retained.patch        # private methodology evidence, not an adoption patch
├── lab-template/
│   ├── config.yaml
│   └── clean.db
├── instances/
│   └── <case-id>/<variant>/
│       ├── runtime/
│       │   ├── config.yaml
│       │   ├── agor.db
│       │   ├── logs/
│       │   └── uploads/
│       └── data/
│           ├── repos/
│           └── worktrees/
├── snapshot/
│   ├── primary-readonly.db
│   ├── primary-readonly.db.sha256
│   └── integrity.txt
├── manifest/
│   ├── run.json
│   ├── cases.json
│   ├── role-labels.json
│   └── checkpoints.json
├── results/
│   ├── raw/
│   ├── normalized/
│   └── comparisons.json
└── final-report.md
```

Directories must be mode `0700`; sensitive files must be mode `0600` where supported.

The daemon process receives explicit, recorded environment values:

```text
AGOR_HOME=<instance>/runtime
AGOR_DATA_HOME=<instance>/data
AGOR_CONFIG_PATH=<instance>/runtime/config.yaml
AGOR_DB_PATH=file:<instance>/runtime/agor.db
PORT=<probed lab daemon port>
UI_PORT=<probed unused UI/CORS port>
INSTANCE_LABEL=token-efficiency-lab-<run-id>
```

Do not alter the operating-system home or Codex home. Agent authentication remains available through its normal provider mechanism while Agor operating data is redirected through `AGOR_HOME` and `AGOR_DATA_HOME`.

## Implementation phases

### Phase 0 — Preflight and freeze the experiment contract

#### Repository preflight

- [ ] Read the active `AGENTS.md`/`CLAUDE.md` and agent tooling in this Agor repository.
- [ ] Before editing the Pocock clean-room repository, read its own `AGENTS.md`, `CORE.md`, router skill, references, scripts, and tests.
- [ ] Preserve unrelated changes in both repositories.
- [ ] Snapshot the primary Agor checkout path, revision, status, and tracked diff. Never edit it. Create a fresh push-disabled Agor clone below the lab-run directory for temporary isolation/harness work. Use a dedicated clean Pocock worktree for durable teammate changes. Never resolve, discard, stage, or incorporate somebody else's changes.
- [ ] Record both repository paths, current commit SHAs, branches, dirty-state summaries, Node version, pnpm version, model, effort, and current date in `manifest/run.json`.
- [ ] Use `cross-agent-artifact-sync` for Pocock skill changes so the Claude mirror remains linked and drift-free.

#### Freeze the acceptance contract

- [ ] Record the benchmark variants, case-selection algorithm, metrics, thresholds, timeouts, and retry policy before running the first case.
- [ ] Record all deviations as append-only entries in the run manifest; do not silently change thresholds after seeing results.
- [ ] Confirm that the run authorizes local implementation, tests, private lab processes, and private artifacts only.
- [ ] Mark push, publication, provider/tracker mutation, merge, deploy, production changes, and broad/destructive cleanup as prohibited. The sole cleanup exception is removal of the exact disposable Agor clone after path validation, process shutdown, and private patch capture.

#### Pre-register the decision-classification rubric

- [ ] Create `context/explorations/pocock-decision-classification-rubric.md` before classifying baseline turns.
- [ ] Define mechanical, judgment-bearing, mixed, redundant, and inconclusive categories with positive examples, negative examples, required observable evidence, and boundary cases.
- [ ] Treat a decision as mechanical only when its output is a pure consequence of explicit canonical inputs. Missing input, intent interpretation, finding validity/severity, architecture, approval, or another unresolved semantic choice is judgment-bearing or inconclusive.
- [ ] Have two independent classifier sessions label the same ten-turn calibration set without seeing each other's answers. Require at least 90% exact-category agreement before classifying the full sample.
- [ ] If calibration fails, clarify the rubric once, version it, repeat calibration on a new ten-turn set, and block classification if agreement still fails.
- [ ] Preserve the full private turn, category, canonical-input evidence, short rationale, classifier identity/model, and disagreements in the run artifacts. Do not commit private turns to the repository.

### Phase 1 — Implement temporary lab runtime-home isolation

Agor currently has `AGOR_DATA_HOME`, `AGOR_DB_PATH`, ports, and a custom config-path override, but several operational paths still derive directly from the OS home. A reliable second instance requires one canonical runtime-home override for the experiment. Implement and test it only in the disposable Agor lab clone. Do not commit it or treat it as a product proposal; the durable result is the teammate experiment, not this temporary adapter.

#### Core path contract

- [ ] Update `packages/core/src/config/config-manager.ts` so `getAgorHome()` resolves an explicit `AGOR_HOME` first and otherwise preserves the current `~/.agor` default.
- [ ] Require the override to resolve to a non-empty absolute path. Reject filesystem root and the primary default Agor directory when the lab harness requests isolation.
- [ ] Keep `AGOR_DATA_HOME` precedence unchanged; it still owns repos and worktrees.
- [ ] Add tests for default behavior, explicit override, path normalization, and independence between runtime and data homes.
- [ ] Update stale comments that currently describe `AGOR_HOME` as a concept without implementing the environment override.

#### Remove critical hard-coded operational paths

- [ ] Inventory direct `os.homedir()/.agor` use in daemon, executor, core/git, and CLI code.
- [ ] Replace only runtime-operational paths needed by an isolated daemon with the canonical helper.
- [ ] At minimum verify config, shutdown sentinel, uploads, daemon-generated runtime scripts, first-run credentials, and executor temporary files.
- [ ] Keep CLI authentication and provider-specific homes unchanged unless a test proves they are Agor runtime data.
- [ ] Update `packages/git/src/pure.ts` or its equivalent path owner so repository path discovery respects the same runtime/data-home contract without introducing a dependency cycle.
- [ ] Add focused tests beside each changed owner.

#### Isolation acceptance

- [ ] Start a minimal test process with `AGOR_HOME` and `AGOR_DATA_HOME` pointing at separate temporary directories.
- [ ] Assert that no file is created in the primary `~/.agor` as a result of that process.
- [ ] Assert that default behavior remains byte-for-byte/path-for-path compatible when `AGOR_HOME` is absent.

Do not run a full build. Use focused tests and package typechecks; the repository watch setup owns normal recompilation.

### Phase 2 — Implement the temporary private lab harness

Inside the disposable Agor lab clone, create a small TypeScript CLI under `scripts/token-efficiency-lab/`. Prefer one command with subcommands over unrelated scripts. Nothing in this phase may be committed, pushed, merged, or copied into the primary Agor checkout:

```text
prepare   snapshot primary data and initialize the fresh lab
baseline  analyze historical usage from the immutable snapshot
run       execute the controlled experiment against the lab daemon
report    validate results and write the final report
stop      gracefully stop the exact owned lab daemon
```

Suggested files:

```text
scripts/token-efficiency-lab/
├── cli.ts
├── paths.ts
├── snapshot.ts
├── lab-instance.ts
├── experiment.ts
├── metrics.ts
├── report.ts
└── *.test.ts
```

Split files by responsibility before any file approaches the repository's 500-line smell threshold.

#### `prepare`

- [ ] Resolve the primary database using Agor's canonical database resolver.
- [ ] Support SQLite for this first experiment. If the source is PostgreSQL, stop with an explicit unsupported-source result rather than inventing a backup path.
- [ ] Leave the primary daemon running. Create a transaction-safe SQLite online backup with `sqlite3` invoked through an argument array, never a shell-concatenated command. Record backup start/completion timestamps, whether primary health was available, and that the result is a point-in-time snapshot whose session/provider state may be stale immediately afterward.
- [ ] If the primary daemon is already stopped, record that fact; do not start or stop it for the snapshot.
- [ ] Run `PRAGMA integrity_check` on the snapshot and require `ok`.
- [ ] Hash the snapshot, store the digest, and make the snapshot read-only.
- [ ] Initialize a completely fresh writable SQLite lab template with current migrations and lab bootstrap data while no lab daemon is attached.
- [ ] Generate a lab config with localhost binding, unique ports/secrets, telemetry off, web terminal off, simple local execution, and an isolated data home.
- [ ] Start from no schedules, no gateway channels, no external-launch configuration, no copied API keys, and no inherited MCP provider mutations.
- [ ] Create lab repository copies using Agor's `simple-git` abstraction, never subprocess git.
- [ ] Remove or neutralize push capability in the lab copies while preserving the reads required by the benchmark.
- [ ] Before each case/variant, create a new writable database from the offline clean lab template and a new contained repository/worktree copy. Never reuse mutable sessions, tasks, branch state, SDK session IDs, or worktrees between variants.
- [ ] Never use `PRAGMA recovery` as a reset mechanism. Database copying occurs only while the template and destination have no attached daemon, followed by integrity verification.
- [ ] Write all resolved paths and safety assertions to `manifest/run.json`.

The lab intentionally uses `branch_rbac: false` and `unix_user_mode: simple` for local isolation speed. If the production target uses RBAC with `insulated` or `strict` Unix isolation, record the mismatch as a fidelity limitation. This experiment validates token/context behavior and workflow safety, not production Unix/RBAC performance.

#### `baseline`

- [ ] Open only the immutable snapshot.
- [ ] Verify its hash before and after analysis.
- [ ] Aggregate task usage into attributable objective/session trees.
- [ ] Split cached input, uncached input, cache creation, output, estimated cost, duration, agent/session count, turn count, and outcome.
- [ ] Do not sum context occupancy across turns. Use each task's usage for cost and the latest authoritative snapshot for current context occupancy.
- [ ] Produce role labels in the private manifest rather than adding product fields to Agor.
- [ ] Classify at least 20–30 coordinator turns with the frozen decision-classification rubric. Preserve task IDs, full private turns, canonical-input evidence, category, and rationale for audit.
- [ ] Define instrumentation cost as experiment-only logging, manifest writing, classification/adjudication prompts, and metrics collection—not Agor's existing task telemetry.
- [ ] On one representative baseline case, run matched instrumented and non-instrumented executions. Report added model tokens/cost, harness CPU time, and wall time separately. If instrumentation changes the model-visible prompt or behavior, treat that as a benchmark validity defect and fix it before Phase 4.

#### `run`

- [ ] Probe and reserve non-primary localhost ports.
- [ ] Launch the daemon as a foreground child owned by the harness; do not use `pnpm dev`, the detached CLI daemon manager, or the shared PID/log files.
- [ ] Wait for lab `/health`, verify the returned instance/port/database identity, and fail closed on mismatch.
- [ ] Authenticate with the lab-only bootstrap account and create all experimental entities through normal APIs/services.
- [ ] Record every created repo, branch, session, task, callback, and artifact ID in the run manifest.
- [ ] Enforce sequential execution by default to avoid cross-case contamination and unpredictable concurrency cost.
- [ ] Apply a per-case timeout and one retry only for zero-progress infrastructure failure: daemon process death before task creation, failed health check, inability to reach the lab daemon, or a database lock before any experiment task is accepted.
- [ ] A created session/task, accepted prompt followed by failure, completed low-quality variant, policy failure, or adjudication loss is progress and is not retryable. Preserve it as the case result.
- [ ] On shutdown, signal only the owned child PID, wait for graceful exit, and verify the lab health endpoint is down while the primary daemon remains unchanged.

A clean lab exit means the harness exits with status `0`, the owned daemon PID and all recorded child executor PIDs are no longer alive, the lab health endpoint is unreachable, and no process remains bound to the lab ports. A failed experiment may still have a clean harness exit when its failure is correctly recorded.

The harness must be resume-safe. Each phase records `not_started`, `running`, `passed`, `failed`, or `blocked` plus timestamps, inputs, outputs, and evidence pointers. Rerunning with the same run ID resumes the first incomplete safe phase and never duplicates a completed case.

### Phase 3 — Clarify the Pocock rollover contract

Make the minimum changes in the Pocock clean-room repository:

#### `approval.md`

- [ ] Add a compact section defining canonical deterministic inputs and exclusions.
- [ ] State that reasoning chains, copied evidence/history, and stale provider facts do not become objective state.
- [ ] Preserve the existing `workflowVersion: 4` shape; do not add another pins object or migrate state for this experiment.

#### `dispatch.md`

- [ ] Preserve the split between Agor callback transport deduplication and Pocock semantic callback matching.
- [ ] Define context occupancy as a warning signal, not replacement authority by itself.
- [ ] Define observable unusable-context triggers, such as insufficient remaining headroom for the bounded role task, loss of required canonical identity after compaction, or repeated reorientation causing zero progress.
- [ ] Preserve role-session reuse unless unusable context, contamination, capability change, model escalation, slice-boundary policy, or another existing explicit policy requires replacement.
- [ ] Explicitly forbid automatic mid-objective owner replacement. A new owner session is safe between objectives; active-objective transfer remains future work.

#### `worker-brief.md`

- [ ] Clarify the rollover handoff as goal, accepted decisions, authority, exact dispatch identity, evidence pointers, unresolved semantic questions, missing deterministic checks, and return contract.
- [ ] Keep the existing pointer-first behavior and enforce a maximum serialized size of 2.5 KB for the PR-review experiment; shorter handoffs are preferred. Record byte size and content hash in the manifest.
- [ ] Do not introduce a persisted `questions_answered`, transcript summary, evidence ledger, or copied repository/Knowledge content.

Use this concrete experiment template:

```text
Goal: <one review outcome against pinned PR head>
Accepted decisions: <only current decisions that change the review>
Authority: read-only; no post, push, provider/tracker mutation, or source mutation
Dispatch identity: <kind, owner, request hash, child/task, policy/Knowledge/model pins>
Pinned target: <PR URL, base SHA, head SHA, diff hash>
Evidence: <task/artifact/source pointers and what each proves>
Unresolved semantic questions: <questions requiring review judgment, or none>
Missing deterministic checks: <named checks still required, or none>
Return: <findings schema, proof limits, and required completion status>
```

Synthetic example:

```text
Goal: review PR example/repo#42 at head abc123 for merge-blocking correctness issues.
Accepted decisions: review only the pinned diff; generated files are out of scope.
Authority: read-only; do not post, push, edit, merge, deploy, or update a tracker.
Dispatch identity: advisory; owner S1; request sha256:R1; child S2/T2; policy P4; Knowledge K7; model M/high.
Pinned target: https://github.com/example/repo/pull/42; base def456; head abc123; diff sha256:D1.
Evidence: provider fixture F1 proves head/check/thread state; patch P1 is the reviewed diff.
Unresolved semantic questions: does the changed retry path duplicate a write after timeout?
Missing deterministic checks: confirm the new test executes the timeout branch.
Return: blocking findings first, then suggestions; include anchors, proof limits, and no posting.
```

The handoff contract passes only when it is within the size cap, contains every required field, contains no copied transcript/log/policy body, and the fresh reviewer does not ask again for information already present in the handoff during its first three turns. A request for genuinely absent or newly discovered information is not a failure.

#### Pocock contract tests

- [ ] Add assertions to `test/clean-room.test.mjs` for the deterministic-input boundary, safe rollover conditions, no owner rollover, no duplicate callback ownership, and bounded handoff.
- [ ] Run `npm test` and `npm run validate:skills` in the Pocock clean-room repository.
- [ ] Verify Claude artifacts remain symlinks or synchronized through the required cross-agent workflow.

### Phase 4 — Run the controlled PR-review rollover experiment

#### Case selection

Select up to ten reproducible historical PR-review cases from the immutable snapshot and live/read-only provider state:

- 3–4 small, low-risk fixes;
- 3–4 medium changes or minor scope shifts;
- 2–3 large, architectural, or ambiguous changes.

Each selected case is a **re-review**, not a replay of the original model execution. The historical snapshot identifies representative PRs and supplies baseline usage/context evidence; the lab variants independently perform the same pinned review work from scratch.

For every case, pin:

- canonical PR URL;
- repository identity;
- base and head SHAs;
- diff hash;
- changed-file/addition/deletion counts;
- policy and Knowledge revisions;
- model and effort;
- review rubric;
- source snapshot task/session IDs where applicable.

All three variants for a case must use the same model, effort, policy revision, Knowledge revision, rubric, provider fixture, and pinned repository state. A discovered deviation invalidates that case and is a hard blocker until the case is recreated consistently; never compensate by normalizing cost after the fact.

Exclude a case if its exact head cannot be reproduced, required policy cannot be resolved, repository access is missing, or a safe lab-only repository copy cannot be established. A minimum of eight valid cases is required for a conclusive pilot, with representation in all three size/complexity strata. If fewer than eight remain, complete any safe diagnostic runs but report `insufficient sample; rollover performance unknown`; do not claim the 95% recall threshold passed and do not substitute incomparable cases silently.

#### Read-only provider fixture and quota control

- [ ] Before any variant runs, calculate and record expected GitHub/Knowledge/provider calls per case and total calls, including a safety margin. The current GitHub orientation path is approximately four core requests per case plus optional prior-head comparison and quota probes; derive the actual number from the implemented fetcher.
- [ ] Fetch each case's PR metadata, exact comparison, patch, checks, review-thread summary, policy revision, and Knowledge revision once into a private immutable provider fixture.
- [ ] Record fixture timestamps, source revision/ETag where available, response hashes, and GitHub rate-limit remaining/reset values in the manifest.
- [ ] Give all variants the same fixture. Variants must not independently refetch provider state unless the fixture fails integrity or the experiment is explicitly restarted with a new pinned revision.
- [ ] Honor `Retry-After` and provider reset timestamps. Use bounded exponential backoff with jitter for read-only prefetch calls and record every retry; do not bypass provider limits with alternate credentials.
- [ ] If remaining quota cannot cover the estimated calls plus safety margin before the overnight deadline, mark provider prefetch blocked. Quota exhaustion during prefetch is a hard blocker for affected cases, not a reason to run variants with partial state.

#### Variants

Run all variants against the same pinned inputs:

| Variant                     | Context                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A — Resumed                 | One lab session accumulates the standardized pre-review work and then performs the review                             |
| B — Fresh                   | A fresh review session receives live provider/repository/policy inputs and no prior-session handoff                   |
| C — Fresh + bounded handoff | The same live inputs plus decisions, evidence pointers, and unresolved semantic questions from the prior bounded work |

Historical per-PR memory is not the tested variable. Either provide the same memory snapshot to all three variants or exclude it from all three. Record the choice per case.

When memory is included, materialize one immutable per-PR memory fixture at the deterministic private Knowledge/memory path before cloning the three variant instances, and verify the same content hash is readable in each. When excluded, create no memory document/file for that case and verify the deterministic path is absent in every variant. Do not substitute a session transcript or mutable shared memory directory.

All variants must perform equivalent objective work. Aggregate total cost across every session needed by a variant, including handoff generation; do not compare only the final reviewer turn.

#### One-case handoff pilot

- [ ] Before the full batch, run one representative medium case through the frozen handoff generator and a fresh reviewer.
- [ ] Verify size/schema constraints, pinned identity, evidence resolution, and the no-re-ask criterion during the first three turns.
- [ ] If the pilot fails because the template is structurally insufficient, revise and version the template once, repeat the pilot on a different medium case, then freeze it again. Exclude calibration pilots from final results and rerun their cases under the frozen template if selected for the main sample.
- [ ] If the second pilot fails, stop the full experiment and report handoff insufficiency rather than spending the remaining variants.

#### Quality evaluation

- [ ] Normalize findings by file/line or symbol, claim, severity, and fix direction.
- [ ] Deduplicate semantically equivalent findings without treating wording differences as new findings.
- [ ] Verify that each finding is anchored to the pinned diff or explicitly marked as a validation/provider gap.
- [ ] Pre-register the adjudicator rubric and output schema in the manifest before the first variant. It must define correctness, relevance, severity, duplicate handling, unsupported claims, proof limits, and `equivalent`/`inconclusive` outcomes.
- [ ] Sanitize outputs before adjudication: remove variant labels, session/task IDs, timestamps, token/cost data, ordering clues, and experiment commentary while preserving finding substance and evidence anchors. Randomize opaque labels and record the hidden mapping outside the adjudicator input.
- [ ] Use an independent, fresh adjudicator session with the pinned adjudicator model/effort and fixed rubric. The adjudicator must not receive transcripts, cost information, or variant identity.
- [ ] Retain deterministic evidence and the adjudicator rationale; genuinely ambiguous cases must be `equivalent` or `inconclusive`, never a forced winner or guessed 50/50 choice.
- [ ] Measure whether a fresh session asks for already-answered context, re-derives prior work, misses a material constraint, or produces an unsupported explanation.

#### Pre-registered acceptance thresholds

Rollover passes only when all are true across the valid sample:

- finding recall is at least 95% of the resumed baseline;
- false-positive rate is no more than baseline plus two percentage points;
- estimated total cost is reduced by at least 20%;
- no stale-state, authority, callback, or fail-closed safety regression occurs;
- median time to final synthesis is no more than 10% worse;
- clarification and context-recovery turns do not materially increase.

Report per-stratum results and confidence limits where the sample supports them. Ten PRs validate a PR-review pilot, not all engineering workflows.

### Phase 5 — Optional deterministic reducer

Do not implement a reducer merely because the plan mentions one. It is earned only if:

- rollover meets the quality/safety thresholds or its failure is understood and unrelated to coordination;
- coordinator work remains at least 15% of objective estimated cost or another pre-registered materiality threshold;
- at least 30 labeled mechanical decisions have complete canonical inputs;
- no unresolved ownership conflict remains;
- the projected savings exceed the added implementation and instrumentation cost.

If the gate fails, record `reducer_decision: not_justified` and stop this phase successfully.

If earned, add a pure JSON-in/JSON-out reducer in the Pocock router scripts with table-driven tests. Every input is pre-computed by the existing canonical owners before invocation. The reducer receives no database/service/client handles and performs zero filesystem, database, provider, network, clock, environment, or process I/O.

Representative input:

```json
{
  "callbackId": "session_completion:child-task-1:owner-session-1",
  "callbackAlreadyDispatched": false,
  "taskStatus": "completed",
  "objectiveRevision": 4,
  "callbackObjectiveRevision": 4,
  "activeChildMatches": true,
  "evidenceHashes": {
    "expectedDiff": "sha256:D1",
    "observedDiff": "sha256:D1"
  },
  "policyPinsMatch": true,
  "knowledgePinsMatch": true,
  "retryCount": 0,
  "retryLimit": 1,
  "requiredEvidencePresent": true,
  "semanticDecisionPending": false
}
```

Representative output:

```json
{
  "disposition": "proceed",
  "reasonCode": "canonical_completion_matches",
  "requiresJudgment": false
}
```

The closed disposition set is `proceed`, `ignore_duplicate`, `reject_stale`, `wait_for_terminal`, `block_missing_evidence`, `retry_exhausted`, and `require_judgment`. Unknown fields, missing required fields, unsupported versions, contradictory booleans, or an unresolved semantic input return `require_judgment` or a typed invalid-input result. The reducer must perform no state mutation, session creation, provider action, or semantic classification.

#### Shadow validation

- [ ] Replay historical labeled mechanical cases through the reducer.
- [ ] Run it in the lab beside the normal coordinator and record proposed versus actual action.
- [ ] Require 100% agreement on safety-negative cases such as stale, duplicate, incomplete, missing-evidence, and unauthorized advancement.
- [ ] Require at least 99% agreement across all in-scope mechanical cases.
- [ ] Require zero cases where the reducer advances while the coordinator blocks or requests judgment.
- [ ] Treat every ambiguity as `require_judgment`.

The overnight goal may leave this reducer implemented and proven in the Pocock/teammate setup in shadow mode. It must not change the primary Agor callback path. Runtime integration requiring Agor changes is outside this experiment.

### Phase 6 — Final validation and report

#### Static and contract validation

- [ ] Inside the disposable clone, run focused unit tests for every temporarily changed Agor owner.
- [ ] Inside the disposable clone, run `pnpm --filter @agor/core typecheck` for temporary core changes.
- [ ] Inside the disposable clone, run typechecks/tests for any temporarily changed daemon, executor, or git package.
- [ ] Run the lab harness unit tests.
- [ ] Run Pocock clean-room tests and isolation validation.
- [ ] Do not run repository builds during the overnight goal. If focused tests and package typechecks cannot validate a change without a build, record the exact validation gap for follow-up rather than overriding the repository's watch-mode rule.

#### Live lab validation

- [ ] Lab daemon starts on the recorded localhost port and reports healthy.
- [ ] Lab database path, runtime home, and data home match the manifest.
- [ ] A lab session can execute a bounded prompt and record usage/context telemetry.
- [ ] A lab child completion queues exactly one callback to the lab owner.
- [ ] Stopping and restarting the lab affects only lab task/session state.
- [ ] The immutable analysis snapshot hash is unchanged.
- [ ] Every lab branch path is contained by the lab data root.
- [ ] No lab repository can push.
- [ ] No lab schedule, gateway listener, telemetry destination, provider mutation, or shared-state action fires.

#### Primary-instance non-interference

- [ ] Record primary daemon health/port before and after the run when it is available.
- [ ] Confirm the lab never binds the primary daemon/UI ports.
- [ ] Query the primary database for the lab run ID and require zero experiment-created records.
- [ ] Confirm no recorded lab path resolves under a primary worktree.
- [ ] Confirm no primary process was signaled or restarted.
- [ ] Do not rely on whole-file database hashes for the live primary database because normal primary activity may legitimately change it during the overnight run.

If the primary daemon is unavailable before or after the run, record that health proof as unavailable and use the database/path/process fallbacks: require zero lab run IDs in the primary database, zero lab paths in primary branch/worktree records, no listener on the primary ports started by the harness, and no primary PID in the harness-owned process tree. Do not start the primary daemon merely to obtain a health check.

#### Disposable Agor clone retirement

- [ ] Stop the lab daemon and every recorded executor or child process that depends on the disposable clone.
- [ ] Save the exact temporary diff, changed-file list, file hashes, commands, and focused validation results below `<run>/tooling/` as private methodology evidence.
- [ ] Verify no temporary commit was created and no remote has push capability.
- [ ] Remove only the explicitly recorded disposable clone path after validating it is below the lab-run root; retain the patch, manifests, fixtures, and reports.
- [ ] Re-check the primary Agor checkout and require zero experiment-created non-Markdown changes. Preserve and report unrelated concurrent user changes.
- [ ] If safe clone removal or primary-checkout non-interference cannot be proven, mark final cleanup blocked and report the exact path/process instead of broad deletion or reset.

#### Final report

Write `<run>/final-report.md` with:

1. Run identity, source revisions, model/effort, duration, and environment.
2. Isolation proof and any deviations.
3. Historical baseline by objective and role.
4. Mechanical versus judgment-bearing coordinator distribution.
5. Variant A/B/C quality, token, cost, time, and coherence results.
6. Acceptance-threshold outcome per metric.
7. Reducer gate decision and, if built, shadow agreement results.
8. Instrumentation cost.
9. Failures, retries, excluded cases, and proof limits.
10. Exact durable Pocock/teammate files, permitted Agor Markdown files, and separately labeled removed temporary Agor methodology files.
11. Commands/tests run and their outcomes.
12. Recommended next decision: stop at rollover, refine handoff, review the shadow reducer, or abandon the optimization.

The report must distinguish verified facts, supported inference, and unresolved uncertainty. Keep private raw data in the run directory; a repository-facing summary must be sanitized before it is added anywhere tracked.

## Autonomous `/goal` execution contract

The plan is designed to run without interactive decisions after launch.

### Suggested goal

```text
/goal Execute context/explorations/pocock-token-efficiency-overnight-plan.md end to end. Treat the plan as authoritative. Build any temporary Agor isolation or lab harness only in a disposable push-disabled clone below the external run directory; never edit the primary checkout, commit, push, merge, or retain those changes, and remove the clone after capturing private methodology evidence. Durable implementation is limited to Pocock/teammate skills, contracts, teammate-owned scripts/tests, and KB files after their gates pass. Collect the baseline, run the isolated PR experiment, and build only an earned teammate-owned shadow reducer. Do not affect the primary Agor instance, mutate providers/trackers, deploy, or delete retained evidence. Follow every gate, checkpoint progress, and finish with the required report or exact safe blocker/resume evidence.
```

### Agent behavior

- Work sequentially unless a test suite safely parallelizes internally.
- Checkpoint after every phase and benchmark case.
- Retry a zero-progress infrastructure operation once with identical scope.
- Do not retry quality failures to manufacture a passing result.
- Continue independent static work when live model/provider access is unavailable.
- Mark a phase blocked with exact evidence when it cannot proceed safely.
- Never ask for a decision that the frozen plan already answers.
- Never infer new authority from the overnight duration or isolated environment.
- Stop live work immediately if the primary/lab boundary cannot be proven.
- Preserve artifacts and end with a graceful lab shutdown even when the experiment fails.

### Hard blockers for live execution

- Primary database dialect is unsupported by the snapshot implementation.
- SQLite backup or integrity verification fails.
- Runtime/data/database paths overlap the primary instance.
- A selected branch path cannot be contained inside the lab root.
- Lab daemon identity or port does not match the manifest.
- A lab agent cannot authenticate to a required read-only provider, such as GitHub or Knowledge, for the pinned case data.
- Required pinned PR state cannot be reproduced for any valid case.
- A provider mutation, push capability, gateway listener, or schedule is detected.
- Required read-only provider quota is exhausted or cannot cover the pre-registered call budget before the deadline.
- The disposable Agor clone cannot be safely distinguished from the primary checkout or removed after dependent processes stop.

A hard blocker does not erase completed implementation or static validation. The final report must state the blocker and the safest next action.

## Expected file changes

### Agor repository

Allowed durable tracked changes in the primary checkout:

- `context/explorations/pocock-token-efficiency-overnight-plan.md` — this contract.
- `context/explorations/pocock-decision-classification-rubric.md` — the pre-registered classification contract.
- `context/README.md` — link to this active design plan.
- A sanitized Markdown result under `context/` only when it contains no private data.

Temporary changes allowed only inside the disposable lab clone:

- `packages/core/src/config/config-manager.ts` and its tests — canonical `AGOR_HOME` override.
- Runtime-path consumers and focused tests — remove only critical hard-coded `.agor` operational paths.
- `packages/git/src/pure.ts` and tests if needed — consistent runtime/data-home resolution.
- `scripts/token-efficiency-lab/*` — private lab lifecycle, snapshot, experiment, metrics, and report tooling.
- Root `package.json` only if temporarily required to invoke the private harness.

Save the temporary diff and file hashes in the private run directory, stop all dependent processes, then remove the disposable clone. Do not commit, push, merge, publish, or recommend this patch as part of the experiment outcome.

No durable Agor product changes may remain. In particular, do not add:

- task/session schema changes;
- task-role product metadata;
- leaderboard or analytics API changes;
- UI changes;
- database migrations;
- authoritative callback reducer integration.

### Pocock clean-room repository

Required contract changes:

- `.codex/skills/pocock-engineering-router/references/approval.md`
- `.codex/skills/pocock-engineering-router/references/dispatch.md`
- `.codex/skills/pocock-engineering-router/references/worker-brief.md`
- `test/clean-room.test.mjs`

Conditional on the reducer gate:

- `.codex/skills/pocock-engineering-router/scripts/pr-review-transition.mjs`
- `test/pr-review-transition.test.mjs`

The existing PR-orientation script should remain unchanged unless the experiment exposes a specific missing deterministic input with a failing test.

### Knowledge/KB

KB changes are conditional on a passing experiment and a verified canonical owner. Update only teammate operating knowledge, workflow contracts, or bounded handoff guidance that the evidence supports. Do not copy raw prompts, transcripts, private fixtures, local paths, credentials, or experiment-only state into Knowledge. Use the existing reviewed KB workflow, record the resulting revision, and validate every referenced contract/policy pointer.

## Stop decisions

| Evidence                                                          | Decision                                          |
| ----------------------------------------------------------------- | ------------------------------------------------- |
| Rollover passes and coordinator cost is small                     | Adopt rollover; do not build a reducer            |
| Rollover passes and coordinator cost remains material             | Review the shadow reducer evidence                |
| Rollover saves cost but fails quality/coherence                   | Improve the handoff; do not automate transitions  |
| Rollover cost reduction is below the pre-registered 20% threshold | Keep current session reuse; stop the optimization |
| Reducer shadow disagrees on any safety-negative case              | Keep the LLM coordinator authoritative            |
| Isolation cannot be proven                                        | Stop live experiments; retain only static results |

## Non-goals

- Generalizing from PR review to exploratory research, meeting synthesis, initial shaping, or architecture decisions.
- Automatically replacing an objective owner mid-objective.
- Persisting reasoning chains or full handoffs as workflow state.
- Replacing Ponytail's semantic selection, approval, review, or synthesis responsibilities.
- Starting the primary Agor daemon, UI, or watch processes.
- Retaining or proposing Agor application, package, script, configuration, schema, migration, CLI, UI, or test changes produced for the lab.
- Publishing code or experiment results.
- Automatically deleting the lab directory. The user owns cleanup; retain each run for 30 days by recommendation, then archive or remove it manually after reviewing the final report.

## Durable takeaway

This is a gated experiment, not a commitment to a kernel:

```text
Prove isolation
      ↓
Measure real cost
      ↓
Implement bounded rollover
      ↓
Validate quality and savings
      ↓
Stop if rollover is enough
      ↓
Otherwise prove a pure reducer in shadow mode
```

Each phase must justify the next one. The clean result may be a working reducer, a rollover-only improvement, or evidence that the current architecture should remain unchanged.
