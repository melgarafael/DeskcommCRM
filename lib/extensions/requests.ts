import { z } from "zod";

import { readExtensionBody } from "./http";
import { CAPACIDADES_DE_PORTA } from "./capacidades";
import { PERMISSOES_DE_TURNO } from "./consentimento";
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
    // O ACEITE EXPLÍCITO (#3076). `accept_permissions` é o conjunto que o dono da organização
    // está concedendo NESTE ato — o conjunto inteiro, e não um delta, porque um delta somado a
    // um aceite antigo esconderia uma permissão que a versão anterior aceitou e esta não pede.
    //
    // Só as permissões de EFEITO viajam por aqui: navegação, tema e dados continuam cobertos
    // pelo ato de instalar/ativar, e aceitá-los de novo seria pedir consentimento onde não há
    // efeito novo. O serviço confere que cada nome está no manifesto vigente; o banco confere de
    // novo (defesa em profundidade) e recusa a ativação sem cobertura.
    accept_permissions: z.array(z.enum(PERMISSOES_DE_TURNO)).min(1).max(2).optional(),
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
    // As capacidades do TURNO ficam fora deste pedido de propósito (#3076): elas não navegam,
    // então aceitá-las aqui daria um 200 com destino nulo — outra forma de dizer "o botão não
    // abriu" que o comentário acima existe para não repetir.
    capability: z.enum(CAPACIDADES_DE_PORTA),
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
