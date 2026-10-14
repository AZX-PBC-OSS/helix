import { JobsCatalogueServersSchema, JobsDeploymentConfigSchema } from "./jobsDeployment.js";
import {
  FetchJobInputSchema,
  FetchJobResultSchema,
  JobAcceptedSchema,
  JobCancellationAcceptedSchema,
  JobErrorSchema,
  JobIdSchema,
  JobIdentitySchema,
  JobLocalTypeSchema,
  JobOwnerKindSchema,
  JobProgressSchema,
  JobReferenceSchema,
  JobRequestErrorSchema,
  JobRetryKeySchema,
  JobServerIdSchema,
  JobSnapshotSchema,
  JobStatusSchema,
  JobTypeCatalogueEntrySchema,
  JobsGenerationSchema,
  JobsLifecycleUpdateAckSchema,
  JobsLifecycleUpdateSchema,
  QualifiedJobTypeSchema,
} from "./jobs.js";

/**
 * The `JobsProtocolV1` aggregate — every schema of the jobs contract family
 * under one name: the wire contract (`./jobs.ts`), the signed instructions'
 * wire bodies, and the deployment configuration with its credential-free
 * projection (`./jobsDeployment.ts`, ADR-0007/0008: these schemas own the
 * server map's keys and requiredness).
 * Conformance fixtures address members by key, so a producer's or consumer's
 * test suite can run the identical fixture list against this aggregate (or,
 * one day, a language mirror's implementation of the same names). The
 * aggregate lives apart from the wire module only because the deployment
 * configuration imports the wire module — the one-way layering keeps a cycle
 * out of the contract family.
 */
export const JobsProtocolV1 = {
  JobServerIdSchema,
  JobLocalTypeSchema,
  QualifiedJobTypeSchema,
  JobIdSchema,
  JobReferenceSchema,
  JobOwnerKindSchema,
  JobIdentitySchema,
  JobStatusSchema,
  JobProgressSchema,
  JobErrorSchema,
  JobRequestErrorSchema,
  JobAcceptedSchema,
  JobCancellationAcceptedSchema,
  JobSnapshotSchema,
  JobRetryKeySchema,
  FetchJobInputSchema,
  FetchJobResultSchema,
  JobTypeCatalogueEntrySchema,
  JobsGenerationSchema,
  JobsLifecycleUpdateSchema,
  JobsLifecycleUpdateAckSchema,
  JobsDeploymentConfigSchema,
  JobsCatalogueServersSchema,
} as const;
export type JobsProtocolContractName = keyof typeof JobsProtocolV1;
