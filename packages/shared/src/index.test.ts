import { describe, expect, it } from "vitest";
import * as shared from "./index.js";

/**
 * The barrel is the package's public surface: the portal, the SPA, and the
 * published CLI all import from `@azx-pbc/shared`, never from a deep path —
 * and the provider contracts are exported here so the reader features can
 * consume one definition. Nothing imports the provider surface yet, so no
 * other check notices a dropped or narrowed re-export: typecheck passes with
 * no importer to fail, and the providers suite itself imports the deep path.
 * This pins the export contract itself. Presence only — widening the barrel
 * with new exports is non-breaking by design, so the list below names the
 * contracted surface, not the whole module.
 */
describe("the shared barrel", () => {
  it("re-exports the provider domain and the header-name rule it composes", () => {
    for (const name of [
      "PROVIDER_KINDS",
      "ProviderKindSchema",
      "ProviderRefSchema",
      "TokenPlacementSchema",
      "TOKEN_PLACEMENT_KINDS",
      "ScopeTokenSchema",
      "ApiOriginSchema",
      "ProviderConfigSchema",
      "ProviderCreateRequestSchema",
      "ProviderUpdateRequestSchema",
      "ConnectionProviderSchema",
      "ProviderMetadataSchema",
      "ProviderExportDocumentSchema",
      "CatalogueProviderSchema",
      "SENSITIVE_PROVIDER_FIELDS",
      "HeaderNameSchema",
      "OAuthEndpointSchema",
      "ProviderDisplayNameSchema",
      "RequestedScopesSchema",
      "ApiOriginsSchema",
    ]) {
      expect(Object.hasOwn(shared, name), name).toBe(true);
    }
  });

  it("re-exports the background-jobs wire contract and its conformance fixtures", () => {
    for (const name of [
      "JobsProtocolV1",
      "JobReferenceSchema",
      "JobIdentitySchema",
      "JobAcceptedSchema",
      "JobCancellationAcceptedSchema",
      "JobSnapshotSchema",
      "JobErrorSchema",
      "JobRequestErrorSchema",
      "FetchJobInputSchema",
      "FetchJobResultSchema",
      "JobErrorMessages",
      "JOB_TYPE_CATALOGUE",
      "JOBS_MAX_INPUT_BYTES",
      "JOBS_MAX_RESULT_BYTES",
      "JOBS_RETRY_KEY_MAX_BYTES",
      "IDEMPOTENCY_KEY_HEADER",
      "JobsGenerationSchema",
      "JobsLifecycleUpdateSchema",
      "JobsLifecycleUpdateAckSchema",
      "JOBS_PROTOCOL_FIXTURES",
      "runJobsProtocolFixtures",
    ]) {
      expect(Object.hasOwn(shared, name), name).toBe(true);
    }
  });
});
