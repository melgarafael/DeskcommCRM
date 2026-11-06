/**
 * LGPD redact cascade — invokes the SECURITY DEFINER RPC
 * `fn_lgpd_cascade_redact_contact` that performs the full anonymisation in
 * a single Postgres transaction.
 *
 * The RPC:
 *   - Short-circuits when contact is already anonymised (returns
 *     `already_anonymized: true`).
 *   - Mutates contacts (irreversible), conversations, messages,
 *     crm_lead_activities, crm_leads.
 *   - Strips personal fields from orders.payload but PRESERVES values.
 *   - Enqueues media paths into `storage_redaction_queue` for async deletion.
 *   - Redacts `conversation_notes` and enqueues its attachment with the
 *     `internal-media` bucket (migration 0483) — notes are NOT in
 *     `whatsapp-media`, which belongs to the customer channel.
 *   - Inserts a dense `lgpd.redact_executed` audit row inside the TX.
 *
 * All tenant filtering is enforced at the RPC level (programmatic
 * organization_id check). The admin client bypasses RLS.
 */

import { logger } from "@/lib/logger";
import { isLeadAttachmentPathOwnedBy } from "@/lib/messaging/media/upload-validation";
import { createAdminClient } from "@/lib/supabase/admin";

export interface CascadeResult {
  alreadyAnonymized: boolean;
  counts: Record<string, number>;
  mediaPaths: string[];
}

interface RpcResult {
  already_anonymized: boolean;
  counts?: Record<string, number>;
  media_paths?: string[];
}

export interface CascadeArgs {
  organizationId: string;
  contactId: string;
  requestId: string;
}

/**
 * Enfileira um arquivo para remoção assíncrona em `storage_redaction_queue`.
 *
 * O `bucket` é PARÂMETRO, e não constante. O valor `whatsapp-media` estava
 * escrito dentro do chamador (o antigo redact-cascade.ts:81) e é justamente o
 * que a F3 da #1863 tinha destravado: a mídia de uma NOTA interna vive em
 * `internal-media` (bucket que a migration 0483 cria de propósito — fora do
 * varredor órfão da 0435, que apagaria o arquivo em 1 dia, e fora do canal do
 * cliente). Enfileirar um caminho num bucket onde ele não está faz a remoção
 * apontar para o nada: a mesma falha de não ter anonimizado, um endereço mais
 * para a direita. Quem chama decide o bucket; quem purga só enxerga o par.
 *
 * O `upsert` REABRE a linha pelo par (bucket, object_path) — o mesmo
 * motivo do avatar: um pedido anterior deixa uma linha terminal, que nada
 * purga, e um `insert` bateria na unique.
 */
async function enfileirarMidiaNaFila(
  admin: ReturnType<typeof createAdminClient>,
  alvo: { organizationId: string; requestId: string; bucket: string; objectPath: string },
): Promise<void> {
  const { error } = await admin.from("storage_redaction_queue").upsert(
    {
      organization_id: alvo.organizationId,
      request_id: alvo.requestId,
      bucket: alvo.bucket,
      object_path: alvo.objectPath,
      status: "pending",
      attempts: 0,
      processed_at: null,
      error_message: null,
    },
    { onConflict: "bucket,object_path" },
  );

  // Falha FECHADA: sem linha na fila, zerar o ponteiro tornaria o arquivo
  // inalcançável — dado anonimizado, auditoria afirmando que a redação ocorreu,
  // e o arquivo ainda no bucket sem ninguém capaz de achá-lo. Melhor abortar a
  // cascata e reprocessar do que anonimizar pela metade.
  if (error) {
    throw new Error(
      `[lgpd-redact-cascade] mídia não enfileirada (${alvo.bucket}/${alvo.objectPath}): ${error.message}`,
    );
  }
}

export async function cascadeRedactContact(args: CascadeArgs): Promise<CascadeResult> {
  const admin = createAdminClient();

  // FOTO DE PERFIL — enfileirada ANTES da cascata, e a ordem importa.
  //
  // A RPC zera os campos do contato. Se o avatar fosse limpo junto sem passar
  // por aqui, o caminho do arquivo se perderia e a imagem ficaria ÓRFÃ no
  // bucket: a pessoa "anonimizada" continuaria com o rosto guardado. Numa
  // auditoria LGPD isso é o mesmo que não ter anonimizado.
  //
  // Fica no app, e não dentro da função SQL, de propósito: aquela função tem
  // ~200 linhas e um `create or replace` exigiria copiá-la inteira só para
  // acrescentar uma coluna — risco de divergir do original sem necessidade.
  // Aqui o efeito é o mesmo e a mudança é auditável.
  //
  // A fila é idempotente (`unique (bucket, object_path)`), então re-executar
  // uma anonimização não duplica nada.
  const { data: contatoAvatar } = await admin
    .from("contacts")
    .select("avatar_storage_path")
    .eq("id", args.contactId)
    .eq("organization_id", args.organizationId)
    .maybeSingle();

  const avatarPath = (contatoAvatar as { avatar_storage_path?: string | null } | null)
    ?.avatar_storage_path;

  if (avatarPath) {
    // `upsert` que REABRE a linha, e não `insert` cru. A mídia de mensagem tem
    // caminho único por arquivo, então lá um conflito nunca acontece; o avatar
    // inverte essa premissa — o caminho é `{org}/avatars/{id}.jpg`, estável por
    // contato e reaproveitado a cada refresh do cron. Um pedido anterior para o
    // mesmo contato deixa na fila uma linha terminal, que nada purga, e um
    // `insert` bateria em `unique (bucket, object_path)`.
    //
    // Reabrir é o certo, não ignorar o conflito: se o cron rebaixou a foto
    // depois daquele pedido, existe um arquivo NOVO naquele mesmo caminho
    // esperando remoção, e uma linha em estado terminal nunca seria drenada.
    // A foto é do `whatsapp-media` — o cron de avatares sobe o
    // `{org}/avatars/{id}.jpg` nele, e ele é o arquivo da PESSOA, não de uma
    // conversa. O bucket deixou de ser constante do arquivo: é decisão de quem
    // chama, e é a ponta que a F3 da #1863 destravou (a mídia da nota é em
    // `internal-media`, logo abaixo). A falha aqui é FECHADA: sem linha na
    // fila, zerar o ponteiro abaixo tornaria o arquivo inalcançável — contato
    // anonimizado, auditoria afirmando que a redação ocorreu, e o rosto ainda no
    // bucket sem ninguém capaz de achá-lo. Melhor abortar a cascata e
    // reprocessar do que anonimizar pela metade.
    await enfileirarMidiaNaFila(admin, {
      organizationId: args.organizationId,
      requestId: args.requestId,
      bucket: "whatsapp-media",
      objectPath: avatarPath,
    });

    await admin
      .from("contacts")
      .update({ avatar_storage_path: null, avatar_updated_at: new Date().toISOString() })
      .eq("id", args.contactId)
      .eq("organization_id", args.organizationId);
  }

  // MÍDIA DA NOTA INTERNA (#1863, F3) — ANTES da RPC, na mesma ordem do avatar.
  //
  // A RPC (passo 6d, migration 0483) faz o trabalho: redige `body`, zera os
  // três ponteiros e enfileira o arquivo. Isto aqui é a mesma garantia de
  // FALHA FECHADA do lado do APP que a foto tem: sem a linha na fila, zerar
  // `media_storage_path` tornaria o anexo inalcançável — nota anonimizada,
  // auditoria dizendo que a redação ocorreu, e o arquivo ainda no bucket sem
  // ninguém capaz de achá-lo. A RPC é atômica, mas é chamada DENTRO de um
  // pedido que pode falhar depois dela; com a fila já preenchida, a retomada do
  // worker não perde o rastro (e o drenagem só corre diário — a janela entre o
  // `upsert` e o `rpc` abaixo é de milissegundos contra um cron diário).
  //
  // É também o lugar onde o BUCKET é decidido: um arquivo de nota nunca pode
  // ser enfileirado como `whatsapp-media`. Esse bucket é do canal do cliente e
  // é o único que o varredor órfão da 0435 varre; enfileirar ali (ou apontar
  // para um bucket onde o arquivo não está) faria a remoção mirar no nada.
  //
  // O bucket saiu de constante para parâmetro no `enfileirarMidiaNaFila`
  // acima — foi o que destravou o `whatsapp-media` escrito no antigo
  // redact-cascade.ts:81.
  //
  // Idempotente nas duas pontas: `unique (bucket, object_path)` aqui e
  // `on conflict (bucket, object_path) do nothing` no passo 6d. Um pedido
  // repetido não duplica linha, e enfileirar duas vezes é inofensivo.
  const { data: conversasDoContato, error: conversasErro } = await admin
    .from("conversations")
    .select("id")
    .eq("organization_id", args.organizationId)
    .eq("contact_id", args.contactId);
  if (conversasErro) {
    throw new Error(`[lgpd-redact-cascade] conversas do contato não lidas: ${conversasErro.message}`);
  }
  const idsDasConversas = (conversasDoContato ?? []).map((linha) => linha.id);
  if (idsDasConversas.length > 0) {
    const { data: notasComMidia, error: notasErro } = await admin
      .from("conversation_notes")
      .select("id, media_storage_path")
      .eq("organization_id", args.organizationId)
      .in("conversation_id", idsDasConversas)
      .not("media_storage_path", "is", null);
    if (notasErro) {
      throw new Error(`[lgpd-redact-cascade] notas da conversa não lidas: ${notasErro.message}`);
    }
    for (const nota of notasComMidia ?? []) {
      const caminho = nota.media_storage_path;
      if (!caminho) continue;
      await enfileirarMidiaNaFila(admin, {
        organizationId: args.organizationId,
        requestId: args.requestId,
        bucket: "internal-media",
        objectPath: caminho,
      });
    }
  }

  // ANEXOS DE NEGÓCIOS / LEADS (crm_lead_attachments) — LGPD
  const { data: leadsDoContato, error: leadsErro } = await admin
    .from("crm_leads")
    .select("id")
    .eq("organization_id", args.organizationId)
    .eq("contact_id", args.contactId);
  if (leadsErro) {
    throw new Error(`[lgpd-redact-cascade] leads do contato não lidos: ${leadsErro.message}`);
  }
  const idsDosLeads = (leadsDoContato ?? []).map((l) => l.id);
  if (idsDosLeads.length > 0) {
    const { data: anexosDosLeads, error: anexosErro } = await admin
      .from("crm_lead_attachments")
      .select("id, lead_id, storage_path")
      .eq("organization_id", args.organizationId)
      .in("lead_id", idsDosLeads);
    if (anexosErro) {
      throw new Error(`[lgpd-redact-cascade] anexos dos leads não lidos: ${anexosErro.message}`);
    }
    for (const anexo of anexosDosLeads ?? []) {
      if (!anexo.storage_path) continue;
      // A fila remove com o cliente admin: só o que mora sob o prefixo do negócio.
      if (!isLeadAttachmentPathOwnedBy(anexo.storage_path, args.organizationId, anexo.lead_id)) {
        logger.warn("[lgpd-redact-cascade] anexo com caminho fora do negócio; não enfileirado", {
          attachmentId: anexo.id,
          requestId: args.requestId,
        });
        continue;
      }
      await enfileirarMidiaNaFila(admin, {
        organizationId: args.organizationId,
        requestId: args.requestId,
        bucket: "internal-media",
        objectPath: anexo.storage_path,
      });
    }
    const { error: apagarErro } = await admin
      .from("crm_lead_attachments")
      .delete()
      .eq("organization_id", args.organizationId)
      .in("lead_id", idsDosLeads);
    if (apagarErro) {
      throw new Error(`[lgpd-redact-cascade] anexos dos leads não apagados: ${apagarErro.message}`);
    }
  }

  const { data, error } = await admin.rpc("fn_lgpd_cascade_redact_contact" as never, {
    p_organization_id: args.organizationId,
    p_contact_id: args.contactId,
    p_request_id: args.requestId,
  } as never);

  if (error) {
    throw new Error(`[lgpd-redact-cascade] rpc failed: ${error.message}`);
  }

  const result = (data ?? {}) as RpcResult;
  return {
    alreadyAnonymized: result.already_anonymized === true,
    counts: result.counts ?? {},
    mediaPaths: result.media_paths ?? [],
  };
}
