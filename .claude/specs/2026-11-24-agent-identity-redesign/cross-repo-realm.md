# Cross-repo realm work: agent identity redesign

Companion to `.claude/plans/2026-11-24-agent-identity-redesign.md`, section "Cross-Repo Realm Work". Moved here verbatim in loop-back 11 (condensation) to keep the plan within its read budget; no change. This work is executed outside the Fugue task graph, by the operator or a separate session in the worktree `/home/peterstorm/dev/java/keycloakConfigAsCode-agent-identity` (branch `feat/fugue-agent-identity`). The interface contract with the host stays in the plan.

Package root: `java-configuration/src/main/java/dk/secondbrand/keycloak/configuration/fugueplatform/`. Tests: `java-configuration/src/test/java/dk/secondbrand/keycloak/configuration/fugueplatform/`. The style is functional: pure `Optional<String>` violation functions in the `*Checks` classes, the `dk.oister` `Either` at the boundary, and jqwik property tests.

## R1: Entra object id and tenant into user tokens (FR-030, AS-015)

- `steps/AzureIdpStep.java`: add two attribute-importer mappers through `IdpPlanBuilder.attributeImporterMapper`, with `forceSync()`: claim `oid` → user attribute `entra_oid`, and claim `tid` → user attribute `entra_tid`.
- New `steps/UserProfileStep.java`: declare `entra_oid` and `entra_tid` in the realm user profile (`PUT /admin/realms/{realm}/users/profile`), with `view: [admin, user]` and `edit: [admin]`. Users cannot forge binding attributes through the account console. Merge into the existing profile config by attribute name, which is idempotent.
- `FuguePlatformConstants.java`: add `ENTRA_OID_ATTRIBUTE`, `ENTRA_TID_ATTRIBUTE`, `ENTRA_IDENTITY_SCOPE = "fugue-entra-identity"` and the claim names.
- `steps/ClientScopesStep.java`: create the `fugue-entra-identity` client scope with two `oidc-usermodel-attribute-mapper` protocol mappers (attribute → claim, access token only, `String`). New model record `EntraIdentityClaimMapper.java` beside `AudienceMapper.java`.
- `steps/ClientStep.java`: assign `fugue-entra-identity` as a default client scope on every `FrontendSso` client, and never on an `AgentServiceAccount`.

## R2: No user exchange in the realm (FR-031, AS-016)

- `FuguePlatformClient.java`: both variants carry `standardTokenExchangeEnabled = false`. `ClientStep` pins the attribute `standard.token.exchange.enabled=false` on every Fugue client, as it already does for `pinFullScopeDisabled`.
- `steps/FuguePlatformClientChecks.java`: a pure `tokenExchangeEnabledViolation(ClientRepresentation) → Optional<String>` that names the client.
- `steps/ValidationStep.java`: run it for every Fugue client. Any violation fails with the client named.

## R3: Exact scope assignment and Entra-exchange placement (FR-032, AS-017)

- Keep `validateClientScopeAssignment` as an exact comparison. Report both missing and unexpected grants (default and optional), in two separate lists in the message.
- New pure checks in `FuguePlatformClientChecks.java`:
  - `entraExchangeOnFrontendViolation`: `entra-exchange` assigned, default or optional, to any `FrontendSso` client.
  - `agentAssertionAudienceViolation`: an agent client with any audience mapper other than through `entra-exchange`, or a capability scope that carries an audience mapper.
- `validateNoFugueScopesAreRealmDefault` also covers realm default-optional scopes for `entra-exchange` and `fugue-entra-identity` (the second must be a client default on frontends, never realm-wide).
- A missing `entra_oid`/`entra_tid` mapper on `fugue-entra-identity`, or a missing IdP importer mapper, is a validation failure (SC-005, "missing object id mapper").

## R4: Stop storing broker tokens (FR-035)

- `steps/AzureIdpStep.java`: replace `.storeTokens()` with `.dontStoreTokens()` and `.disableReadTokenRole()`.
- `steps/FuguePlatformAzureBrokerChecks.java`: `storeTokenViolation` fails when the `azuread` IdP has `storeToken=true`.
- Runbook note (Fugue side, Phase 6): purge previously stored broker tokens by deleting federated-identity token data, or force re-login.

## R5: Idempotent reconcile or explicit reject (FR-034, AS-018)

- Every step compares desired and actual state. A step updates in place when the object is reconcilable, and otherwise returns `Either.left(Violation)`, naming the object, for a pre-existing malformed client, scope or mapper. Examples of malformed: a mapper of the wrong type under an expected name, or a client with the wrong protocol. Nothing is silently skipped.
- Re-applying to a conforming realm makes zero admin writes. Assert this with the existing diff machinery (`diff/RealmDiffRunner`): the change set is empty.

## R6 (P3): Opt-in predictable service-account subject (FR-033, AS-019)

- `FuguePlatformRealmConfig.java`: add `predictableServiceAccountSubject: boolean`, default `false`.
- When it is on, `ClientStep` adds a hardcoded-claim protocol mapper on each `AgentServiceAccount` that emits `sub = "service-account-" + clientId` in access tokens. The `FuguePlatformClientChecks.predictableSubjectViolation` check verifies that the mapper exists with the derived value.
- The external integration test proves that Keycloak 26.8.2 emits the overridden `sub` on client_credentials. If it does not, the feature stays off, and the runbook records that FICs are created after the client exists.

## Types

- `EntraIdentityClaimMapper` (record: name, userAttribute, claimName)
- `UserProfileAttribute` (record: name, viewRoles, editRoles)
- `Violation` (record: subject, message), used by every new check
- `FuguePlatformClient` variants extended with token-exchange pinning
- `FuguePlatformRealmConfig` extended with `predictableServiceAccountSubject`

## Tests

- `steps/FuguePlatformClientChecksTest.java`: jqwik properties. Each new check returns a violation iff its seeded misconfiguration is present, and the violation names the offender.
- `steps/FuguePlatformAzureBrokerChecksTest.java`: `storeToken` and the importer-mapper checks.
- `FuguePlatformRealmGoldenTest.java`: update `golden-realm-export-fugue-platform.json`. The export must be byte-identical on re-apply.
- `FuguePlatformRealmExternalIntegrationTest.java` (`-DEXTERNAL_INTEGRATION_TESTS=true`):
  - A frontend user token carries `entra_oid` and `entra_tid`.
  - An agent mint with `scope="entra-exchange msgraph:mail.send"` yields `aud` = exactly `api://AzureADTokenExchange` with both scopes.
  - An unassigned scope yields `invalid_scope` or an omitted scope (the observed behaviour is recorded in the runbook).
  - Token exchange is refused for agent clients.
  - Re-apply makes zero changes.
  - With R6 on, `sub` is predictable.

## Acceptance

- `mvn -pl java-configuration test` passes, and the external integration test passes against a local Keycloak 26.8.2.
- Every SC-005 seeded misconfiguration is detected:
  - token exchange on an agent
  - `entra-exchange` as a realm default or on a frontend
  - a missing object id mapper
  - an unexpected or missing scope grant
- The golden export is updated, and re-apply makes zero changes.
