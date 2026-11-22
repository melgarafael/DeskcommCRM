import { z } from "zod";

import { readExtensionBody } from "./http";
import { EXTENSION_CAPABILITIES } from "./capacidades";
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
/** Corpo do interruptor do módulo `connected`: a revisão que a tela viu e o sentido (true = desligar). */
export const switchRequestSchema = z
  .object({ expected_installation_revision: installationRevision, disabled: z.boolean() })
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
    // O VOCABULÁRIO INTEIRO, não o literal antigo. Este campo ficou para trás quando a ADR-0003
    // ampliou as capacidades: o manifesto passou a aceitar seis portas, o mapa do host passou a
    // resolver as seis, e ESTE schema continuou exigindo `tasks.open`. Efeito no produto: uma
    // extensão com porta nova instalava, aparecia, mas o botão dela NÃO ABRIA NADA — o servidor
    // recusava o pedido antes de chegar ao resolvedor.
    //
    // Nenhum teste de unidade pegou, porque todos exercitavam o manifesto e o mapa; o caminho
    // HTTP completo só é percorrido pela prova em tela, e foi ela que achou.
    capability: z.enum(EXTENSION_CAPABILITIES),
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
