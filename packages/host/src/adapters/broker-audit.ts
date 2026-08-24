/**
 * Broker Audit — the correlated mint/refusal record emitted over the EXISTING
 * tracer/log spine (`shared.tracer` / `shared.logger`). Every authority decision
 * the broker makes — a successful mint AND a fail-closed refusal — produces
 * exactly one record carrying the five correlation fields: `sub`, `azp`, `runId`,
 * `nodeId`, and the requested `scope`.
 *
 * @satisfies US6 — every mint and every refusal emits a correlated record.
 * @satisfies FR-X-004 — mint AND refusal each emit a record with sub/azp/runId/
 *   nodeId/scope; 100% coverage.
 * @satisfies SC-009 — 100% of mints and 100% of refusals produce a correlated
 *   record with those five fields.
 *
 * Design: this module is a thin, PURE-INPUT emitter. It does not decide whether
 * to mint — the broker does — it only records the decision the broker already
 * made. `sub` is OPTIONAL on the record (an agent-initiated hop has no end-user
 * subject); modelling it absent (rather than an empty-string sentinel) keeps the
 * "no user" state honest. The record is emitted on BOTH the structured log
 * (operator-queryable) and inside a tracer span (trace-correlated) so the audit
 * survives whichever spine an operator queries.
 */

import { safeErrorMessage } from "@fuguejs/framework";
import type { Tracer, RunId, NodeId } from "@fuguejs/framework";
import type { LogPort } from "../ports.js";

/**
 * The correlation envelope shared by every audit record. `sub` is absent for an
 * agent-initiated hop (no end-user subject); present and equal to the user's
 * subject for a user-initiated hop. `azp` is always the agent client. `scope` is
 * the downstream scope STRING the hop requested (the same name `requires` carried).
 */
export interface BrokerAuditFields {
  /** End-user subject — present only for user-initiated hops. */
  readonly sub?: string;
  /** Authorized agent client id — always present. */
  readonly azp: string;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  /** The requested downstream scope string (e.g. `"msgraph:mail.send"`). */
  readonly scope: string;
}

/**
 * The outcome an audit record describes. A discriminated union, not a boolean
 * plus optional fields: a `mint` carries the authority strategy that succeeded;
 * a `refusal` carries the typed reason it was denied. Illegal blends (a refusal
 * with a "minted via" tag) are unrepresentable.
 */
type BrokerAuditOutcome =
  | {
      readonly result: "mint";
      readonly via: "client_credentials" | "token-exchange-v2";
      /**
       * Whether THIS resolution performed the token egress (`"minted"`) or
       * reused existing authority (`"cache-reuse"` — a cache hit or a shared
       * in-flight acquisition). Witnessed from the branch actually taken, so
       * the count of `acquisition: "minted"` records equals the count of real
       * token requests — making SC-008 (≤1 token request per triple per TTL)
       * verifiable from the production audit trail, not just from
       * call-recording fakes.
       */
      readonly acquisition: "minted" | "cache-reuse";
    }
  | { readonly result: "refusal"; readonly reason: string };

/**
 * Build the structured data payload for a record. Pure — exported so the field
 * set (the SC-009 five fields + outcome) is assertable without standing up a
 * tracer. `sub` is included only when present, so an agent hop's record has no
 * `sub` key at all rather than a null/empty one.
 */
export const brokerAuditPayload = (
  fields: BrokerAuditFields,
  outcome: BrokerAuditOutcome,
): Record<string, unknown> => ({
  ...(fields.sub !== undefined ? { sub: fields.sub } : {}),
  azp: fields.azp,
  runId: fields.runId as string,
  nodeId: fields.nodeId as string,
  scope: fields.scope,
  result: outcome.result,
  ...(outcome.result === "mint"
    ? { via: outcome.via, acquisition: outcome.acquisition }
    : { reason: outcome.reason }),
});

/**
 * A bound audit emitter over the shared tracer + logger spine. The broker calls
 * `mint(...)` on every successful authority resolution and `refusal(...)` on
 * every fail-closed denial. Both wrap the emission in a tracer span (so the
 * record is trace-correlated) and write one structured log line (so it is
 * operator-queryable). Returns nothing — auditing NEVER alters control flow:
 * a throwing/rejecting tracer or logger is caught and swallowed-to-fallback
 * INSIDE the emitter (A2), so `mintFor`'s `Promise<Result<…>>` contract holds
 * (a minted-then-cached token is never lost as a thrown audit failure).
 */
export interface BrokerAudit {
  readonly mint: (
    fields: BrokerAuditFields,
    via: "client_credentials" | "token-exchange-v2",
    acquisition: "minted" | "cache-reuse",
  ) => Promise<void>;
  readonly refusal: (fields: BrokerAuditFields, reason: string) => Promise<void>;
}

/** Last-resort audit breadcrumb that bypasses the structured logger. */
const writeAuditFallback = (message: string): void => {
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    // stderr itself is unavailable — nothing further is possible.
  }
};

/**
 * Construct a `BrokerAudit` over the host's existing tracer and logger. The span
 * name discriminates mint vs refusal so a trace query can count each; the log
 * message mirrors it. Both carry the identical five-field payload.
 */
export const createBrokerAudit = (tracer: Tracer, logger: LogPort): BrokerAudit => {
  const emit = async (
    fields: BrokerAuditFields,
    outcome: BrokerAuditOutcome,
  ): Promise<void> => {
    const payload = brokerAuditPayload(fields, outcome);
    const spanName =
      outcome.result === "mint" ? "capability.broker.mint" : "capability.broker.refusal";
    // Auditing NEVER alters control flow (A2): a throwing tracer or logger must
    // not propagate out of the broker's `mintFor` (whose contract is a typed
    // Result, not a rejected Promise) — on the success path the token is already
    // minted+cached, so a throw here would lose it as an exception. Catch and
    // swallow to a last-resort log; if even that throws, there is nothing left
    // to do but stay silent rather than reject.
    try {
      await tracer.withSpan(spanName, "capability-broker", async () => {
        if (outcome.result === "mint") {
          logger.info("capability broker minted authority", payload);
        } else {
          logger.warn("capability broker refused authority", payload);
        }
      });
    } catch (auditErr) {
      try {
        logger.error("capability broker audit emission failed — record may be lost", {
          ...payload,
          auditError: safeErrorMessage(auditErr),
        });
      } catch (loggerError) {
        writeAuditFallback(
          `capability broker audit emission failed — record may be lost; ` +
            `result=${outcome.result} runId=${fields.runId} nodeId=${fields.nodeId} ` +
            `scope=${fields.scope}; audit failure=${safeErrorMessage(auditErr)}; ` +
            `logger failure=${safeErrorMessage(loggerError)}`,
        );
      }
    }
  };

  return {
    mint: (fields, via, acquisition) => emit(fields, { result: "mint", via, acquisition }),
    refusal: (fields, reason) => emit(fields, { result: "refusal", reason }),
  };
};
