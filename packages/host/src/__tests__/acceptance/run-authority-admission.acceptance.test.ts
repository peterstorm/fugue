/**
 * CT-1 acceptance — Run-start authority admission.
 *
 * Every submission enters at proxyToWorker, crosses an in-process UDS
 * transport into a worker app that verifies the signed tenant header and mounts
 * createAuthMiddleware then createRunDagHandler in createRouter's order, and is
 * admitted by the wiring's admitRunAuthority. The world (acceptance-world.ts)
 * composes composeRunAuthorityWiring over fake transports only
 * (identity-fakes.ts): nothing in admission is stubbed, no AuthIdentity, plan
 * or authority is hand-built. createContext, executeDag and hitl.startRun are
 * recording observation points (CT-3 and CT-4 decide what follows admission);
 * refusals serialize through errorResponse.
 *
 * Supported domain (each row is a testcase below):
 *
 *   identity   | DAG needs               | Entra user token          | outcome
 *   -----------+-------------------------+---------------------------+-------------------------------------------
 *   admin/team | no brokered capability  | none                      | admitted agent
 *   admin/team | app capabilities        | none                      | admitted agent
 *   user       | app capabilities        | none                      | admitted user-app {initiator}
 *   user       | delegated capability    | valid, bound              | admitted user-delegated (pending on HITL)
 *   any        | unknown catalog key     | any                       | 503 capability-unknown (outranks all)
 *   any        | unmapped agent client   | any                       | 503 agent-client-unmapped
 *   admin/team | delegated capability    | any                       | 403 delegated-capability-requires-user
 *   user       | app capabilities only   | present                   | 400 delegated-token-unexpected
 *   user       | delegated, leg dark     | any                       | 503 delegation-unconfigured {missing}
 *   user       | delegated capability    | none                      | 401 delegated-token-required {audience}
 *   user       | delegated capability    | malformed / failing check | 401 delegated-token-invalid {reason}
 *   user       | delegated capability    | valid, other oid or tid   | 403 identity-binding-mismatch {field}
 *   admin/team | unbrokered host         | none                      | admitted unbrokered, exactly as before
 *
 * Unsupported (refused before admission, unchanged by this contract): no or a
 * non-Bearer Authorization (401), an unknown team token (401), a team token on
 * another team's DAG (403 forbidden), a forged X-Fugue-Tenant (never reaches
 * the worker).
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { proxyToWorker } from "../../supervisor/uds-proxy.js";
import { createAuthMiddleware } from "../../http/middleware/auth.js";
import { createRunDagHandler } from "../../http/handlers/run-dag.js";
import { errorResponse } from "../../http/response.js";
import { canonicalTeam, formatToken } from "../../domain/auth.js";
import { TENANT_HEADER_NAME, signTenantHeader } from "../../domain/tenant-header.js";
import type {
  DelegatedTokenInvalidReason,
  RunAuthorityRefusal,
  RunAuthorityRefusalHttpStatus,
} from "../../domain/run-authority-contract.js";
import type { JwtClaims } from "./support/identity-fakes.js";
import { assertNoCredentialMaterial, capturedSurfaces } from "./support/credential-sentinel.js";
import {
  ADMIN_TOKEN,
  AGENT_CLIENT,
  AGENT_ENTRA_ID,
  ALLOWED_CLIENT,
  BLUEPRINT,
  DELEGATED_HEADER,
  ENTRA_TENANT,
  SUPERVISOR_HMAC_KEY,
  TEAM_A,
  TENANT_ID,
  USER_OID,
  USER_SUB,
  acceptanceDag,
  createAcceptanceSigners,
  createAcceptanceWorld,
  identityDeploymentOf,
  nowSec,
} from "./support/acceptance-world.js";
import type {
  AcceptanceSigners,
  AcceptanceWorld,
  DeploymentShape,
  RunPathSeams,
  Submission as WorldSubmission,
  Submitted,
} from "./support/acceptance-world.js";

// ── Deployment constants ─────────────────────────────────────────────────────

const FOREIGN_TENANT = "9e8d7c6b-5a49-4382-a716-0f1e2d3c4b5a";
const UNLISTED_CLIENT = "deadbeef-4321-4cba-8fed-ba9876543210";
const OTHER_OID = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const TEAM_B = canonicalTeam("team-b");

/** The parsed test catalog (OOS-004): msgraph:files.write is deliberately absent, so it is unknown. */
const TEST_CATALOG = {
  "msgraph:mail.send": { authority: "app", resource: "graph" },
  "msgraph:calendar.read": { authority: "delegated", resource: "graph" },
} as const;

const MAIL_SEND = "msgraph:mail.send";
const CALENDAR_READ = "msgraph:calendar.read";
const FILES_WRITE = "msgraph:files.write";
const FILES_SHARE = "msgraph:files.share";

// ── DAGs ─────────────────────────────────────────────────────────────────────

const DAGS = {
  plain: acceptanceDag("plain-dag", TEAM_A, [{ id: "echo", requires: [] }]),
  app: acceptanceDag("app-dag", TEAM_A, [{ id: "send", requires: [MAIL_SEND] }]),
  delegated: acceptanceDag("delegated-dag", TEAM_A, [
    { id: "send", requires: [MAIL_SEND] },
    { id: "read", requires: [CALENDAR_READ] },
  ]),
  unknown: acceptanceDag("unknown-dag", TEAM_A, [
    { id: "write", requires: [FILES_WRITE] },
    { id: "read", requires: [CALENDAR_READ] },
    { id: "share", requires: [FILES_SHARE] },
  ]),
  hitlApp: acceptanceDag("hitl-app-dag", TEAM_A, [{ id: "send", requires: [MAIL_SEND], humanReview: true }]),
  hitlDelegated: acceptanceDag("hitl-delegated-dag", TEAM_A, [
    { id: "read", requires: [CALENDAR_READ], humanReview: true },
  ]),
  unmapped: acceptanceDag("unmapped-dag", TEAM_A, [{ id: "send", requires: [MAIL_SEND] }]),
  unmappedDelegated: acceptanceDag("unmapped-delegated-dag", TEAM_A, [{ id: "read", requires: [CALENDAR_READ] }]),
  teamB: acceptanceDag("team-b-dag", TEAM_B, [{ id: "echo", requires: [] }]),
} as const;

type DagKey = keyof typeof DAGS;

const MAPPED_DAGS: readonly DagKey[] = ["plain", "app", "delegated", "unknown", "hitlApp", "hitlDelegated", "teamB"];

// ── Signers (module-level: key generation is not under test) ─────────────────

let signers: AcceptanceSigners;

beforeAll(async () => {
  signers = await createAcceptanceSigners();
});

// ── World ────────────────────────────────────────────────────────────────────

type WorldOptions = Pick<DeploymentShape, "brokered" | "delegation">;
type World = AcceptanceWorld<DagKey, "teamA" | "teamB">;
type Submission = WorldSubmission<DagKey>;

/** The run path's production seams; the wiring module loads per world, so while it is missing each testcase fails, not collection. */
const runPathSeams = async (): Promise<RunPathSeams> => {
  const { composeRunAuthorityWiring } = await import("../../adapters/run-authority-wiring.js");
  return { proxyToWorker, createAuthMiddleware, createRunDagHandler, errorResponse, composeRunAuthorityWiring };
};

const buildWorld = async (options: WorldOptions = {}): Promise<World> =>
  createAcceptanceWorld({
    seams: await runPathSeams(),
    signers,
    dags: DAGS,
    catalog: TEST_CATALOG,
    deployment: identityDeploymentOf({ ...options, mappedDags: MAPPED_DAGS.map((k) => DAGS[k].id) }),
    variant: { kind: "behaviour", teams: { teamA: TEAM_A, teamB: TEAM_B } },
  });

// ── Assertions ───────────────────────────────────────────────────────────────

const REFUSAL_STATUS: RunAuthorityRefusalHttpStatus = {
  "capability-unknown": 503,
  "delegated-capability-requires-user": 403,
  "delegated-token-required": 401,
  "delegated-token-invalid": 401,
  "identity-binding-mismatch": 403,
  "reauthorization-initiator-mismatch": 403,
  "reauthorization-window-closed": 410,
  "reauthorization-agent-unmapped": 503,
  "reauthorization-token-required": 401,
  "delegated-token-unexpected": 400,
  "delegation-unconfigured": 503,
  "agent-client-unmapped": 503,
  "delegation-not-established": {
    refused: 403,
    "federation-rejected": 502,
    "grant-missing": 403,
    unreachable: 503,
    unconfigured: 503,
    defect: 500,
    "window-closed": 503,
  },
};

const statusOf = (refusal: RunAuthorityRefusal): number =>
  refusal.kind === "delegation-not-established"
    ? REFUSAL_STATUS["delegation-not-established"][refusal.reason]
    : REFUSAL_STATUS[refusal.kind];

const bearer = (token: string): string => `Bearer ${token}`;

/** A refused submission: the status the table gives, errorResponse's body with the typed refusal, and nothing past admission. */
const expectRefused = (world: World, submitted: Submitted, refusal: RunAuthorityRefusal, dag: DagKey): void => {
  expect(submitted.status).toBe(statusOf(refusal));
  expect(submitted.json.ok).toBe(false);
  expect(submitted.json.error).toBe("run-authority-refused");
  expect(typeof submitted.json.message).toBe("string");
  expect(submitted.json.dagId).toBe(DAGS[dag].id);
  expect(submitted.json.details).toEqual({ refusal });
  expectNothingPastAdmission(world);
};

/** Admission refusals happen before the HITL fork, concurrency and any token egress (FR-006, AS-010, AS-023). */
const expectNothingPastAdmission = (world: World): void => {
  expect(world.observed.hitlStarts).toHaveLength(0);
  expect(world.observed.concurrencyWrites).toBe(0);
  expect(world.observed.contexts).toHaveLength(0);
  expect(world.observed.executions).toHaveLength(0);
  expect(world.fakes.tokenEgress()).toBe(0);
  expect(world.fakes.onBehalfOfExchanges()).toHaveLength(0);
};

/** A statically refused token-carrying submission never reaches the signing keys. */
const expectNoJwksRequest = (world: World): void => {
  expect(world.fakes.requests.entraJwks).toHaveLength(0);
};

type Recorded = Record<string, unknown>;

const onlyContext = (world: World): Recorded => {
  expect(world.observed.contexts).toHaveLength(1);
  return world.observed.contexts[0] as Recorded;
};

const onlyHitlStart = (world: World): Recorded => {
  expect(world.observed.hitlStarts).toHaveLength(1);
  return (world.observed.hitlStarts[0] as { readonly admitted: Recorded }).admitted;
};

const INITIATOR = { realmSub: USER_SUB, entra: { oid: USER_OID, tid: ENTRA_TENANT } };

// ── Admitted ─────────────────────────────────────────────────────────────────

describe("CT-1 admitted submissions", () => {
  test("FR-018: an admin run of an app DAG is admitted as the DAG's agent", async () => {
    const world = await buildWorld();
    const res = await world.submit({ dag: "app", authorization: bearer(ADMIN_TOKEN) });
    expect(res.status).toBe(200);
    const authority = onlyContext(world);
    expect(authority.kind).toBe("agent");
    expect(authority.agentClientId).toBe(AGENT_CLIENT);
    expect(world.observed.executions).toHaveLength(1);
  });

  test("FR-018: a team-token run of its own app DAG is admitted as the DAG's agent", async () => {
    const world = await buildWorld();
    const res = await world.submit({ dag: "app", authorization: bearer(world.teamTokens.teamA) });
    expect(res.status).toBe(200);
    expect(onlyContext(world)).toMatchObject({ kind: "agent", agentClientId: AGENT_CLIENT });
  });

  test("FR-018: an admin run of a DAG with no brokered capability is admitted as the DAG's agent", async () => {
    const world = await buildWorld();
    const res = await world.submit({ dag: "plain", authorization: bearer(ADMIN_TOKEN) });
    expect(res.status).toBe(200);
    expect(onlyContext(world)).toMatchObject({ kind: "agent", agentClientId: AGENT_CLIENT });
  });

  test("FR-007: a user run needing only app capabilities is admitted user-app carrying its initiator, with no Entra token", async () => {
    const world = await buildWorld();
    const res = await world.submit({ dag: "app", authorization: bearer(await world.realmUserToken()) });
    expect(res.status).toBe(200);
    const authority = onlyContext(world);
    expect(authority.kind).toBe("user-app");
    expect(authority.agentClientId).toBe(AGENT_CLIENT);
    expect(authority.initiator).toEqual(INITIATOR);
    expect(world.fakes.requests.entraJwks).toHaveLength(0);
  });

  test("FR-007: a user HITL run needing only app capabilities reaches startRun with a user-app plan", async () => {
    const world = await buildWorld();
    const res = await world.submit({ dag: "hitlApp", authorization: bearer(await world.realmUserToken()) });
    expect(res.status).toBe(202);
    const admitted = onlyHitlStart(world);
    expect(admitted.dagId).toBe(DAGS.hitlApp.id);
    expect(admitted.ownerTeam).toBe(TEAM_A);
    expect(admitted.plan).toMatchObject({ kind: "user-app", agentClientId: AGENT_CLIENT, initiator: INITIATOR });
    expect(world.observed.concurrencyWrites).toBe(0);
  });

  test("FR-007: a user HITL run with a verified, bound Entra token reaches startRun with a user-delegated-pending plan", async () => {
    const world = await buildWorld();
    const entraToken = await world.entraUserToken();
    const res = await world.submit({
      dag: "hitlDelegated",
      authorization: bearer(await world.realmUserToken()),
      delegated: bearer(entraToken),
    });
    expect(res.status).toBe(202);
    const admitted = onlyHitlStart(world);
    const plan = admitted.plan as Recorded;
    expect(plan.kind).toBe("user-delegated-pending");
    expect(plan.agentClientId).toBe(AGENT_CLIENT);
    expect(plan.initiator).toEqual(INITIATOR);
    const access = plan.access as Recorded;
    expect(access.kind).toBe("delegating");
    expect([...(access.delegated as ReadonlyMap<string, unknown>).keys()]).toEqual([CALENDAR_READ]);
    const grant = plan.grant as { readonly token: unknown; readonly claims: Recorded };
    expect(JSON.stringify(grant.token)).toBe('"[redacted]"');
    expect(String(grant.token)).toBe("[redacted]");
    expect(grant.claims.principal).toEqual({ oid: USER_OID, tid: ENTRA_TENANT });
    expect(grant.claims.client).toBe(ALLOWED_CLIENT);
    // Establishment is startRun's bracket (CT-3): admission makes no on-behalf-of exchange.
    expect(world.fakes.onBehalfOfExchanges()).toHaveLength(0);
    expect(world.observed.concurrencyWrites).toBe(0);
  });

  test("FR-007: a user sync run with a verified, bound Entra token runs under a user-delegated authority", async () => {
    const world = await buildWorld();
    const res = await world.submit({
      dag: "delegated",
      authorization: bearer(await world.realmUserToken()),
      delegated: bearer(await world.entraUserToken()),
    });
    expect(res.status).toBe(200);
    const authority = onlyContext(world);
    expect(authority.kind).toBe("user-delegated");
    expect(authority.agentClientId).toBe(AGENT_CLIENT);
    expect(authority.initiator).toEqual(INITIATOR);
  });

  test("FR-036: the delegated header crosses proxyToWorker byte-identical and the submission is admitted", async () => {
    const world = await buildWorld();
    const presented = bearer(await world.entraUserToken());
    const res = await world.submit({
      dag: "hitlDelegated",
      authorization: bearer(await world.realmUserToken()),
      delegated: presented,
    });
    expect(res.status).toBe(202);
    expect(world.uds.exchanges).toHaveLength(1);
    expect(world.uds.exchanges[0]?.headers[DELEGATED_HEADER.toLowerCase()]).toBe(presented);
    expect(onlyHitlStart(world).plan).toMatchObject({ kind: "user-delegated-pending" });
  });
});

// ── Refused ──────────────────────────────────────────────────────────────────

describe("CT-1 refusals", () => {
  test("FR-006: an unknown brokered-namespace capability is refused capability-unknown naming every such node, ahead of every other refusal", async () => {
    const world = await buildWorld();
    const user = await world.submit({ dag: "unknown", authorization: bearer(await world.realmUserToken()) });
    expectRefused(
      world,
      user,
      {
        kind: "capability-unknown",
        capabilities: [
          { nodeId: "write", capability: FILES_WRITE },
          { nodeId: "share", capability: FILES_SHARE },
        ],
      } as unknown as RunAuthorityRefusal,
      "unknown",
    );
    const admin = await world.submit({ dag: "unknown", authorization: bearer(ADMIN_TOKEN) });
    expect(admin.status).toBe(503);
    expect((admin.json.details as { readonly refusal: Recorded }).refusal.kind).toBe("capability-unknown");
    expectNothingPastAdmission(world);
  });

  test("FR-006: a run of a DAG with no agent client mapping is refused agent-client-unmapped", async () => {
    const world = await buildWorld();
    const res = await world.submit({ dag: "unmapped", authorization: bearer(ADMIN_TOKEN) });
    expectRefused(world, res, { kind: "agent-client-unmapped", dagId: DAGS.unmapped.id } as RunAuthorityRefusal, "unmapped");
  });

  test("AS-010: an admin run requiring a delegated capability is refused naming the node and capability, before any slot or egress", async () => {
    const world = await buildWorld();
    const res = await world.submit({ dag: "delegated", authorization: bearer(ADMIN_TOKEN) });
    expectRefused(
      world,
      res,
      { kind: "delegated-capability-requires-user", nodeId: "read", capability: CALENDAR_READ } as unknown as RunAuthorityRefusal,
      "delegated",
    );
    expectNoJwksRequest(world);
  });

  test("AS-010: a team-token run requiring a delegated capability is refused, also when it carries an Entra token, with zero JWKS requests", async () => {
    const world = await buildWorld();
    const res = await world.submit({
      dag: "delegated",
      authorization: bearer(world.teamTokens.teamA),
      delegated: bearer(await world.entraUserToken()),
    });
    expectRefused(
      world,
      res,
      { kind: "delegated-capability-requires-user", nodeId: "read", capability: CALENDAR_READ } as unknown as RunAuthorityRefusal,
      "delegated",
    );
    expectNoJwksRequest(world);
  });

  test("FR-006: an agent-origin HITL run requiring a delegated capability is refused before the HITL fork", async () => {
    const world = await buildWorld();
    const res = await world.submit({ dag: "hitlDelegated", authorization: bearer(ADMIN_TOKEN) });
    expectRefused(
      world,
      res,
      { kind: "delegated-capability-requires-user", nodeId: "read", capability: CALENDAR_READ } as unknown as RunAuthorityRefusal,
      "hitlDelegated",
    );
  });

  test("FR-036: an Entra token sent to a run needing no delegation is refused delegated-token-unexpected with zero JWKS requests", async () => {
    const world = await buildWorld();
    const res = await world.submit({
      dag: "app",
      authorization: bearer(await world.realmUserToken()),
      delegated: bearer(await world.entraUserToken()),
    });
    expectRefused(world, res, { kind: "delegated-token-unexpected" }, "app");
    expectNoJwksRequest(world);
  });

  test("FR-008: with only DELEGATED_CLIENT_APPS unset, a delegated run is refused delegation-unconfigured naming that key", async () => {
    const world = await buildWorld({ delegation: { clients: undefined } });
    const res = await world.submit({
      dag: "delegated",
      authorization: bearer(await world.realmUserToken()),
      delegated: bearer(await world.entraUserToken()),
    });
    expectRefused(world, res, { kind: "delegation-unconfigured", missing: ["DELEGATED_CLIENT_APPS"] }, "delegated");
    expectNoJwksRequest(world);
  });

  test("FR-008: with only DELEGATED_SCOPE unset, a delegated run is refused delegation-unconfigured naming that key", async () => {
    const world = await buildWorld({ delegation: { scope: undefined } });
    const res = await world.submit({
      dag: "delegated",
      authorization: bearer(await world.realmUserToken()),
      delegated: bearer(await world.entraUserToken()),
    });
    expectRefused(world, res, { kind: "delegation-unconfigured", missing: ["DELEGATED_SCOPE"] }, "delegated");
    expectNoJwksRequest(world);
  });

  test("AS-022: a user run requiring delegation with no Entra token is refused 401 naming the header and the required audience", async () => {
    const world = await buildWorld();
    const res = await world.submit({ dag: "delegated", authorization: bearer(await world.realmUserToken()) });
    expectRefused(
      world,
      res,
      {
        kind: "delegated-token-required",
        requirements: [{ nodeId: "read", capability: CALENDAR_READ }],
        audience: BLUEPRINT,
      } as unknown as RunAuthorityRefusal,
      "delegated",
    );
    expect(res.json.message as string).toContain(DELEGATED_HEADER);
    expect(res.json.message as string).toContain(BLUEPRINT);
  });

  test("FR-036: a malformed delegated header is refused delegated-token-invalid{malformed} with zero JWKS requests", async () => {
    for (const malformed of ["Basic abc", "Bearer ", "Bearer not-a-jwt", `Bearer a.b`]) {
      const world = await buildWorld();
      const res = await world.submit({
        dag: "delegated",
        authorization: bearer(await world.realmUserToken()),
        delegated: malformed,
      });
      expectRefused(world, res, { kind: "delegated-token-invalid", reason: "malformed" }, "delegated");
      expectNoJwksRequest(world);
    }
  });

  const invalidTokens: readonly {
    readonly requirement: string;
    readonly reason: DelegatedTokenInvalidReason;
    readonly claims: JwtClaims;
    readonly rogue?: boolean;
  }[] = [
    { requirement: "AS-023", reason: "signature", claims: {}, rogue: true },
    { requirement: "AS-023", reason: "issuer", claims: { iss: "https://sts.windows.net/" + ENTRA_TENANT + "/" } },
    {
      requirement: "AS-023",
      reason: "tenant",
      claims: { tid: FOREIGN_TENANT },
    },
    { requirement: "AS-023", reason: "audience", claims: { aud: AGENT_ENTRA_ID } },
    { requirement: "AS-023", reason: "expired", claims: { exp: nowSec() - 3600, nbf: nowSec() - 7200, iat: nowSec() - 7200 } },
    { requirement: "AS-023", reason: "not-delegated", claims: { scp: undefined, roles: ["Mail.Send"] } },
    { requirement: "AS-023", reason: "version", claims: { ver: "1.0" } },
    { requirement: "FR-008", reason: "not-yet-valid", claims: { nbf: nowSec() + 3600 } },
  ];

  for (const row of invalidTokens) {
    test(`${row.requirement}: an Entra token failing the ${row.reason} check is refused delegated-token-invalid{${row.reason}} with no on-behalf-of exchange`, async () => {
      const world = await buildWorld();
      const token = await world.entraUserToken(row.claims, row.rogue === true ? signers.rogue : signers.entra);
      const res = await world.submit({
        dag: "delegated",
        authorization: bearer(await world.realmUserToken()),
        delegated: bearer(token),
      });
      expectRefused(world, res, { kind: "delegated-token-invalid", reason: row.reason }, "delegated");
    });
  }

  test("AS-040: a token obtained by a client not on DELEGATED_CLIENT_APPS is refused {client}, naming the check and never the azp value", async () => {
    const world = await buildWorld();
    const res = await world.submit({
      dag: "delegated",
      authorization: bearer(await world.realmUserToken()),
      delegated: bearer(await world.entraUserToken({ azp: UNLISTED_CLIENT })),
    });
    expectRefused(world, res, { kind: "delegated-token-invalid", reason: "client" }, "delegated");
    expect(res.text).not.toContain(UNLISTED_CLIENT);
    expect(JSON.stringify(world.workerLogger.lines)).not.toContain(UNLISTED_CLIENT);
  });

  test("AS-040: a token whose scp lacks DELEGATED_SCOPE is refused {scope}, naming the check and never the scp value", async () => {
    const world = await buildWorld();
    const scp = "User.Read Calendars.ReadWrite.Unlisted";
    const res = await world.submit({
      dag: "delegated",
      authorization: bearer(await world.realmUserToken()),
      delegated: bearer(await world.entraUserToken({ scp })),
    });
    expectRefused(world, res, { kind: "delegated-token-invalid", reason: "scope" }, "delegated");
    expect(res.text).not.toContain("Calendars.ReadWrite.Unlisted");
    expect(JSON.stringify(world.workerLogger.lines)).not.toContain("Calendars.ReadWrite.Unlisted");
  });

  test("AS-021: an Entra token of another oid is refused identity-binding-mismatch{oid} before any node, with no token in the audit", async () => {
    const world = await buildWorld();
    const res = await world.submit({
      dag: "delegated",
      authorization: bearer(await world.realmUserToken()),
      delegated: bearer(await world.entraUserToken({ oid: OTHER_OID })),
    });
    expectRefused(world, res, { kind: "identity-binding-mismatch", field: "oid" }, "delegated");
    assertNoCredentialMaterial(capturedSurfaces({ audit: world.auditRecords }), world.ledger.needles());
  });

  test("FR-009: a realm principal of another tenant is refused identity-binding-mismatch{tid}", async () => {
    const world = await buildWorld();
    const res = await world.submit({
      dag: "delegated",
      authorization: bearer(await world.realmUserToken({ entra_tid: FOREIGN_TENANT })),
      delegated: bearer(await world.entraUserToken()),
    });
    expectRefused(world, res, { kind: "identity-binding-mismatch", field: "tid" }, "delegated");
  });
});

// ── Laws ─────────────────────────────────────────────────────────────────────

describe("CT-1 laws", () => {
  test("FR-006: refusal precedence — capability-unknown outranks requires-user, token checks and binding", async () => {
    const world = await buildWorld();
    const admin = await world.submit({ dag: "unknown", authorization: bearer(ADMIN_TOKEN), delegated: "Bearer not-a-jwt" });
    expect((admin.json.details as { readonly refusal: Recorded }).refusal.kind).toBe("capability-unknown");
    const user = await world.submit({
      dag: "unknown",
      authorization: bearer(await world.realmUserToken({ entra_oid: OTHER_OID })),
      delegated: bearer(await world.entraUserToken({ aud: AGENT_ENTRA_ID })),
    });
    expect((user.json.details as { readonly refusal: Recorded }).refusal.kind).toBe("capability-unknown");
    expectNothingPastAdmission(world);
    expectNoJwksRequest(world);
  });

  test("FR-006: refusal precedence — agent-client-unmapped outranks delegated-capability-requires-user", async () => {
    const world = await buildWorld();
    const res = await world.submit({ dag: "unmappedDelegated", authorization: bearer(ADMIN_TOKEN) });
    expectRefused(world, res, { kind: "agent-client-unmapped", dagId: DAGS.unmappedDelegated.id } as RunAuthorityRefusal, "unmappedDelegated");
  });

  test("FR-008: refusal precedence — a dark delegation leg outranks token-required and every token check, with zero JWKS requests", async () => {
    const world = await buildWorld({ delegation: { clients: undefined, scope: undefined } });
    const noToken = await world.submit({ dag: "delegated", authorization: bearer(await world.realmUserToken()) });
    expect((noToken.json.details as { readonly refusal: Recorded }).refusal).toEqual({
      kind: "delegation-unconfigured",
      missing: ["DELEGATED_CLIENT_APPS", "DELEGATED_SCOPE"],
    });
    const badToken = await world.submit({
      dag: "delegated",
      authorization: bearer(await world.realmUserToken()),
      delegated: bearer(await world.entraUserToken({}, signers.rogue)),
    });
    expect((badToken.json.details as { readonly refusal: Recorded }).refusal.kind).toBe("delegation-unconfigured");
    expectNothingPastAdmission(world);
    expectNoJwksRequest(world);
  });

  test("AS-023: claim checks refuse in AD-7's order — signature before every claim, audience before expiry, a token check before binding", async () => {
    const world = await buildWorld();
    const realm = bearer(await world.realmUserToken());
    const cases: readonly { readonly token: string; readonly reason: string }[] = [
      { token: await world.entraUserToken({ aud: AGENT_ENTRA_ID, exp: nowSec() - 3600 }, signers.rogue), reason: "signature" },
      { token: await world.entraUserToken({ ver: "1.0", iss: "https://sts.windows.net/x/" }), reason: "version" },
      { token: await world.entraUserToken({ aud: AGENT_ENTRA_ID, exp: nowSec() - 3600, nbf: nowSec() - 7200 }), reason: "audience" },
      { token: await world.entraUserToken({ azp: UNLISTED_CLIENT, scp: "User.Read" }), reason: "client" },
      { token: await world.entraUserToken({ oid: OTHER_OID, exp: nowSec() - 3600, nbf: nowSec() - 7200 }), reason: "expired" },
    ];
    for (const c of cases) {
      const res = await world.submit({ dag: "delegated", authorization: realm, delegated: bearer(c.token) });
      expect((res.json.details as { readonly refusal: Recorded }).refusal).toEqual({ kind: "delegated-token-invalid", reason: c.reason });
    }
    expectNothingPastAdmission(world);
  });

  test("AS-023: every refusal status is the one the refusal table gives, served through errorResponse", async () => {
    const world = await buildWorld();
    const realm = bearer(await world.realmUserToken());
    const submissions: readonly Submission[] = [
      { dag: "unknown", authorization: bearer(ADMIN_TOKEN) },
      { dag: "unmapped", authorization: bearer(ADMIN_TOKEN) },
      { dag: "delegated", authorization: bearer(ADMIN_TOKEN) },
      { dag: "app", authorization: realm, delegated: bearer(await world.entraUserToken()) },
      { dag: "delegated", authorization: realm },
      { dag: "delegated", authorization: realm, delegated: bearer(await world.entraUserToken({ ver: "1.0" })) },
      { dag: "delegated", authorization: realm, delegated: bearer(await world.entraUserToken({ oid: OTHER_OID })) },
    ];
    for (const s of submissions) {
      const res = await world.submit(s);
      const refusal = (res.json.details as { readonly refusal: RunAuthorityRefusal }).refusal;
      expect(res.status).toBe(statusOf(refusal));
      expect(res.json.error).toBe("run-authority-refused");
    }
    expectNothingPastAdmission(world);
  });
});

// ── Admin and team paths, unchanged (FR-018) ─────────────────────────────────

describe("CT-1 admin and team paths", () => {
  test("FR-018: a submission with no Authorization header is 401 before admission", async () => {
    const world = await buildWorld();
    const res = await world.submit({ dag: "app" });
    expect(res.status).toBe(401);
    expect(res.json.error).toBe("unauthorized");
    expect(res.response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expectNothingPastAdmission(world);
  });

  test("FR-018: an unknown team token is 401 invalid bearer token before admission", async () => {
    const world = await buildWorld();
    const res = await world.submit({ dag: "app", authorization: bearer(formatToken(new Uint8Array(32).fill(7))) });
    expect(res.status).toBe(401);
    expect(res.json.error).toBe("unauthorized");
    expectNothingPastAdmission(world);
  });

  test("FR-018: a team token on another team's DAG is 403 forbidden before admission", async () => {
    const world = await buildWorld();
    const res = await world.submit({ dag: "teamB", authorization: bearer(world.teamTokens.teamA) });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("forbidden");
    expectNothingPastAdmission(world);
  });

  test("FR-018: on an unbrokered host an admin run is admitted unbrokered, its requirements passed through", async () => {
    const world = await buildWorld({ brokered: false });
    const res = await world.submit({ dag: "app", authorization: bearer(ADMIN_TOKEN) });
    expect(res.status).toBe(200);
    const authority = onlyContext(world);
    expect(authority.kind).toBe("unbrokered");
    expect(authority.principal).toEqual({ kind: "agent" });
    expect([...((authority.access as Recorded).passThrough as ReadonlySet<string>)]).toEqual([MAIL_SEND]);
    expect(world.fakes.tokenEgress()).toBe(0);
  });

  test("FR-018: on an unbrokered host a team-token run is admitted unbrokered and another team's DAG stays 403", async () => {
    const world = await buildWorld({ brokered: false });
    const own = await world.submit({ dag: "plain", authorization: bearer(world.teamTokens.teamA) });
    expect(own.status).toBe(200);
    expect(onlyContext(world)).toMatchObject({ kind: "unbrokered", principal: { kind: "agent" } });
    const other = await world.submit({ dag: "teamB", authorization: bearer(world.teamTokens.teamA) });
    expect(other.status).toBe(403);
    expect(other.json.error).toBe("forbidden");
  });
});

// ── Through the supervisor proxy (FR-036) ────────────────────────────────────

describe("CT-1 through proxyToWorker", () => {
  test("FR-036: a forged X-Fugue-Tenant never reaches the worker; only the supervisor's signed value does", async () => {
    const world = await buildWorld();
    const res = await world.submit({
      dag: "hitlDelegated",
      authorization: bearer(await world.realmUserToken()),
      delegated: bearer(await world.entraUserToken()),
      forgedTenant: "acme.0000000000000000000000000000000000000000000000000000000000000000",
    });
    expect(res.status).toBe(202);
    expect(world.uds.exchanges[0]?.headers[TENANT_HEADER_NAME.toLowerCase()]).toBe(
      signTenantHeader(SUPERVISOR_HMAC_KEY, TENANT_ID),
    );
  });

  test("FR-036: a refusal keeps the worker's status and body across the proxy", async () => {
    const world = await buildWorld();
    const res = await world.submit({ dag: "delegated", authorization: bearer(await world.realmUserToken()) });
    expect(res.status).toBe(401);
    const exchange = world.uds.exchanges[0];
    expect(exchange?.status).toBe(res.status);
    expect(exchange?.body).toBe(res.text);
    expect((res.json.details as { readonly refusal: Recorded }).refusal.kind).toBe("delegated-token-required");
  });

  test("FR-036: no proxy log line carries the delegated token, also when the worker is unreachable", async () => {
    const world = await buildWorld();
    const realm = bearer(await world.realmUserToken());
    const presented = bearer(await world.entraUserToken());
    await world.submit({ dag: "hitlDelegated", authorization: realm, delegated: presented });
    world.uds.setReachable(false);
    await expect(world.submit({ dag: "hitlDelegated", authorization: realm, delegated: presented })).rejects.toThrow(
      "proxyToWorker failed",
    );
    expect(world.proxyLogger.lines.length).toBeGreaterThan(0);
    assertNoCredentialMaterial(capturedSurfaces({ logs: world.proxyLogger.lines, errors: world.errors }), world.ledger.needles());
  });
});

// ── No credential material at run start (AS-037) ─────────────────────────────

describe("CT-1 credential material", () => {
  test("AS-037: no sentinel realm or Entra user token, nor any encoding or segment of one, appears on any run-start surface", async () => {
    const world = await buildWorld();
    const realm = bearer(await world.realmUserToken());
    const battery: readonly Submission[] = [
      { dag: "app", authorization: realm },
      { dag: "hitlApp", authorization: realm },
      { dag: "hitlDelegated", authorization: realm, delegated: bearer(await world.entraUserToken()) },
      { dag: "delegated", authorization: realm, delegated: bearer(await world.entraUserToken()) },
      { dag: "unknown", authorization: realm, delegated: bearer(await world.entraUserToken()) },
      { dag: "unmapped", authorization: realm },
      { dag: "delegated", authorization: bearer(ADMIN_TOKEN), delegated: bearer(await world.entraUserToken()) },
      { dag: "app", authorization: realm, delegated: bearer(await world.entraUserToken()) },
      { dag: "delegated", authorization: realm },
      { dag: "delegated", authorization: realm, delegated: "Bearer not-a-jwt" },
      { dag: "delegated", authorization: realm, delegated: bearer(await world.entraUserToken({}, signers.rogue)) },
      { dag: "delegated", authorization: realm, delegated: bearer(await world.entraUserToken({ iss: "https://evil.example/v2.0" })) },
      { dag: "delegated", authorization: realm, delegated: bearer(await world.entraUserToken({ tid: FOREIGN_TENANT })) },
      { dag: "delegated", authorization: realm, delegated: bearer(await world.entraUserToken({ aud: AGENT_ENTRA_ID })) },
      { dag: "delegated", authorization: realm, delegated: bearer(await world.entraUserToken({ azp: UNLISTED_CLIENT })) },
      { dag: "delegated", authorization: realm, delegated: bearer(await world.entraUserToken({ exp: nowSec() - 3600, nbf: nowSec() - 7200 })) },
      { dag: "delegated", authorization: realm, delegated: bearer(await world.entraUserToken({ nbf: nowSec() + 3600 })) },
      { dag: "delegated", authorization: realm, delegated: bearer(await world.entraUserToken({ scp: undefined })) },
      { dag: "delegated", authorization: realm, delegated: bearer(await world.entraUserToken({ scp: "User.Read" })) },
      { dag: "delegated", authorization: realm, delegated: bearer(await world.entraUserToken({ ver: "1.0" })) },
      { dag: "delegated", authorization: realm, delegated: bearer(await world.entraUserToken({ oid: OTHER_OID })) },
      { dag: "delegated", authorization: bearer(await world.realmUserToken({ exp: nowSec() - 3600 })) },
    ];
    for (const s of battery) await world.submit(s);

    // The admitted ones were admitted; every response is captured.
    expect(world.observed.hitlStarts.length).toBe(2);
    expect(world.responses).toHaveLength(battery.length);

    assertNoCredentialMaterial(
      capturedSurfaces({
        httpResponses: world.responses.map((r) => ({
          status: r.status,
          headers: Object.fromEntries(r.response.headers),
          body: r.text,
        })),
        logs: [...world.workerLogger.lines, ...world.proxyLogger.lines],
        audit: world.auditRecords,
        spans: world.spans,
        errors: world.errors,
        origins: [...world.observed.contexts, ...world.observed.executions, ...world.observed.hitlStarts],
      }),
      world.ledger.needles(),
    );
  });
});
