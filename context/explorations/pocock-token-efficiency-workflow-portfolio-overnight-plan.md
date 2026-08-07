# Pocock token-efficiency workflow portfolio overnight plan

**Date:** 2026-07-21

**Status:** Ready after the PR-review experiment foundation passes its isolation and harness gates

**Scope:** Test whether bounded context rollover and narrowly deterministic coordination generalize beyond PR review, without retaining any Agor product change, creating a generic workflow engine, mutating production state, or claiming more than the evidence supports.

**Change authorization:** Durable implementation changes may be made only to the Pocock/teammate setup: skills, contracts, teammate-owned scripts/tests, and KB files after the relevant gate passes. Documentation under Agor `context/` may retain these plans and a sanitized result. Temporary Agor source or harness changes are allowed only inside a disposable, push-disabled lab clone below the external run directory when required to execute the experiment. They must never touch the primary checkout, be committed, pushed, merged, or proposed for adoption; capture their patch and validation evidence privately, then remove the disposable clone before completion. A discovered need for an Agor product change is a recommendation, not an implementation deliverable.

## Executive decision

The PR-review experiment is the controlled proof of the mechanism. This second run asks where else it is valuable.

It must not run every workflow at full scale. It uses an adaptive funnel:

```text
Measure all candidate workflow families retrospectively
                         |
                         v
Rank by spend, repetition, rollover potential, and benchmarkability
                         |
                         v
Calibrate eligible families on one pinned case each
                         |
                         v
Run full comparisons for at most the top two families
                         |
                         v
Recommend only changes supported by per-family evidence
```

The optimization levers remain independent:

1. **Context rollover:** fresh role sessions receive bounded, pointer-based handoffs instead of accumulated transcripts.
2. **Deterministic coordination:** code may propose only transitions that are a pure consequence of explicit canonical state. This remains shadow-only and is evaluated only for structured workflows.

Open-ended research, architecture, and synthesis may be rollover candidates. They are not reducer candidates merely because they consume many tokens.

## Relationship to the first overnight plan

This plan depends on and reuses the foundation in [`pocock-token-efficiency-overnight-plan.md`](pocock-token-efficiency-overnight-plan.md):

- canonical `AGOR_HOME` and `AGOR_DATA_HOME` isolation;
- immutable primary-database analysis snapshot;
- fresh writable lab database and worktree per variant;
- private lab harness or reproducible temporary harness artifact;
- provider-fixture caching and quota controls;
- resume-safe manifests and checkpoints;
- bounded handoff and recorded-state contracts;
- blind adjudication and primary-instance non-interference checks.

The first plan remains authoritative for shared safety requirements. This file narrows the follow-on experiment, candidate selection, per-workflow oracles, resource ceilings, and generalization decisions.

### Entry gate

Before any live follow-on case runs, require:

- [ ] The first run's isolation phase passed.
- [ ] The parent run's private harness artifact and focused isolation tests passed.
- [ ] The retained private harness artifact, public Agor interfaces, or a safely reproducible disposable lab clone can execute pinned non-PR cases without changing the primary checkout or leaving a durable Agor change.
- [ ] A lab daemon can start and stop without touching the primary instance.
- [ ] Fresh lab database and worktree creation per variant is proven.
- [ ] Provider reads can be served from pinned immutable fixtures.
- [ ] The bounded-handoff generator has at least one structurally valid result.
- [ ] The first run left a readable manifest and final or interim report with exact artifact paths.

PR-review quality does not need to pass for retrospective analysis. Live follow-on experiments require the safety foundation to pass. They may proceed after a PR-review quality failure only when the failure is clearly workflow-specific and any shared handoff defect has been corrected, versioned, and recalibrated.

If the entry gate fails, do not alter the primary checkout or build durable Agor infrastructure. Complete safe static analysis, write a readiness report, and stop live execution.

## Questions this run must answer

1. Which non-PR workflow families account for the most attributable token cost and execution frequency?
2. In which families is cost dominated by transcript replay, coordination, or necessary semantic work?
3. Can bounded handoffs preserve quality for CI, implementation, QA, cross-repository, synthesis, or open-ended work?
4. Does any structured family contain enough repeated mechanical decisions to justify extending the shadow reducer?
5. Which optimization is reusable, and which must remain workflow-specific?
6. Do the savings justify the code, contracts, fixtures, and ongoing benchmark maintenance?

## Candidate workflow families

| Family                           | Primary opportunity                                                            |                           Validation strength |                Reducer suitability | Initial treatment                      |
| -------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------: | ---------------------------------: | -------------------------------------- |
| CI diagnosis and repair          | Remove repeated logs/history; make retry and unchanged-failure checks explicit | High when checks and patches are reproducible |  High for gates, low for diagnosis | Full-pilot candidate                   |
| Implementation-test-review loops | Rollover between implementation, test, review, and repair roles                |      Medium-high with pinned acceptance tests |        Medium for phase gates only | Full-pilot candidate                   |
| QA and validation                | Fresh QA context plus immutable scenario/evidence bundle                       |             High with deterministic scenarios | High for evidence/completion gates | Full-pilot candidate                   |
| Cross-repository work            | Give each repository specialist only the shared contract and relevant state    |           Medium; integration oracle required |                         Medium-low | Full-pilot candidate when reproducible |
| Callback and dispatch processing | Avoid turns for duplicate, stale, terminal, and evidence-complete state        |                 High from labeled transitions |                  High, shadow only | Retrospective/shadow candidate         |
| Board triage and task selection  | Reduce repeated orientation and mechanically filter ineligible work            |                 Medium-low; priorities change |        Low beyond explicit filters | Calibration-only candidate             |
| Final synthesis and reporting    | Synthesize from findings/evidence instead of worker transcripts                |      Medium-high with factual-coverage rubric |                               None | Rollover-only candidate                |
| Research and architecture        | Preserve hypotheses, sources, rejected options, and open questions             |        Low-medium; semantic quality dominates |                               None | Exploratory rollover-only candidate    |

Meeting synthesis is excluded from live testing unless the snapshot contains a reproducible, private-safe corpus and an accepted reference summary. Otherwise it lacks a stable source fixture and quality oracle for autonomous comparison.

## Governing boundaries

### Judgment boundary

> Ponytail owns meaning, task selection, diagnosis, semantic correctness, risk, priority, architecture, approval, and synthesis. Code enforces only consequences already established in canonical state.

| Decision                                                                | Owner                       |
| ----------------------------------------------------------------------- | --------------------------- |
| Whether a CI log indicates the correct root cause                       | Ponytail                    |
| Whether the same pinned check failed with the same normalized signature | Code may compare            |
| Whether an implementation meets the user's intent                       | Ponytail                    |
| Whether every preselected required test produced a terminal result      | Code may check              |
| Whether a QA discrepancy is release-blocking                            | Ponytail or explicit policy |
| Whether required evidence pointers are present and hash-consistent      | Code may check              |
| Which repository owns a cross-repository contract change                | Ponytail                    |
| Whether all explicitly selected repository validations completed        | Code may check              |
| Which research conclusion is best supported                             | Ponytail                    |
| Whether a cited pointer resolves to the pinned fixture                  | Code may check              |

Missing, contradictory, stale, or semantic input produces `require_judgment` or a fail-closed outcome.

### Maintenance boundary

This run must not create a general workflow platform:

- Reuse existing lab lifecycle, manifest, metrics, and adjudication code.
- Treat `apps/`, `packages/`, `scripts/`, root configuration, schemas, migrations, and tests in the primary Agor checkout as read-only.
- Permit durable Agor-repository edits only to Markdown planning/reporting files under `context/`.
- When temporary experiment glue is required, keep it in the external run directory or disposable lab clone and use plain data and small functions rather than a plugin runtime or class hierarchy.
- Do not add product database tables, migrations, services, queues, dashboards, or UI.
- Do not add a second objective, evidence, question, or callback ledger.
- Do not persist transcripts as handoff state.
- Keep experiment role labels and normalized outputs in private manifests.
- Prefer deletion over compatibility layers when a candidate is rejected.
- Do not modify a Pocock owner until a passing experiment identifies a concrete missing contract.

Any shared abstraction must be used by at least two passing workflow families, be smaller than the duplicated code it replaces, and preserve existing canonical owners.

## Resource and safety ceilings

Freeze these values before the first live model call:

- maximum wall-clock duration: 10 hours;
- maximum benchmark variant executions: 36, excluding fixture preparation and local tests;
- maximum full-pilot families: 2;
- maximum calibration-only families: 4;
- sequential live execution by default;
- one retry only for a zero-progress infrastructure failure;
- no retry for poor quality, a completed task, or an accepted prompt that later fails;
- projected provider/model usage recalculated before each family starts;
- stop starting new families when fewer than 90 minutes remain;
- never exceed a user-supplied lower ceiling.

Execution count, elapsed time, and estimated API-equivalent cost must be checkpointed after every variant. A ceiling stops new work; it does not justify truncating or misreporting an active result.

All isolation, provider-write prohibitions, port/path containment, push disabling, fixture hashing, daemon ownership, cleanup, and primary non-interference requirements from the first plan apply unchanged.

## Common experiment contract

### Variants

Calibration uses three variants to establish whether the handoff itself contributes value:

| Variant                   | Context                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| A — Accumulated           | One session receives the standardized preceding work and continues into the target phase |
| B — Fresh without handoff | A fresh session receives only the pinned fixture and target objective                    |
| C — Fresh with handoff    | A fresh session receives the same fixture/objective plus the bounded handoff             |

After calibration, full comparison uses A versus C. Retain B only when calibration shows it is necessary to distinguish fresh-session effects from handoff effects.

Every variant uses a fresh lab database, session tree, repository/worktree copy, and immutable copy of the same fixture. Model, effort, policy, Knowledge revision, memory policy, repository revision, prompt contract, and oracle must match within a case.

### Bounded handoff envelope

Reuse one envelope for every family:

```text
Goal: <one bounded outcome>
Accepted decisions: <only decisions constraining this role>
Authority: <explicit allowed and prohibited actions>
Dispatch identity: <objective revision, role, request, task, and pins>
Pinned target: <repository/provider/artifact identities and hashes>
Current state: <observable state needed to continue>
Evidence: <pointers and what each proves>
Attempts and outcomes: <only attempts affecting the next action>
Unresolved semantic questions: <questions requiring judgment>
Missing deterministic checks: <named checks still required>
Return: <output schema, evidence, and terminal states>
```

The default maximum serialized size is 3 KB. A family may pre-register a smaller cap. Calibration may revise the template once, up to an absolute maximum of 4 KB, before freezing it. More than 4 KB, or embedding transcripts, complete logs, patches, policies, or source bodies, fails the bounded-handoff hypothesis for that family.

Source material lives in immutable fixtures referenced by pointer and hash. Handoff generation cost counts toward Variant C.

### Measurements

Record for every case and variant:

- cached input, uncached input, cache creation, output, estimated cost, and wall time;
- latest context occupancy and context-growth slope;
- sessions, tasks, turns, provider reads, and coordinator wakeups;
- handoff generation cost, byte size, completeness, and hash;
- repeated orientation or requests for information already present;
- evidence pointers opened and questions introduced or closed;
- objective outcome and workflow-specific quality score;
- safety violations, unsupported actions, stale-state use, and authority escalation;
- instrumentation and adjudication cost separately.

Do not treat cached-token volume as literal spend. Report token classes and estimated cost separately.

### Common acceptance criteria

A full-pilot family is recommended for rollover only when:

- its workflow-specific quality floor passes;
- estimated total cost falls by at least 20% versus Variant A;
- no safety, authority, state-freshness, or fail-closed regression occurs;
- median wall time is no more than 15% worse;
- redundant orientation or context-recovery turns increase by no more than one at the median;
- at least six valid cases complete, including two low-, two medium-, and two high-complexity cases;
- no high-severity omission is attributable to missing handoff context.

With fewer than six valid cases, report the result as directional and do not recommend a production contract change. Report per-stratum results; do not hide complex-case failures in the aggregate.

A reusable cross-workflow claim requires two different structured families to pass independently. One passing family supports only a family-specific recommendation.

## Implementation phases

### Phase 0 — Preflight, inherit, and freeze

- [ ] Read instructions and agent tooling in Agor, Pocock, and every selected case repository.
- [ ] Locate the first-run manifest through an explicit `--parent-run` or a single unambiguous completed run. Do not guess between multiple runs.
- [ ] Verify the entry gate and copy only non-sensitive configuration, rubric versions, hashes, and artifact pointers into the new manifest.
- [ ] Record revisions, dirty-state summaries, model/effort, policies, Knowledge, memory policy, date, and environment.
- [ ] Preserve unrelated changes and use dedicated clean worktrees.
- [ ] Freeze resource ceilings, scoring weights, eligibility, quality rubrics, timeouts, and retry policy before reading candidate outcomes.
- [ ] Keep push, publication, provider/tracker mutation, merge, deploy, production changes, and broad/destructive cleanup prohibited. The sole cleanup exception is removal of the exact disposable Agor clone after path validation, process shutdown, and private patch capture.
- [ ] If the first run created a shadow reducer, record its version and evidence. Do not make it authoritative or expand it yet.

### Phase 1 — Build the retrospective portfolio

Analyze the immutable snapshot without model sessions.

- [ ] Attribute tasks and sessions to objective trees using canonical identity and lineage.
- [ ] Derive family labels from observable prompts, role metadata, reports, tool/result patterns, and repository/provider evidence. Preserve evidence and confidence; do not force ambiguous objectives into a family.
- [ ] Split mixed objectives only when task/session boundaries make attribution defensible. Otherwise label the complete objective mixed.
- [ ] Aggregate per family: count, completion, total and median cost, token classes, context occupancy, wall time, coordinator share, session count, and frequency.
- [ ] Measure repeated phases, repeated source/log reads, redundant orientation, callbacks, and semantic-versus-mechanical decisions.
- [ ] Treat cross-repository work as either a family or a complexity attribute; never count one objective twice in total spend.
- [ ] Produce `portfolio-baseline.json` and a human-readable scorecard with proof limits.

Require five attributable objectives before using a family's distribution for ranking. A smaller family may receive exploratory calibration only with one exceptionally reproducible case and a strong oracle.

### Phase 2 — Rank and select candidates

Use frozen normalized inputs:

```text
opportunity score =
  25% attributable total spend
+ 15% execution frequency
+ 20% context-replay signal
+ 10% coordinator/mechanical signal
+ 20% benchmark and oracle quality
+ 10% expected safety and isolation fidelity
```

Eligibility requires:

- reproducible exact or acceptably equivalent inputs;
- read-only or isolated-lab execution;
- a quality oracle frozen before variants run;
- identical model, effort, policy, Knowledge, memory, and source pins;
- six potential cases for a full pilot;
- execution within remaining ceilings.

Select at most:

1. Two highest-scoring eligible structured families for full pilots.
2. One rollover-only open-ended family for exploratory calibration.
3. Callback/dispatch for retrospective shadow analysis when 30 complete transitions exist.

Do not choose solely by cost. A cheaper structured family may be a better experiment than an expensive workflow with no reliable oracle.

### Phase 3 — Configure the portfolio with no durable Agor change

Prefer the parent run's retained private harness and existing CLI/API surface. When the selected portfolio cannot be expressed through declarative inputs, temporary commands, adapters, tests, or helper modules may be created only inside a fresh push-disabled Agor lab clone below the external run directory. Never edit the primary checkout or carry these files into a durable Agor branch.

Keep follow-on experiment material below the private external run directory:

```text
<run>/portfolio/
├── tooling/
│   ├── agor-lab-clone/       # optional, temporary, push disabled
│   └── retained.patch        # private evidence; not an adoption patch
├── manifest/
│   ├── candidates.json
│   ├── scoring.json
│   └── checkpoints.json
├── cases/<family>/<case>/
│   ├── fixture/
│   ├── variants/
│   └── oracle.json
├── rubrics/
├── prompts/
└── results/
```

Disposable glue must be narrow, incapable of provider writes, recorded in the manifest, and never committed or pushed. Prefer JSON manifests, frozen prompts, and existing CLI/API calls. If temporary source changes are required, record their exact diff and hashes as private evidence, then remove the lab clone after all dependent processes stop. Do not present the retained patch as a proposed Agor change.

- [ ] Snapshot the Agor worktree status and tracked diff before execution.
- [ ] Reuse inherited lab cloning, lifecycle, quota accounting, checkpoints, metrics, sanitization, and reporting where possible.
- [ ] Express case eligibility, variant equality, handoff limits, oracle rules, ceilings, and resume state in the private manifest/rubrics.
- [ ] Test any temporary harness change only inside the disposable clone; do not weaken tests to make a case pass.
- [ ] If a family requires a durable Agor capability, mark it `blocked_by_product_capability`, document the minimal requirement, and continue other safe families.
- [ ] Stop every dependent process, capture the temporary diff/hashes, remove the disposable clone, and verify the primary checkout was unchanged.

### Phase 4 — Calibrate eligible families

For each selected family:

- [ ] Choose one median-complexity case without inspecting its new-variant outcomes.
- [ ] Pin source, repository, provider, policy, Knowledge, memory, model, effort, and oracle inputs.
- [ ] Prefetch each provider fixture once, hash it, and reuse it across variants.
- [ ] Run A, B, and C from separate clean lab instances.
- [ ] Verify C does not re-ask for information present in the handoff during its first three turns.
- [ ] Verify equivalent objective work and include every supporting session's cost.
- [ ] Blind and adjudicate outputs with the frozen family rubric.

The family may revise its template once after a structural failure, then recalibrate on a different case. A second failure rejects it from the full pilot.

A family advances when C is quality-equivalent or better than A, has no safety regression, and shows either a 10% calibration cost reduction or a measured replay reduction plausibly capable of reaching 20% over a full case.

### Phase 5 — Run at most two full pilots

- [ ] Select six valid cases per advancing family: two low, two medium, and two high complexity.
- [ ] Exclude calibration cases unless rerun after the template is frozen.
- [ ] Run A and C sequentially in randomized case/variant order with fresh instances.
- [ ] Include B only where pre-registered after calibration as necessary for interpretation.
- [ ] Checkpoint each variant and obey execution/time ceilings.
- [ ] Normalize and sanitize before independent blind adjudication.
- [ ] Report aggregate, per-case, and per-complexity results.
- [ ] Apply common thresholds and the family-specific quality floor.

Never pool families to manufacture a passing average.

### Phase 6 — Evaluate mechanical coordination where earned

This remains separate from rollover.

- [ ] Reuse the recorded-state rubric and canonical ownership map.
- [ ] Collect complete state/action pairs for structured families.
- [ ] Require 30 complete mechanical transitions for a family.
- [ ] Replay the existing reducer unchanged first, when one exists.
- [ ] Add a reason code or typed field only inside the existing Pocock/teammate shadow reducer, only for a repeated transition with an unambiguous canonical owner.
- [ ] Keep it pure, zero-I/O, closed-output, fail-closed, and shadow-only.
- [ ] Require 100% safety-negative agreement, at least 99% overall agreement, and zero unsafe advancement.

Never create reducers for diagnosis, implementation correctness, QA severity, task priority, synthesis, research conclusions, or architecture choices.

If generalization needs workflow-specific semantic fields, record `reducer_generalization: rejected` instead of building a policy engine.

### Phase 7 — Validate and report

- [ ] Require zero durable Agor product, package, script, schema, configuration, or test changes; temporary lab-clone changes must already be captured and removed.
- [ ] Validate temporary harness work inside the disposable clone and report it only as experiment methodology, not an Agor implementation.
- [ ] Run Pocock clean-room tests and skill validation if Pocock changed.
- [ ] Do not run repository-wide builds; record gaps that focused checks cannot cover.
- [ ] Verify snapshot/fixture hashes, path containment, disabled pushes, owned-process shutdown, released ports, and zero provider mutations.
- [ ] Verify zero experiment records or lab paths in the primary database/worktrees.
- [ ] Record primary health/port before and after when available; use database/path/process fallbacks otherwise.
- [ ] Retain the private run directory and recommend 30-day retention followed by manual archive or cleanup.

## Workflow-specific protocols

Only selected families need implementation. Freeze the applicable rubric before calibration.

### CI diagnosis and repair

**Case:** Reproducible failing checks, pinned source, captured logs, and a known accepted fix or executable verification.

**Handoff:** normalized failure signatures, checks inspected, evidence-rejected hypotheses, attempted changes/outcomes, current patch, and next required check.

**Oracle:** root-cause accuracy, patch correctness, required checks, regressions, unsupported diagnoses, and unnecessary changes.

**Quality floor:** all baseline-passing required checks pass; no new required-check regression; root-cause/fix-direction recall is at least 95%; zero unsafe retry, provider write, or stale-log decision; unsupported diagnoses are no more than baseline plus two percentage points.

Code may compare check identity, terminal state, signatures, retries, and evidence. It may not diagnose or choose a fix.

### Implementation-test-review loops

**Case:** A bounded change with pinned starting revision, acceptance contract, isolated dependencies, reproducible focused tests, and an accepted or adjudicable patch.

**Handoff:** accepted scope, changed files/symbols, invariant decisions, diff hash, test outcomes, review findings, attempted fixes, and semantic questions.

**Oracle:** acceptance and held-out tests where available, semantic diff review, scope adherence, regressions, and patch complexity.

**Quality floor:** every baseline-passing deterministic acceptance check passes; no additional high-severity defect; objective satisfaction is equivalent or better; zero unauthorized action; changed surface grows no more than 20% without adjudicated justification.

Code may enforce preselected phase/evidence gates. It may not decide semantic correctness.

### QA and validation

**Case:** A pinned build/runtime fixture with a deterministic scenario, expected observations, and retained evidence. Use repository-provided test/device/browser tooling.

**Handoff:** scenario state, environment identity, completed steps, observations, unresolved discrepancies, and reset instructions.

**Oracle:** scenario completion, observation coverage, defect detection, false alarms, traceability, and contamination.

**Quality floor:** at least 95% baseline observation/defect recall; zero missed safety-critical discrepancy; false positives no more than baseline plus two percentage points; every conclusion has evidence; zero cross-variant contamination.

Code may check step completion and evidence identity. It may not judge an ambiguous discrepancy.

### Cross-repository work

**Case:** A bounded objective spanning at least two repositories with pinned revisions, an explicit shared contract, repository-local checks, and an integration oracle.

Treat this as a family only when enough cases exist; otherwise use it as an implementation complexity stratum.

**Handoff:** shared contract revision, ownership, dependency order, interface pins, local changes/evidence, and integration questions.

**Oracle:** local checks, contract compatibility, integration tests or interface comparison, missing dependent changes, and unauthorized scope.

**Quality floor:** all baseline-passing local checks pass; integration is equivalent or better; zero missed repository required by the contract; zero stale-contract or authority violation.

### Final synthesis and reporting

**Case:** A completed multi-worker objective with pinned normalized findings, evidence, decisions, proof limits, and an accepted or adjudicable report.

**Handoff:** decisions, normalized findings, evidence map, disagreements, unresolved questions, and audience/format requirements.

**Oracle:** factual coverage, traceability, contradictions, unsupported claims, prioritization, proof limits, and actionability.

**Quality floor:** at least 95% of material facts/decisions preserved; zero new material contradiction; unsupported claims no more than baseline plus two percentage points; all high-severity findings/blockers preserved; equivalent or better usefulness.

No deterministic reducer is permitted.

### Board triage and task selection

**Case:** An immutable board/provider snapshot with explicit policy, eligibility, dependencies, and a historical or adjudicable selection.

**Handoff:** snapshot hash, priorities, filters, dependencies, commitments, and unresolved priority judgments.

**Oracle:** eligible-item recall, prohibited selections, dependency correctness, duplicate work, and priority quality.

Keep calibration-only unless six stable snapshots exist. Code may filter explicit ineligibility and duplicates; Ponytail owns priority.

**Quality floor:** zero prohibited/dependency-invalid selections, at least 95% eligible-item recall, and priority usefulness equivalent to baseline.

### Research and architecture

**Case:** A bounded question with a frozen source corpus, explicit decision criteria, and an accepted or adjudicable outcome. Do not use changing live-web results across variants.

**Handoff:** hypothesis, evidence map, rejected alternatives with concise reasons, sources, confidence, assumptions, constraints, and open questions.

**Oracle:** grounded claim coverage, alternative coverage, contradictions, unsupported claims, criteria satisfaction, and reasoning usefulness.

**Exploratory quality floor:** at least 90% material evidence/alternative coverage; zero new high-severity unsupported conclusion; every critical assumption preserved; at least 15% cost reduction.

Even if it passes, recommend a larger dedicated study rather than broad adoption. No reducer is permitted.

## Blind adjudication

Reuse the first plan's independent-adjudicator machinery:

- Strip variant/family labels, IDs, timestamps, cost/token data, execution order, and experiment commentary.
- Preserve anchors, findings, patch content, tests, and proof limits required for judgment.
- Randomize opaque labels and store the mapping outside adjudicator input.
- Use the same pinned adjudicator model/effort and frozen rubric within a case.
- Allow `equivalent` and `inconclusive`; never force a winner.
- Combine executable evidence and semantic adjudication for code changes.
- Record adjudication cost separately.

## Expected changes

### Agor repository

Allowed durable tracked changes in the primary Agor checkout:

- This plan and its `context/README.md` link.
- A sanitized Markdown result summary under `context/` only when the final report explicitly calls for one and contains no private data.

No durable changes may remain under `apps/`, `packages/`, `scripts/`, migrations, schemas, tests, root configuration, daemon behavior, CLI behavior, UI, analytics, queues, public APIs, or callback execution.

Private manifests, fixtures, prompts, rubrics, raw reports, and retained temporary patches belong below the external lab-run directory and remain untracked. Any disposable Agor clone must be removed after its patch and evidence are captured.

### Pocock repository

No Pocock change is required merely to run the portfolio.

After a family passes, make only the smallest owner-aligned change supported by evidence: a handoff example/constraint, a safe role rollover boundary, a missing deterministic-input definition, or shadow-reducer test cases using existing fields.

Use cross-agent artifact synchronization for skill changes. Do not add separate family routers or duplicate the objective lifecycle.

### Knowledge/KB

KB changes are conditional on a passing family and a verified canonical owner. Update only teammate operating knowledge, workflow contracts, or handoff guidance supported by the result. Do not place raw prompts, transcripts, private fixtures, local paths, credentials, or experiment-only state in Knowledge. Use the existing reviewed KB workflow, record the resulting revision, and validate referenced contract/policy pointers.

## Autonomous execution and blockers

The run must not depend on user decisions. Resolve questions from code, instructions, the parent manifest, fixtures, and this plan. Make conservative, reversible choices.

Continue safe work when one family becomes invalid. One failed candidate is a result, not a run-wide blocker.

Hard blockers for all live work:

- inherited isolation or primary non-interference fails;
- no unambiguous parent manifest is supplied or discoverable;
- a live candidate requires a durable Agor change rather than a safe removable lab-only adaptation;
- lab daemon/database/worktree identity cannot be proven;
- required read-only fixture authentication is unavailable;
- a provider write, push capability, schedule, gateway, or shared mutable path is detected;
- ceiling state cannot be reconstructed after resume.

Family blockers:

- too few reproducible cases;
- no stable oracle;
- source state or dependencies cannot be reconstructed;
- variants cannot receive identical pins;
- handoff calibration fails twice;
- remaining ceiling cannot complete the minimum sample.

When blocked, stop only owned lab processes, preserve artifacts/checkpoints, continue unrelated safe analysis, and report exact evidence and resume point.

## Final report

Write `<run>/portfolio-final-report.md` with:

1. Parent-run identity and inherited foundation status.
2. Revisions, environment, model/effort, duration, and ceiling usage.
3. Isolation and primary non-interference evidence.
4. Cost/frequency/context/coordinator profile for every candidate family.
5. Frozen scoring, eligibility, ranking, and selection.
6. Calibration A/B/C and handoff sufficiency by family.
7. Full A/C quality, cost, time, context, and coherence by case/complexity.
8. Oracle outcomes and blind adjudication rationales.
9. Mechanical evidence and reducer generalization decision.
10. Instrumentation, fixture, handoff, and adjudication cost.
11. Exclusions, failures, retries, limitations, and inconclusive results.
12. Changed files, commands/tests, artifact paths, and resume/reproduction command.
13. Maintenance accounting: require zero durable Agor code lines changed; report removed temporary methodology separately from retained teammate/KB/skill changes.
14. One decision per family: adopt, larger study, improve handoff, reject, or insufficient evidence.

Distinguish **verified**, **inferred**, and **unknown** claims.

## Stop and adoption decisions

| Evidence                                            | Decision                                        |
| --------------------------------------------------- | ----------------------------------------------- |
| No non-PR family is eligible                        | Stop after portfolio analysis; add no adapters  |
| Calibration fails                                   | Reject or redesign only that handoff            |
| Quality passes but savings are below 20%            | Keep current behavior for that family           |
| One structured family passes                        | Recommend a family-specific contract only       |
| Two structured families pass with the same envelope | Recommend the minimal common envelope           |
| Open-ended calibration passes                       | Recommend a larger study, not general adoption  |
| Coordinator share is low after rollover             | Do not extend the reducer                       |
| Reducer needs semantic/workflow policy fields       | Reject reducer generalization                   |
| Reducer misses any safety-negative case             | Keep Ponytail authoritative                     |
| Maintenance exceeds measured benefit                | Avoid or remove the abstraction                 |
| Isolation/input equality is unproven                | Invalidate live results; retain static analysis |

## Non-goals

- Proving one rollover policy works for every task.
- Optimizing semantic reasoning merely because it is expensive.
- Replacing an objective owner mid-objective.
- Persisting hidden reasoning or transcripts.
- Building a general benchmark, workflow-plugin, policy, or orchestration platform.
- Retaining or proposing tracked Agor application, package, script, configuration, schema, migration, CLI, UI, or test changes from this experiment.
- Making a shadow reducer authoritative.
- Modifying primary Agor, providers, trackers, repositories, PRs, CI, deploys, or boards.
- Publishing private prompts, logs, snapshots, patches, or results.
- Running every family when adaptive gates reject it.
- Automatically deleting retained evidence.

## Suggested `/goal`

```text
/goal Execute context/explorations/pocock-token-efficiency-workflow-portfolio-overnight-plan.md end to end, using the completed PR-review token-efficiency run as the parent foundation. Treat the plan as authoritative. Analyze all candidate workflow families, calibrate only eligible ones, and run full isolated comparisons for at most the top two. Durable implementation is limited to Pocock/teammate skills, contracts, teammate-owned scripts/tests, and KB files after their evidence gates pass. Temporary Agor adaptations are allowed only in a disposable push-disabled lab clone below the external run directory; never touch the primary checkout, commit, push, merge, or retain them, and remove the clone after capturing private evidence. Preserve the primary Agor instance and unrelated work, honor every resource and evidence gate, make no provider or production mutations, checkpoint all progress, and finish with the required portfolio report or an exact safe blocker/resume report.
```

## Durable takeaway

```text
Measure broadly
      |
Experiment narrowly
      |
Adopt per workflow
      |
Generalize only after independent repetition
      |
Delete machinery that does not earn its cost
```

The successful outcome may be a shared handoff contract, one workflow-specific improvement, evidence for a larger study, or a defensible decision to leave the remaining workflows unchanged.
