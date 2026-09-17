import { z } from "zod";

import { readExtensionBody } from "./http";
import { configurationSchema } from "./manifest";
import { parseStrictJson } from "./strict-json";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/);
const installationRevision = z.number().int().positive().max(2_147_483_646);
export const installRequestSchema = z
  .object({
    catalog_id: z.string().uuid(),
    publisher: slug,
    name: slug,
    version: z
      .string()
      .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
      .max(64),
    // Revisão da instalação que a tela exibiu; `null` quando ela não viu linha para a identidade.
    // Obrigatória: sem ela, uma aba antiga trocaria de versão ou desfaria uma remoção em silêncio.
    expected_installation_revision: installationRevision.nullable(),
  })
  .strict();
/** Corpo de "Desfazer a última troca" e de "Remover da instalação". */
export const installationChangeRequestSchema = z
  .object({ expected_installation_revision: installationRevision })
  .strict();
export const configureRequestSchema = z
  .object({
    expected_revision: z.number().int().min(0).max(2_147_483_646),
    enabled: z.boolean(),
    configuration: configurationSchema,
  })
  .strict();
export const openRequestSchema = z
  .object({
    capability: z.literal("tasks.open"),
    expected_revision: z.number().int().positive(),
    card_id: slug,
  })
  .strict();

export async function extensionRequestJson(request: Request): Promise<unknown> {
  const bytes = await readExtensionBody(request, 4096);
  return parseStrictJson(bytes, {
    maxBytes: 4096,
    maxDepth: 6,
    maxNodes: 64,
    maxPropertiesPerObject: 12,
  });
}
