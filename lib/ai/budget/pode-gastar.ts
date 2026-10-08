/**
 * O TETO DE GASTO PARA QUEM NÃO É TURNO DE RESPOSTA — só a pergunta, sem efeito.
 *
 * ═══ POR QUE EXISTE ═══
 *
 * O teto vinculava dois caminhos: o seam do engine (`aplicarOrcamento`, em
 * `run-model-call.ts`) e o guard do caminho legado (`vetoPorTetoDeGasto`, em
 * `workers/ai-response-worker.ts`). O classificador de clima
 * (`workers/ai-sentiment-worker.ts`) roda a CADA mensagem recebida, em
 * paralelo ao turno, e não passava por nenhum dos dois: com a organização em
 * "parar a IA" e o teto estourado, o turno ia para a fila humana e o clima
 * seguia cobrando cada mensagem — exatamente o gasto que a pessoa pediu para
 * parar.
 *
 * ═══ A DECISÃO NÃO É REESCRITA AQUI ═══
 *
 * Mesmo estado (`getBudgetStatus`, que lê o gasto pela régua única
 * `fn_gasto_de_ia_do_mes`), mesma contagem de aviso do mês do guard legado, e a
 * MESMA função pura `decidirOrcamento`. Uma segunda decisão sempre diverge da
 * que age; esta só executa o veredito.
 *
 * ═══ POR QUE SEM EFEITO NA CENTRAL ═══
 *
 * Os dois emissores de `budget_warning`/`budget_exceeded` (o statement do engine
 * e o guard legado) são do TURNO, e só eles devolvem a conversa a um humano.
 * Quem chama esta função é tarefa lateral — abrir item daqui duplicaria o
 * vocabulário de quem fala com o operador sobre gasto. Consequência declarada:
 * a condição 6 do gate ("ninguém é bloqueado sem ter sido avisado neste mês")
 * vale aqui também, então a tarefa lateral só para DEPOIS que o turno avisou —
 * nunca antes do turno.
 *
 * ═══ NUNCA LANÇA, E ERRA PARA O LADO FROUXO ═══
 *
 * Mesma assimetria de `decidirOrcamento`: leitura que falha devolve "pode" e
 * LOGA. Errar frouxo custa centavos de classificador e aparece em Uso de IA;
 * errar duro calaria uma proteção (o clima é o que chama uma pessoa quando o
 * cliente se irrita) por um soluço de banco.
 */
import { getBudgetStatus } from "@/lib/ai/budget/check";
import {
  decidirOrcamento,
  normalizarModoDeOrcamento,
  type RazaoDeSeguir,
} from "@/lib/agent-engine/edge/llm/orcamento";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export type ConsultaDeOrcamento =
  | {
      pode: true;
      /**
       * Por que pode. Além das razões da decisão pura, `avisar_e_seguir`
       * (modo "só avisar", ou o primeiro cruzamento no modo "parar") e
       * `leitura_falhou` (não deu para saber — segue, e o log diz por quê).
       */
      porque: RazaoDeSeguir | "avisar_e_seguir" | "leitura_falhou";
    }
  | { pode: false; porque: "teto_atingido"; gastoCents: number; tetoCents: number };

/**
 * Esta chamada de IA, com este `purpose`, pode sair agora?
 *
 * `purpose` vai para a decisão como veio: as isenções de `PURPOSES_ISENTOS`
 * valem aqui do mesmo jeito que no seam.
 */
export async function podeGastarComIa(
  organizationId: string,
  purpose: string,
): Promise<ConsultaDeOrcamento> {
  try {
    const admin = createAdminClient();

    // Atalho barato, e é o caminho de quase toda organização: modo `off` (o
    // DEFAULT da coluna) ou sem linha em `ai_budgets`. Quem chama roda a cada
    // mensagem recebida, e o snapshot completo (`getBudgetStatus`) são cinco
    // leituras — gastá-las para descobrir que a proteção está desligada seria
    // o custo do guard maior que o do classificador.
    const { data: linha, error: erroDaLinha } = await admin
      .from("ai_budgets")
      .select("enforcement_mode")
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (erroDaLinha) {
      logger.warn("ai-budget: modo do orçamento não pôde ser lido — a chamada SEGUE sem teto", {
        organization_id: organizationId,
        purpose,
        causa: erroDaLinha.message,
      });
      return { pode: true, porque: "leitura_falhou" };
    }
    const modo = normalizarModoDeOrcamento(
      (linha as { enforcement_mode?: string | null } | null)?.enforcement_mode ?? null,
    );
    if (modo === "off") return { pode: true, porque: "modo_desligado" };

    const status = await getBudgetStatus(organizationId);

    // "Neste mês", e não "aberto" — a mesma régua da CTE `avisado_antes` e do
    // guard legado: fechar o aviso à mão não pode virar bypass do bloqueio.
    const agora = new Date();
    const inicioDoMes = new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1),
    ).toISOString();
    const { count, error: erroDoAviso } = await admin
      .from("agent_inbox_items")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("kind", "budget_warning")
      .gte("created_at", inicioDoMes);
    if (erroDoAviso) {
      // Sem saber se houve aviso, a condição 6 resolve para "não avisou" — o
      // lado que segue, nunca o que bloqueia sem aviso.
      logger.warn("ai-budget: não deu para saber se já houve aviso de orçamento neste mês", {
        organization_id: organizationId,
        purpose,
        causa: erroDoAviso.message,
      });
    }

    const veredito = decidirOrcamento({
      modo: status.enforcement_mode,
      tetoCents: status.monthly_limit_cents,
      gastoCents: status.current_month_consumed_cents,
      efetivoEm:
        status.enforcement_effective_at === null ? null : new Date(status.enforcement_effective_at),
      agora,
      purpose,
      chave: status.enforcement_env,
      limiarPct: status.alarm_threshold_pct,
      avisadoNesteMes: !erroDoAviso && (count ?? 0) > 0,
    });

    if (veredito.acao === "seguir") return { pode: true, porque: veredito.porque };
    if (veredito.acao === "avisar_e_seguir") return { pode: true, porque: "avisar_e_seguir" };
    return {
      pode: false,
      porque: "teto_atingido",
      gastoCents: status.current_month_consumed_cents,
      tetoCents: status.monthly_limit_cents,
    };
  } catch (err) {
    // `createAdminClient()` lança sem `SUPABASE_SERVICE_ROLE_KEY`; nada aqui
    // pode derrubar quem chama.
    logger.warn("ai-budget: consulta do orçamento falhou — a chamada SEGUE sem teto", {
      organization_id: organizationId,
      purpose,
      causa: err instanceof Error ? err.message : String(err),
    });
    return { pode: true, porque: "leitura_falhou" };
  }
}
