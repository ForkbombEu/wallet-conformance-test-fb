import { z } from "zod";

import { OrchestratorError } from "@/orchestrator/errors";

const credentialOfferSchema = z
  .object({
    authorization_server: z.string().url().optional(),
    credential_configuration_ids: z.array(z.string()).min(1),
    credential_issuer: z.string().url(),
    grants: z
      .object({
        authorization_code: z
          .object({
            issuer_state: z.string().optional(),
            scope: z.string().optional(),
          })
          .passthrough()
          .optional(),
        "urn:ietf:params:oauth:grant-type:pre-authorized_code": z
          .object({
            "pre-authorized_code": z.string(),
            tx_code: z.unknown().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type CredentialOfferContext = z.infer<typeof credentialOfferSchema>;

export function parseCredentialOfferContext(
  offer: unknown,
): CredentialOfferContext {
  const parsed = credentialOfferSchema.safeParse(offer);
  if (!parsed.success) {
    throw new OrchestratorError(
      `Credential offer is invalid: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`,
      "CREDENTIAL_OFFER_INVALID",
    );
  }
  return parsed.data;
}
