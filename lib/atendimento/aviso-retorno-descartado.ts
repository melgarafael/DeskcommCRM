import type pg from "pg";

import { insertInboxItem, type InboxItemRow } from "@/lib/agent-engine/db/repository";
import { copyDoRetornoDescartado } from "@/lib/ai/agent-inbox-copy";
import { partesNoFuso } from "@/lib/agenda/fuso";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { emitAgentActivityForContact } from "@/lib/leads/agent-activity";

/**
 * O retorno COMBINADO com o cliente que não vai sair (#4696).
 *
 * ═══ O DEFEITO QUE ESTE ARQUIVO FECHA ═══
 *
 * `descartarFollowupObsoleto` está CORRETO: quando o atendimento muda antes do
 * disparo, o turno combinado não pode sair — mandar a mensagem seria escrever
 * ao cliente em nome de um atendimento que já não existe. O que estava errado
 * era o descarte ser SILENCIOSO: o job ia para `failed` com
 * `service_boundary_stale` e nada aparecia na Central, na ficha do contato ou
 * em qualquer tela. Medido no relato da issue: 11 descartes em 17 dias, e num
 * deles o cliente esperava um contato que nunca sairia. Quem descobriu manteve
 * um script na VPS lendo `job_queue` para não perder o combinado — o remendo
 * existia porque o produto calava.
 *
 * ═══ O QUE ELE ESCREVE, E ONDE ═══
 *
 * Dois rastros, e só dois:
 *
 *   1. a CENTRAL de avisos (`agent_inbox_items`, kind `followup_descartado`),
 *      que é o canal que a operação já lê — reusado, não recriado. Nasce com
 *      `ref_kind='conversation'`, e é o que dá o destino clicável
 *      (`lib/ai/inbox-destino.ts`); dedup por (kind, conversa), então o mesmo
 *      contato descartado duas vezes no mesmo dia é UM aviso;
 *   2. a LINHA DO TEMPO do contato (`crm_lead_activities`, tipo
 *      `followup_discarded`), pelo roteador de sempre
 *      (`emitAgentActivityForContact`): quem abre a ficha vê que a mensagem
 *      combinada não sai e por quê.
 *
 * Nada é enviado ao cliente: isto é aviso INTERNO. É a diferença entre "o
 * produto cala" e "o produto conta".
 *
 * ═══ POR QUE OS DOIS ESCRITOS SÃO ISOLADOS EM SAVEPOINT ═══
 *
 * Quem chama é `descartarFollowupObsoleto`, DENTRO da transação que encerra o
 * job. Um `23505` (o índice parcial que fecha a corrida do dedup) deixaria a
 * transação em estado abortado, e o `commit` do descarte viraria ROLLBACK
 * silencioso — o descarte (que está certo) se perderia por causa do aviso (que
 * é acessório). Cada escrita roda na própria subtransação: se ela falhar, o
 * savepoint é desfeito, o fato fica registrado no log e o descarte commita.
 */

/** As duas superfícies de escrita que este módulo aceita: pool ou cliente de transação. */
type Escrita = Pick<pg.Pool, "query">;

export interface ContextoDoRetornoDescartado {
  organizationId: string;
  contactId: string;
  conversationId: string;
  /** Id do job descartado — vira `source_id` da linha do tempo. */
  jobId: string;
  /**
   * O instante em que o retorno deveria sair (`job_queue.run_after`, o horário
   * combinado do ponto de vista de quem espera). Aceita `Date` ou texto ISO
   * porque o driver devolve um e o clone do payload pode trazer outro. `null` =
   * o job não trouxe instante, e aí a frase não inventa hora.
   */
  combinadoPara: Date | string | null;
}

/** O que ficou registrado — os campos são o que os testes e o chamador cobram. */
export interface RastroDoRetornoDescartado {
  aviso: InboxItemRow | null;
  linhaDoTempo: boolean;
  /**
   * `true` só quando uma das duas escritas ESTOUROU (savepoint desfeito).
   *
   * É o que separa "não escreveu porque não havia o que escrever" — aviso já
   * aberto para esta conversa (dedup), contato sem negócio aberto (a linha do
   * tempo não tem onde ser roteada) — de "não escreveu porque quebrou". Só o
   * segundo é motivo de log: aviso deduplicado e ficha sem negócio são o
   * desfecho normal, e transformá-los em `warn` faria o log gritar em todo
   * descarte repetido.
   */
  falhou: boolean;
}

/** "12/11 às 15:00" no fuso da empresa — nunca ISO, nunca UTC na cara de quem lê. */
export function quandoCombinado(instante: Date | string | null, fuso: string): string | null {
  const data = instante instanceof Date ? instante : instante ? new Date(instante) : null;
  if (!data || Number.isNaN(data.getTime())) return null;
  const p = partesNoFuso(data, fuso);
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${dois(p.dia)}/${dois(p.mes)} às ${dois(p.hora)}:${dois(p.minuto)}`;
}

/**
 * Contato e negócio para a frase do aviso, no fuso da empresa.
 *
 * `display_name` do contato e o título do negócio aberto mais recente. O
 * negócio é TEXTO de exibição — não decide roteamento nem move card, por isso
 * a consulta pode usar a ordem natural (`updated_at`) em vez do desempate
 * cuidadoso de `resolveActiveLeadForContact`.
 */
async function dadosDoAviso(
  db: Escrita,
  organizationId: string,
  contactId: string,
): Promise<{ contato: string; negocio: string | null; fuso: string } | null> {
  const { rows } = await db.query<{
    name: string | null;
    display_name: string | null;
    phone_number: string | null;
    timezone: string | null;
    negocio: string | null;
  }>(
    `select c.name,
            c.display_name,
            c.phone_number,
            o.timezone,
            (select l.title
               from crm_leads l
              where l.organization_id = c.organization_id
                and l.contact_id = c.id
                and l.status = 'open'
              order by l.updated_at desc nulls last, l.created_at desc
              limit 1) as negocio
       from contacts c
       join organizations o on o.id = c.organization_id
      where c.organization_id = $1 and c.id = $2`,
    [organizationId, contactId],
  );
  const linha = rows[0];
  if (!linha) return null;
  return {
    contato: rotuloDoContato({
      name: linha.name,
      display_name: linha.display_name,
      phone_number: linha.phone_number,
    }),
    negocio: linha.negocio?.trim() || null,
    fuso: linha.timezone || "America/Sao_Paulo",
  };
}

/**
 * Roda `fn` na própria subtransação.
 *
 * Devolve `{ ok: false }` quando a escrita ESTOUROU, e NUNCA propaga: falhar em
 * avisar não pode desfazer o descarte que o aviso descreve. O log do erro sai
 * aqui, e é a única saída quando os dois rastros caem — é ele que impede o
 * silêncio de voltar por outro caminho.
 *
 * Devolver `null` de dentro de `fn` (aviso já aberto para a conversa, contato
 * sem negócio aberto para rotear a linha do tempo) NÃO é falha: `ok` continua
 * `true` e ninguém loga. A distinção existe porque o dedup é o desfecho normal
 * do segundo descarte do mesmo dia, e `warn` nele faria o log gritar à toa.
 *
 * `23505` merece tratamento próprio: o `insertInboxItem` o captura e devolve
 * `null` (dedup do banco), mas a transação já está abortada nesse instante —
 * o `release` estoura `25P02` e cai no catch, que desfaz o savepoint. O
 * desfecho é o mesmo do dedup sequencial ("já havia aviso aberto"), e é isso
 * que o log diz.
 */
async function emSavepoint<T>(
  db: Escrita,
  nome: string,
  contexto: Record<string, unknown>,
  log: Pick<Logger, "warn">,
  fn: () => Promise<T>,
): Promise<{ ok: true; valor: T } | { ok: false }> {
  await db.query(`savepoint ${nome}`);
  try {
    const valor = await fn();
    await db.query(`release savepoint ${nome}`);
    return { ok: true, valor };
  } catch (erro) {
    // `rollback to savepoint` é permitido mesmo com a transação abortada — é
    // ele que devolve o cliente ao estado utilizável para o commit do descarte.
    await db.query(`rollback to savepoint ${nome}`);
    const codigo = (erro as { code?: string } | null)?.code;
    log.warn(
      codigo === "25P02"
        ? "followup_descartado_aviso_ja_aberto"
        : "followup_descartado_rastro_falhou",
      { ...contexto, motivo: erro instanceof Error ? erro.message : String(erro) },
    );
    return { ok: false };
  }
}

/**
 * Registra os dois rastros do retorno descartado.
 *
 * ⚠️ RODA DENTRO DE UMA TRANSAÇÃO. As duas escritas são isoladas em savepoint
 * (é isso que impede o aviso de derrubar o descarte), e `savepoint` fora de um
 * bloco de transação é erro no Postgres (`25P01`). O único chamador é o worker,
 * que já abre a transação do descarte — quem precisar chamar de outro lugar
 * abre a dele.
 */
export async function registrarRetornoDescartado(
  db: Escrita,
  ctx: ContextoDoRetornoDescartado,
  log: Pick<Logger, "warn">,
): Promise<RastroDoRetornoDescartado> {
  const dados = await dadosDoAviso(db, ctx.organizationId, ctx.contactId);
  if (!dados) {
    // Contato apagado entre o claim e o descarte: não há ficha para apontar, e
    // inventar um aviso sem referência seria ruído sem destino.
    log.warn("followup_descartado_sem_contato", {
      job_id: ctx.jobId,
      organization_id: ctx.organizationId,
      contact_id: ctx.contactId,
    });
    return { aviso: null, linhaDoTempo: false, falhou: false };
  }

  // O instante normalizado UMA vez: o job pode trazer `Date` ou texto, e o
  // payload não pode estourar por causa disso (o savepoint engoliria a linha).
  const combinado =
    ctx.combinadoPara instanceof Date
      ? ctx.combinadoPara
      : ctx.combinadoPara
        ? new Date(ctx.combinadoPara)
        : null;
  const quando = quandoCombinado(combinado, dados.fuso);
  const copy = copyDoRetornoDescartado({ contato: dados.contato, negocio: dados.negocio, quando });

  const aviso = await emSavepoint(
    db,
    "aviso_do_retorno_descartado",
    { job_id: ctx.jobId },
    log,
    () =>
      insertInboxItem(
        db,
        ctx.organizationId,
        {
          kind: "followup_descartado",
          severity: "warn",
          title: copy.title,
          body: copy.body,
          refKind: "conversation",
          refId: ctx.conversationId,
        },
        // Um aviso por CONVERSA: o segundo descarte do mesmo contato no mesmo dia
        // não vira segunda notificação — o combinado que não sai é o mesmo.
        "kind_e_ref",
      ),
  );

  const linha = await emSavepoint(
    db,
    "linha_do_retorno_descartado",
    { job_id: ctx.jobId },
    log,
    () =>
      emitAgentActivityForContact({
        pool: db,
        organizationId: ctx.organizationId,
        contactId: ctx.contactId,
        type: "followup_discarded",
        // O PORQUÊ em língua de gente. O código do erro fica no payload, para
        // quem for investigar — nunca no texto que a pessoa lê.
        reason: `O retorno combinado${quando ? ` para ${quando}` : ""} não será enviado: o atendimento mudou antes do disparo.`,
        sourceModule: "followup",
        sourceId: ctx.jobId,
        payload: {
          job_id: ctx.jobId,
          conversation_id: ctx.conversationId,
          motivo_codigo: "service_boundary_stale",
          combinado_para:
            combinado && !Number.isNaN(combinado.getTime()) ? combinado.toISOString() : null,
        },
      }),
  );

  return {
    aviso: aviso.ok ? aviso.valor : null,
    linhaDoTempo: linha.ok && linha.valor.routed === true,
    falhou: !aviso.ok || !linha.ok,
  };
}
