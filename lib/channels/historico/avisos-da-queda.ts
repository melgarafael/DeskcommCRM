/**
 * OS AVISOS DA RECUPERAÇÃO DA QUEDA NA CENTRAL (Spec 32, seção 4).
 *
 * Quando o número volta de uma queda, o sistema recupera sozinho as conversas do
 * período fora do ar. Quem opera precisa saber duas coisas, e cada uma vira um
 * aviso na Central de avisos (`agent_inbox_items`):
 *
 *   - o RESUMO da recuperação, por conexão: concluiu (e quanto), parou com erro,
 *     ou nem começou (número mudou, número não confirmado, histórico desligado);
 *   - o CLIENTE que escreveu na queda e ainda não teve resposta, por conversa.
 *
 * ── Regras que este módulo carrega ─────────────────────────────────────────
 *
 * - Um resumo ABERTO por conexão. Uma queda nova com o aviso ainda aberto ATUALIZA
 *   o mesmo aviso, não cria um segundo. Quem garante isso é o índice único parcial
 *   (`agent_inbox_recuperacao_da_queda_aberto_unico`); o `not exists` de
 *   `insertInboxItem` tem corrida e não atualiza, por isso não é usado aqui.
 * - Um aviso de cliente por conversa; a segunda tentativa vira `23505` e é ignorada.
 * - Nenhuma função LANÇA por falha de gravação do aviso. Esta chamada é lateral à
 *   recuperação, que é o que importa: aviso que não entrou é registrado em log e a
 *   recuperação segue.
 * - Toda consulta leva `organization_id`. O cliente é administrador (service role),
 *   que ignora a RLS: o filtro manual é a única barreira entre tenants.
 * - O aviso não leva PII: nem nome, nem número, nem trecho de mensagem. Só o motivo,
 *   o período e a contagem.
 *
 * Os textos moram em `lib/ai/agent-inbox-copy.ts`, por motivo; aqui só se escolhe
 * o motivo e se grava a linha.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  CORPO_DO_CLIENTE_SEM_RESPOSTA_NA_QUEDA,
  TITULO_DO_CLIENTE_SEM_RESPOSTA_NA_QUEDA,
  copyDoResumoDaRecuperacao,
  type MotivoDoResumoDaRecuperacao,
} from "@/lib/ai/agent-inbox-copy";
import { logger } from "@/lib/logger";
import { tagDeIdioma } from "@/lib/i18n/datas";
import type { Idioma } from "@/lib/i18n/idiomas";
import { FUSO_PADRAO } from "@/lib/tempo/fusos";

export type MotivoDoResumo = MotivoDoResumoDaRecuperacao;

const KIND_RESUMO = "recuperacao_da_queda" as const;
const KIND_CLIENTE = "cliente_sem_resposta_na_queda" as const;

/**
 * Teto de avisos por chamada do fechamento. A chamada é de manutenção, não de
 * requisição do operador: lote limitado mantém a consulta pequena e o tempo
 * previsível, e o resto fica para a próxima passada.
 */
/** O título e o corpo do aviso são gravados em português (como os vizinhos). */
const IDIOMA_DO_AVISO: Idioma = "pt-BR";

const LOTE_MAXIMO = 100;
const PAGINAS_MAXIMAS = 5;

/**
 * A data no formato que a Central mostra: fuso de instalação, dia e hora. O
 * aviso é linha gravada, então o horário é escrito já formatado.
 */
function formatarMomento(iso: string): string {
  // Pela camada de datas (`tagDeIdioma`), como `momentoDaPausa` em canal-pausado.ts:
  // o texto do aviso nasce em português, e a cerca i18n-a-data-segue-o-idioma
  // proíbe "pt-BR" fixo fora dela.
  return new Intl.DateTimeFormat(tagDeIdioma(IDIOMA_DO_AVISO), {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: FUSO_PADRAO,
  }).format(new Date(iso));
}

/**
 * Cria o resumo da recuperação da conexão, ou ATUALIZA o aberto dela.
 *
 * `concluida` sem nenhuma mensagem não avisa: o aviso existe para dizer algo que
 * o administrador precisa ver, e "não havia nada para recuperar" não pede ação.
 */
export async function avisarResumoDaRecuperacao(
  admin: SupabaseClient,
  args: {
    organizationId: string;
    channelSessionId: string;
    motivo: MotivoDoResumoDaRecuperacao;
    mensagens?: number;
    conversas?: number;
    desde?: string;
    ate?: string;
    erro?: string;
  },
): Promise<void> {
  try {
    if (args.motivo === "concluida" && !((args.mensagens ?? 0) > 0)) return;

    const { title, body } = copyDoResumoDaRecuperacao(args.motivo, {
      mensagens: args.mensagens,
      conversas: args.conversas,
      desde: args.desde ? formatarMomento(args.desde) : undefined,
      ate: args.ate ? formatarMomento(args.ate) : undefined,
      erro: args.erro,
    });

    const { error } = await admin.from("agent_inbox_items").insert({
      organization_id: args.organizationId,
      kind: KIND_RESUMO,
      severity: "warn",
      title,
      body,
      ref_kind: "channel_session",
      ref_id: args.channelSessionId,
      status: "open",
    });
    if (!error) return;

    // 23505: o índice único parcial já tem um resumo aberto para esta conexão
    // (uma queda anterior, ainda não resolvida). A regra é "um aberto por
    // conexão": o novo texto substitui o antigo, em vez de empilhar um segundo.
    if (error.code !== "23505") {
      logger.warn("[recuperacao-da-queda] gravação do resumo falhou", {
        detail: error.message,
        channel_session_id: args.channelSessionId,
      });
      return;
    }

    const { error: erroDoUpdate } = await admin
      .from("agent_inbox_items")
      .update({ title, body })
      .eq("organization_id", args.organizationId)
      .eq("kind", KIND_RESUMO)
      .eq("ref_id", args.channelSessionId)
      .eq("status", "open");
    if (erroDoUpdate) {
      logger.warn("[recuperacao-da-queda] atualização do resumo falhou", {
        detail: erroDoUpdate.message,
        channel_session_id: args.channelSessionId,
      });
    }
  } catch (err) {
    logger.warn("[recuperacao-da-queda] resumo interrompido", {
      channel_session_id: args.channelSessionId,
      erro: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Resolve o resumo aberto da conexão. Chamado quando a recuperação seguinte
 * assume o lugar do aviso, ou quando a conexão deixa de precisar dele.
 */
export async function fecharResumoDaRecuperacao(
  admin: SupabaseClient,
  args: { organizationId: string; channelSessionId: string },
): Promise<void> {
  try {
    const { error } = await admin
      .from("agent_inbox_items")
      .update({ status: "resolved", resolved_at: new Date().toISOString() })
      .eq("organization_id", args.organizationId)
      .eq("kind", KIND_RESUMO)
      .eq("ref_id", args.channelSessionId)
      .eq("status", "open");
    if (error) {
      logger.warn("[recuperacao-da-queda] fechamento do resumo falhou", {
        detail: error.message,
        channel_session_id: args.channelSessionId,
      });
    }
  } catch (err) {
    logger.warn("[recuperacao-da-queda] fechamento do resumo interrompido", {
      channel_session_id: args.channelSessionId,
      erro: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Avisa que um cliente escreveu na queda e ainda não teve resposta. A referência
 * é a conversa. O contato entra só no log, para quem investiga; o aviso não o leva.
 */
export async function avisarClienteSemResposta(
  admin: SupabaseClient,
  args: { organizationId: string; conversationId: string; contactId: string },
): Promise<void> {
  try {
    const { error } = await admin.from("agent_inbox_items").insert({
      organization_id: args.organizationId,
      kind: KIND_CLIENTE,
      severity: "warn",
      title: TITULO_DO_CLIENTE_SEM_RESPOSTA_NA_QUEDA,
      body: CORPO_DO_CLIENTE_SEM_RESPOSTA_NA_QUEDA,
      ref_kind: "conversation",
      ref_id: args.conversationId,
      status: "open",
    });
    // 23505 não é erro: a conversa já tem o aviso aberto. Chegar aqui duas vezes
    // (duas passadas da recuperação) é o caso normal, e não merece log.
    if (error && error.code !== "23505") {
      logger.warn("[recuperacao-da-queda] gravação aviso de cliente falhou", {
        detail: error.message,
        conversation_id: args.conversationId,
        contact_id: args.contactId,
      });
    }
  } catch (err) {
    logger.warn("[recuperacao-da-queda] aviso de cliente interrompido", {
      conversation_id: args.conversationId,
      erro: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Fecha os avisos de cliente sem resposta cuja conversa já recebeu resposta da
 * equipe (ou do aparelho) DEPOIS do aviso. O "depois" é a comparação com o
 * `created_at` do próprio aviso: uma resposta anterior à queda não o resolve, porque
 * já estava lá quando o cliente ficou sem resposta.
 *
 * Devolve quantos avisos fechou. Lê no máximo `LOTE_MAXIMO` por chamada.
 */
export async function fecharAvisosDeClienteRespondido(
  admin: SupabaseClient,
  organizationId: string,
): Promise<number> {
  try {
    // Páginas de LOTE_MAXIMO, até PAGINAS_MAXIMAS: só com `limit` os mesmos 100
    // mais antigos (nunca respondidos) voltariam a cada passada, e os mais novos
    // — mesmo já respondidos — nunca seriam examinados.
    const abertos: { id: string; ref_id: string | null; created_at: string }[] = [];
    for (let pagina = 0; pagina < PAGINAS_MAXIMAS; pagina++) {
      const inicio = pagina * LOTE_MAXIMO;
      const { data, error } = await admin
        .from("agent_inbox_items")
        .select("id, ref_id, created_at")
        .eq("organization_id", organizationId)
        .eq("kind", KIND_CLIENTE)
        .eq("status", "open")
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(inicio, inicio + LOTE_MAXIMO - 1);
      if (error) {
        logger.warn("[recuperacao-da-queda] leitura dos avisos de cliente falhou", {
          detail: error.message,
        });
        if (abertos.length === 0) return 0;
        break;
      }
      const pedaco = (data ?? []) as { id: string; ref_id: string | null; created_at: string }[];
      abertos.push(...pedaco);
      if (pedaco.length === 0) break;
    }

    const lote = (abertos ?? []) as { id: string; ref_id: string | null; created_at: string }[];

    // Uma consulta por aviso, em paralelo, com teto de 100. Cada uma olha só a
    // existência de uma saída depois do aviso, então `limit 1` basta. O
    // `organization_id` vai junto: a conversa é de quem o aviso é, e não há
    // motivo para ler mensagem de outro tenant nem por engano.
    const respondidos = await Promise.all(
      lote.map(async (aviso) => {
        if (!aviso.ref_id) return false;
        const { data, error: erroDaLeitura } = await admin
          .from("messages")
          .select("id")
          .eq("organization_id", organizationId)
          .eq("conversation_id", aviso.ref_id)
          .eq("direction", "outbound")
          .gt("created_at", aviso.created_at)
          .limit(1);
        if (erroDaLeitura) {
          // Na dúvida, o aviso continua aberto: fechar um aviso que deveria estar
          // vivo é perder o alarme; manter um a mais é só ruído até a próxima passada.
          logger.warn("[recuperacao-da-queda] leitura de saídas falhou", {
            detail: erroDaLeitura.message,
            conversation_id: aviso.ref_id,
          });
          return false;
        }
        return (data ?? []).length > 0;
      }),
    );

    let fechados = 0;
    await Promise.all(
      lote.map(async (aviso, i) => {
        if (!respondidos[i]) return;
        const { data, error: erroDoFechamento } = await admin
          .from("agent_inbox_items")
          .update({ status: "resolved", resolved_at: new Date().toISOString() })
          .eq("organization_id", organizationId)
          .eq("id", aviso.id)
          // A trava: uma rodada simultânea que já fechou este aviso não conta duas vezes.
          .eq("status", "open")
          .select("id");
        if (erroDoFechamento) {
          logger.warn("[recuperacao-da-queda] fechamento do aviso de cliente falhou", {
            detail: erroDoFechamento.message,
            aviso_id: aviso.id,
          });
          return;
        }
        if ((data ?? []).length > 0) fechados += 1;
      }),
    );
    return fechados;
  } catch (err) {
    logger.warn("[recuperacao-da-queda] fechamento dos avisos de cliente interrompido", {
      erro: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}
