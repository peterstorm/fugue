# Implementation Notes (from plan design review 6)

The sixth plan design review (`.claude/reviews/standalone-review-runs/run.fuIIQW5x2P`) found 0 criticals and 11 advisories. Plan edits stopped there, decided under the user's delegation, because:

- the plan was at 225.5K of the engine's 240K review read budget;
- six reviews had found zero criticals between them;
- every pass kept turning up about ten refinements.

Each advisory below is carried to execution. The orchestrator attaches the matching note to the brief of the Task that builds the code, using `helper orchestration brief --note`. The Wave Gate reviewers then judge the code against the plan and against these notes. The published disposition records the decision for every advisory.

Status: **A** means accepted and must be implemented. **D** means deferred: the implementer may adopt it, and the distill/deepen pass weighs it.

| ID | Status | Applies to | Note |
|----|--------|------------|------|
| IN-1 | A | CT-1 types; `validateEntraUserTokenClaims` | `ClaimRefusal` admits `malformed`. The validator returns it for a missing or non-GUID `oid`, and for a missing or non-numeric `exp`/`nbf`. The property "accepts iff all constraints hold" covers these inputs. |
| IN-2 | A | `classifyTokenEndpointError` | Add an explicit default row per hop × grant. An unlisted 4xx or AADSTS code is never projected to the retriable `unreachable`. Mapping: realm and client_credentials → `unconfigured{why:"rejected"}`; federation → `federation-rejected{reason:"unknown"}`; on-behalf-of/refresh → `refused`. The property test asserts that no 4xx maps to `unreachable`. |
| IN-3 | A | `withEstablishedAuthority` (sync), `establishDelegation` | The sync custody expiry comes from the clock read taken after the on-behalf-of exchange, plus the route timeout. That way the custody window covers the whole pipeline timer that starts inside `body`. Test: in a delegated sync run, the last node, running near the timeout, still mints. |
| IN-4 | A | `parseRunAccess` | Refuse a record whose map key differs from `capability.name`. Add a property-test row for it. |
| IN-5 | D | `RunAccess` | Optional strengthening: one name-keyed map of discriminated `AccessEntry`, with the delegating variant as a tagged view that guarantees a non-empty delegated set. |
| IN-6 | A | Phase 4 cut-over: `RunRecord` | The `RunRecord` read view holds the bare `RunAuthority`. `boundAuthorityOf(record)` derives the `BoundAuthority` from `record.runId` where it is used, so no constructed record can pair mismatched run ids. |
| IN-7 | D | CT-1 types; capability catalog | Make the import direction one-way: the catalog imports the leaf types (`AuthorityMode`, `AdmittedCapability`). `CapabilityScope`'s module-private symbol stays in the catalog. |
| IN-8 | D | `domain/run-authority.ts` | Candidate split for the distill/deepen pass: a run-access module (`RunAccess`, `accessOf`, `parseRunAccess`, `routeRequirement`, `parseBoundAuthority`, `originOf`) and the planner. |
| IN-9 | A | Lifecycle; `hitl/service.ts` | An executor or queue failure that is not a settled outcome still releases custody through the INV-4 owner. Use a `processing-abandoned` `HitlRunEnding`, or route `processRun`'s catch-all through `endRun`. Add a matrix-test row. |
| IN-10 | A | Lifecycle; run store | One pure `hitlRunDeadlineOf(now, ttl)`, used by both the HITL service and the run store. |
| IN-11 | D | Lifecycle; `run-composition.ts` | Candidate for the distill/deepen pass: fold `RunMintingAuthority` → `mintingAuthorityOf` so that the body receives a ready `MintingAuthority \| undefined` built with the run's meter. |
