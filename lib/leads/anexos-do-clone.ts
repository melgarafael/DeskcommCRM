/**
 * OS ANEXOS VÃO JUNTO QUANDO O CARD TROCA DE FUNIL (#4544).
 *
 * O clone de um negócio para outro funil cria uma LINHA NOVA em `crm_leads`, e
 * o anexo mora em `crm_lead_attachments.lead_id`. Quem move o card DENTRO do
 * funil não perde nada: o `lead_id` continua o mesmo. Quem clona — o `/clone`
 * da tela, a ação `create_or_move_lead` da automação (tanto o `lead.won` que
 * cria a continuação quanto o `lead.tag_added` que transfere) — gravava o card
 * novo e parava ali: as linhas do anexo continuavam apontando para a origem,
 * porque ninguém as reinseria com o `lead_id` do destino nem copiava o objeto
 * do Storage.
 *
 * Medido na `main`: nenhum dos três caminhos fazia o INSERT em
 * `crm_lead_attachments`, e nenhum tocava o bucket. A diferença em relação ao
 * caminho manual é de TABELA (a linha do anexo) e de ORDEM (só depois que o
 * card novo existe e tem id) — não é de campo.
 *
 * ── Copiar, e não referenciar ────────────────────────────────────────────────
 *
 * A issue deixa a escolha aberta. Copiar é o que fecha o defeito sem criar uma
 * segunda régua de autorização: referenciar exigiria que a leitura do anexo
 * consultasse a visibilidade do card de ORIGEM em toda rota (lista, mídia,
 * cascata de LGPD, expurgo de mídia), e uma dessas rotas esquecida vira
 * vazamento entre negócios. O custo é o arquivo duplicado no Storage — que o
 * passo 2b de `fn_enfileirar_midia_vencida` já sabe recolher quando a linha
 * some, porque a cópia tem linha própria, sob o `lead_id` do destino.
 *
 * O `storage_path` do anexo é PRESO ao negócio pelo check do banco
 * (`{org}/leads/{lead}/{campo}/arquivo`, baseline.sql): uma linha copiada com o
 * caminho antigo seria recusada. Por isso o id e o caminho são NOVOS — o
 * arquivo é copiado, não apontado.
 *
 * ── Falhar baixo ────────────────────────────────────────────────────────────
 *
 * Nenhum erro daqui derruba a troca de funil: o card já nasceu, e um anexo que
 * não copiou é um problema visível (o card de origem continua lá, com o
 * arquivo) — perder o negócio inteiro por causa dele, não. Cada falha é contada
 * no retorno e registrada no log, nunca engolida em silêncio.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/** O bucket dos anexos de campo do negócio (`crm_lead_attachments`). */
const BUCKET = "internal-media";

/** A linha da origem, como esta cópia precisa dela. */
interface AnexoDaOrigem {
  id: string;
  field_key: string;
  file_name: string;
  file_size: number | string;
  mime_type: string;
  storage_path: string;
  created_by: string | null;
}

/** A linha que nasce no destino. */
interface AnexoDoDestino {
  organization_id: string;
  lead_id: string;
  field_key: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  storage_path: string;
  created_by: string | null;
}

export interface ResultadoDaCopiaDeAnexos {
  /** Linhas gravadas no card de destino. */
  copiados: number;
  /**
   * Arquivos que ficaram para trás (leitura, cópia no Storage ou INSERT). O
   * card de origem continua com eles, e o operador vê o anexo faltando — o que
   * não pode acontecer é o número mentir.
   */
  falhas: number;
}

export interface ArgsDaCopiaDeAnexos {
  organizationId: string;
  origemLeadId: string;
  destinoLeadId: string;
}

/**
 * A cópia do objeto no Storage. Injetável porque o teste mede o caminho de
 * destino sem falar com o bucket — e porque quem chama não deve escolher o
 * cliente: o bucket não tem policy para `authenticated` (baseline.sql), então a
 * cópia é SEMPRE por `service_role`, como o upload da rota de anexos.
 */
export type CopiarObjetoDoStorage = (
  de: string,
  para: string,
) => Promise<{ error: { message: string } | null }>;

function copiarPeloAdmin(): CopiarObjetoDoStorage {
  return (de, para) => createAdminClient().storage.from(BUCKET).copy(de, para);
}

/**
 * O caminho de cópia usado em produção. Exportado porque `criarCloneNoFunil`
 * (o passo único dos três caminhos de troca de funil) precisa dele quando
 * ninguém injeta outro — e o teste injeta o seu para não falar com o bucket.
 */
export { copiarPeloAdmin as copiarObjetoPeloAdmin };

/** `.../voucher/anx-1.pdf` → `.pdf`; sem extensão, vazio. */
function extensaoDoCaminho(caminho: string): string {
  const nome = caminho.split("/").pop() ?? "";
  const ponto = nome.lastIndexOf(".");
  return ponto > 0 ? nome.slice(ponto) : "";
}

/**
 * Copia os anexos do negócio de ORIGEM para o card que acabou de nascer no
 * funil de destino.
 *
 * O `db` é quem INSERE a linha — o mesmo cliente que criou o card (sessão na
 * rota, `service_role` na automação), para a escrita respeitar a RLS de quem
 * pediu a troca. A cópia do arquivo é sempre pelo cliente de serviço.
 *
 * Chamar de novo para o mesmo par origem→destino duplica: idempotência é do
 * chamador, e os três chamadores só chegam aqui uma vez por card (a guarda de
 * continuação da automação e a checagem de origem do `/clone`).
 */
export async function copiarAnexosDoClone(
  db: SupabaseClient,
  args: ArgsDaCopiaDeAnexos,
  copiarObjeto?: CopiarObjetoDoStorage,
): Promise<ResultadoDaCopiaDeAnexos> {
  const { data, error } = await db
    .from("crm_lead_attachments")
    .select("id, field_key, file_name, file_size, mime_type, storage_path, created_by")
    .eq("organization_id", args.organizationId)
    .eq("lead_id", args.origemLeadId);

  if (error) {
    logger.warn("[anexos-do-clone] anexos da origem não lidos; o card nasce sem eles", {
      organizationId: args.organizationId,
      origemLeadId: args.origemLeadId,
      erro: error.message,
    });
    return { copiados: 0, falhas: 0 };
  }

  const anexos = (data ?? []) as AnexoDaOrigem[];
  if (anexos.length === 0) return { copiados: 0, falhas: 0 };

  const copiar = copiarObjeto ?? copiarPeloAdmin();
  const novas: AnexoDoDestino[] = [];
  let falhas = 0;

  for (const anexo of anexos) {
    // Id NOVO porque o caminho carrega o id do negócio e o do arquivo: reaproveitar
    // o caminho da origem violaria o check do banco (o lead é outro).
    const novoId = randomUUID();
    const novoCaminho =
      `${args.organizationId}/leads/${args.destinoLeadId}/${anexo.field_key}/` +
      `${novoId}${extensaoDoCaminho(anexo.storage_path)}`;

    try {
      const copia = await copiar(anexo.storage_path, novoCaminho);
      if (copia.error) throw new Error(copia.error.message);
    } catch (erro) {
      falhas += 1;
      logger.warn("[anexos-do-clone] arquivo não copiado no Storage", {
        origemLeadId: args.origemLeadId,
        destinoLeadId: args.destinoLeadId,
        attachmentId: anexo.id,
        erro: erro instanceof Error ? erro.message : String(erro),
      });
      continue;
    }

    novas.push({
      organization_id: args.organizationId,
      lead_id: args.destinoLeadId,
      field_key: anexo.field_key,
      file_name: anexo.file_name,
      file_size: Number(anexo.file_size) || 0,
      mime_type: anexo.mime_type,
      storage_path: novoCaminho,
      // Quem subiu o arquivo na origem continua sendo quem subiu: a cópia não
      // inventa autoria.
      created_by: anexo.created_by,
    });
  }

  if (novas.length === 0) return { copiados: 0, falhas };

  const { error: insertErr } = await db.from("crm_lead_attachments").insert(novas);
  if (insertErr) {
    // As linhas não entraram; os objetos copiados viram órfãos e a varredura de
    // mídia os recolhe. Contados como falha, para o retorno não mentir.
    logger.warn("[anexos-do-clone] linhas do anexo não gravadas no card novo", {
      origemLeadId: args.origemLeadId,
      destinoLeadId: args.destinoLeadId,
      quantidade: novas.length,
      erro: insertErr.message,
    });
    return { copiados: 0, falhas: falhas + novas.length };
  }

  return { copiados: novas.length, falhas };
}
