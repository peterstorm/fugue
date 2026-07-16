# PR Remediation Plan — Round 14

**Date:** 2026-07-10
**Branch:** feat/deterministic-core-phase-b (PR #33)
**Findings:** 0 critical, 18 advisory (after dedup across 6 agents)

All five round-13 fixes verified landed and mutation-pinned (yamlScalar team test and
REPAIRABLE_KINDS short-circuit both confirmed by executing the actual mutation). Full suite:
1912 pass / 0 fail; framework typecheck clean.

## Advisory Fixes

### Fix 1: `{{` metacharacters in authored free text splice runtime input into generated prompts
- **Source:** code-reviewer (confidence 80)
- **File:** packages/framework/src/cli/authored-codegen.ts:246 (purpose), :240 (enum values)
- **Issue:** `node.purpose` is interpolated raw into the generated prompt body; runtime
  `interpolatePrompt` (src/nodes/llm.ts:48) replaceAll-substitutes any literal `{{field}}` matching
  an input var — silent injection that passes the entire gauntlet (which never renders prompts).
  The module already guards the analogous `//`-comment context (SINGLE_LINE + LINE_TERMINATORS).
- **Fix:** Reject/escape `{{` in purpose/description/enum values at the schema (mirroring the
  single-sourced SINGLE_LINE pattern in identifiers.ts) or neutralize `{{` at the llmPrompt emission
  site. Add a test with a hostile purpose containing `{{text}}`.

### Fix 2: Terminal outcomes flatten LintError to `kind: message`, dropping stack/detail
- **Source:** silent-failure-hunter
- **Files:** packages/framework/src/cli/compose.ts:560,568; packages/framework/src/cli/new.ts:509
- **Fix:** Append `e.stack` / `e.detail` to the flattened problem strings when present (the
  repair-round feedback path already ships full objects — only terminal outcomes lose data).

### Fix 3: Anthropic missing-tool_use error omits stop_reason; max_tokens truncation retried
- **Source:** silent-failure-hunter
- **File:** packages/framework/src/llm/anthropic-client.ts:151-169
- **Fix:** Include `stop_reason` in both error messages; classify `stop_reason === "max_tokens"`
  as non-retriable; wrap sendStructured schema construction in the same `kind: "validation"`
  pre-flight OpenAI's sendStructured uses (openai-client.ts:193-200 precedent).

### Fix 4: OpenAI 200-response body unvalidated; malformed success degrades context-free
- **Source:** silent-failure-hunter
- **File:** packages/framework/src/llm/openai-client.ts:171,277-284
- **Fix:** In the `!rawText` arm, include `response.status` and a truncateErrorBody snapshot of the
  parsed body in the error message.

### Fix 5: sendWithTools schema/tool-spec construction escapes the Result boundary in both clients
- **Source:** silent-failure-hunter
- **Files:** anthropic-client.ts:197-199; openai-client.ts:334-336
- **Fix:** Wrap pre-loop zodToJsonSchema construction in a try/catch returning non-retriable
  `kind: "validation"` (same shape as OpenAI sendStructured).

### Fix 6: Mixed repairable+unrepairable verdict is unpinned (mutation survives)
- **Source:** pr-test-analyzer (mutation-executed)
- **File:** packages/framework/src/cli/compose.ts:555 (test: compose.test.ts)
- **Fix:** Add row scripting a gauntlet verdict with [import-failed, fan-in-key-mismatch] →
  assert gauntlet-failed, repairs 0, problems name only import-failed, requests.length 1.

### Fix 7: gauntlet lint-fail arm's errors/advisories threading unpinned
- **Source:** pr-test-analyzer (mutation-executed)
- **File:** packages/framework/src/cli/gauntlet.ts:107-108 (test: compose.test.ts runGauntlet block)
- **Fix:** Inject `lint: async () => ({ ok:false, errors:[…], advisories:[…] })` → assert the
  verdict carries both and staging is cleaned.

### Fix 8: aborted arm erases user-abort vs closed-stream distinction; dead problems field
- **Source:** type-design-analyzer
- **File:** packages/framework/src/cli/compose.ts:125-134 (sites :508, :606)
- **Fix:** Add `cause: "user" | "input-closed"` threaded from the abort sites; drop the always-empty
  `problems` field from the aborted arm. Update affected tests/bin rendering.

### Fix 9: gauntlet-failed / write-failed conflate "threw" with "rejected/unrepairable"
- **Source:** type-design-analyzer
- **File:** packages/framework/src/cli/compose.ts:146-161 (sites :538/:555-564, :630/:639)
- **Fix:** Add `cause: "threw" | "unrepairable-errors"` (resp. `"threw" | "rejected"`) discriminants
  matching the doc comment's own taxonomy. Also surface co-occurring repairable errors in the
  short-circuit problems list (relates to Fix 2).

### Fix 10: REPAIRABLE_KINDS element type admits unrepairable kinds
- **Source:** type-design-analyzer
- **File:** packages/framework/src/cli/compose.ts:389
- **Fix:** `export type RepairableKind = "dag-definition-error" | "fan-in-key-mismatch"` (satisfies
  LintError["kind"]) and type the set `ReadonlySet<RepairableKind>`.

### Fix 11: accept/abort/refine classification is inline stringly state
- **Source:** type-design-analyzer
- **File:** packages/framework/src/cli/compose.ts:601-644
- **Fix:** Extract pure `classifyAnswer(text): {kind:"accept"}|{kind:"abort"}|{kind:"refine";text}` +
  unit rows (unrecognized input → refine is an explicit arm).

### Fix 12: visualize.ts INPUT_ID re-declares the DAG_INPUT sentinel
- **Source:** type-design-analyzer
- **File:** packages/framework/src/cli/visualize.ts:34
- **Fix:** Import DAG_INPUT from types/ids.ts instead of the local literal.

### Fix 13: temperature?: number unconstrained at the LlmRequest seam
- **Source:** type-design-analyzer + architecture-tech-lead
- **File:** packages/framework/src/types/llm.ts:52 + both clients
- **Fix:** Pre-flight finiteness/range validation in both clients returning typed `validation`
  error (mirror the OpenAI thinking+temperature conflict precedent). Range: reject non-finite,
  <0, or >1 (common denominator; document).

### Fix 14: Unbranded nodeId/dagId on wire error types
- **Source:** type-design-analyzer
- **File:** packages/framework/src/cli/types.ts:104,128,152-157
- **Fix:** Use branded NodeId/DagId (identical JSON, proof-carrying in-process, NewResult precedent).
  If producer ripple exceeds a mechanical change, defer with notes.

### Fix 15: FIXED_IMPORT_NAME doc claims emission is kind-independent
- **Source:** comment-analyzer
- **File:** packages/framework/src/cli/identifiers.ts:227-231
- **Fix:** Reword: fixed-SPELLING names; emission gated (`ok` with fetch/transform/source,
  `confidence`/`LlmNodeDef` with llm); reservation unconditional.

### Fix 16: openai-client class doc names the Azure-only URL path
- **Source:** comment-analyzer
- **File:** packages/framework/src/llm/openai-client.ts:75
- **Fix:** "(`POST {baseUrl}/responses`; Azure: `{base}/openai/responses?api-version=…`)".

### Fix 17: Triple-duplicated repair-turn motif in runCompose
- **Source:** architecture-tech-lead
- **File:** packages/framework/src/cli/compose.ts:483-493, 573-585, 651-659
- **Fix:** Extract `correctedDraftTurn(prompt): Promise<DraftAttempt>` closing over
  turn/failClosed/parseDraftWithRepairs; each site becomes prompt construction + one call.

### Fix 18: host worker-main.ts pre-existing typecheck error reddens root `bun run typecheck`
- **Source:** pr-test-analyzer
- **File:** packages/host/src/worker-main.ts:274 (pre-existing on main, out of PR scope)
- **Fix:** If a one-line fix is evident (CapabilityHandle<"oracle"> assignability), apply it;
  otherwise defer with a note — do NOT expand PR scope into host redesign.

## Deferred

### Fix 14, dagId half — dag-definition-error.dagId stays string (implementation outcome)
- **Reason:** `DagDefinitionError.dagId` is `input.id` from the pre-validation `DagDefInput`; the
  DAG failed definition, so its id never earned the `DagId` brand. Branding would ripple through
  9 `new DagDefinitionError(...)` sites against pre-validation values — non-mechanical and
  semantically wrong. The `nodeId` half landed.

### Fix 18 — host typecheck (implementation outcome)
- **Reason:** Not a one-liner: packages/host has 17 pre-existing errors rooted in unresolvable
  `@fuguejs/http-auth` / `@fuguejs/oracle` workspace packages, which break the Capability module
  augmentation (worker-main.ts:274 is a symptom). Real fix is workspace/tsconfig resolution —
  host scope, outside this PR.
- **Recommendation:** Fix the adapter-package resolution in a dedicated host PR, or scope the
  gate command to packages/framework.

### Dual topology-consumption walks in authored-codegen (architecture-tech-lead)
- **Reason:** Structural refactor (single `consumption(dag)` map read by both emitters) — prime
  fast-check property target, but not a minimal edit. Recommend before a future phase merge.

### DescribeWarning discriminated union for prose warnings channels (type-design-analyzer)
- **Reason:** Threads a new union through NewResult/GauntletResult/VisualizeResult and consumers —
  structural. Batch with a future wire-types pass.

### Standing deferrals (rounds 10-13, unchanged): turn() retriability policy, io.ask/io.say
rethrow boundary, programmatic reserved-id derivation, duplicated scaffold writers, 8x error
formatting, sampling union, dead casts at new.ts:591/606.

## Validation Commands
```bash
cd packages/framework && bunx tsc --noEmit && bunx tsc --noEmit -p tsconfig.bin.json
bun test
```
