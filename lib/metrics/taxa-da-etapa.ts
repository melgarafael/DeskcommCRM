/**
 * A taxa histórica de ganho por etapa (issue #1753) — a CONTA, sem rota nem tela.
 *
 * A proposta é propositalmente NÃO um modelo: o sistema já sabe a resposta, é
 * contar quantos dos que passaram por cada etapa terminaram ganhos, mostrar a
 * contagem ao gestor e deixar a decisão de gravar com quem opera. O mesmo
 * argumento de `lib/leads/score-formula.ts` (um humano que discorda aponta qual
 * parcela está errada, em vez de discordar de um oráculo) e o mesmo contrato do
 * `crm_lead_scores_needs_reason`: número com AMOSTRA à vista, nunca percentagem
 * solta.
 *
 * ─── As quatro regras que este arquivo não deixa errar ──────────────────────
 *
 * 1. **A AMOSTRA É O NÚMERO.** `total` (encerrados que passaram pela etapa) e
 *    `ganhos` viajam juntos; `percentual` é derivado deles, nunca o contrário.
 *
 * 2. **SEM DADOS NÃO É 0%.** Etapa que ninguém atravessou devolve `total: 0` e
 *    `percentual: null`. `0%` afirmaria «já passaram 20 e nenhum fechou» — o
 *    oposto do silêncio, e um número que calibraria a previsão para trás.
 *
 * 3. **SUGESTÃO EXIGE AMOSTRA (`MINIMO_DE_CASOS`).** Abaixo disso a fração
 *    ainda é mostrada (é dado), mas o CONVITE «usar N%?» não aparece: com 7
 *    casos, arredondar é chute com cara de regra.
 *
 * 4. **SÓ ENCERRADOS CONTEM, e o critério é a ÚLTIMA mudança da janela.** Um
 *    negócio cuja última passagem aterrissa numa etapa comum está ABERTO e fica
 *    de fora — inclusive o que foi ganho e reabriu. É a leitura de «os abertos
 *    ficam de fora» sem depender de nenhuma coluna nova: tudo sai de
 *    `crm_lead_activities.type = 'stage_changed'`, que todos os caminhos de
 *    movimento já emitem (arrasto, lote, handler, IA, handoff, agendamento,
 *    arquivamento de etapa).
 *
 * ─── Duas grafias de payload, e por que as duas entram ──────────────────────
 *
 * Os escritores do repositório não concordam entre si: as rotas de movimento e
 * `stage-operations` gravam `from_stage_id`/`to_stage_id`; `agent-stage-sync`,
 * `handoff-stage-move` e `appointment-stage-move` gravam `de`/`para` (com
 * `pipeline_id` só no payload do evento, não na atividade). Ler só a primeira
 * grafia subcontaria exatamente a mão que não é humana — e a segunda perna
 * (`de`) é também o único rastro de quem NASCEU na etapa: `nascimento-do-lead`
 * não emite `stage_changed` de entrada, então o negócio criado já em «Proposta»
 * só aparece na conta quando sai de lá.
 *
 * ─── O que este arquivo NÃO alcança ─────────────────────────────────────────
 *
 * A passagem conta se aconteceu DENTRO da mesma janela do encerramento. Um
 * negócio que entrou na etapa há 13 meses e fechou há 1 mês não é contado —
 * ler o histórico inteiro exigiria outra consulta (e provavelmente outro índice).
 * Declarado no PR, em «O que NÃO medi», em vez de escondido num número.
 */
import type { Json } from "@/lib/database.types";

/**
 * Abaixo disso não há sugestão, só a contagem. Issue #1753: «sem sugestão
 * abaixo de 10 casos». Fixo e exportado para a tela poder citar a régua.
 */
export const MINIMO_DE_CASOS = 10;

/** Uma linha de `crm_lead_activities` com `type = 'stage_changed'`. */
export interface AtividadeDaEtapa {
  lead_id: string;
  performed_at: string;
  payload: Json;
}

/** O que a conta precisa saber de cada etapa do funil. */
export interface EtapaDaTaxa {
  id: string;
  is_won: boolean;
  is_lost: boolean;
}

/** A janela de tempo que o número declara — ele não existe sem ela. */
export interface Janela {
  inicio: string;
  fim: string;
}

/** A contagem de UMA etapa, com a amostra sempre à vista. */
export interface TaxaDaEtapa {
  etapa_id: string;
  /** Encerrados que passaram por aqui na janela — o DENOMINADOR visível. */
  total: number;
  /** Desses, quantos terminaram ganhos. */
  ganhos: number;
  /** `null` quando `total` é 0: sem dados, não zero porcento. */
  percentual: number | null;
  /** Fração que a rota sugere gravar, ou `null` quando a amostra é pequena. */
  sugestao: number | null;
}

/**
 * Lê um id de etapa do payload, aceitando as DUAS grafias dos escritores.
 * Qualquer coisa que não seja string não- vazia vale como ausência — o payload
 * é `jsonb` livre e quem o escreve não é só este repositório.
 */
function idDaEtapa(payload: Json, ...chaves: string[]): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const registro = payload as Record<string, unknown>;
  for (const chave of chaves) {
    const valor = registro[chave];
    if (typeof valor === "string" && valor.length > 0) return valor;
  }
  return null;
}

/**
 * Calcula a taxa de cada etapa do funil.
 *
 * `atividades` é a janela já recortada pela rota; a filtragem por data se
 * repete AQUI porque a conta é o único lugar que sabe o que a janela significa —
 * e é ela que um teste pode fixar sem depender de relógio de sistema.
 */
export function calcularTaxas(
  atividades: readonly AtividadeDaEtapa[],
  etapas: readonly EtapaDaTaxa[],
  janela: Janela,
): TaxaDaEtapa[] {
  const inicio = Date.parse(janela.inicio);
  const fim = Date.parse(janela.fim);

  // etapa de GANHO ou de PERDA → o negócio que aterrissa nela está encerrado.
  const desfechos = new Map<string, boolean>();
  for (const etapa of etapas) {
    if (etapa.is_won || etapa.is_lost) desfechos.set(etapa.id, etapa.is_won);
  }

  interface Mudanca {
    quando: number;
    de: string | null;
    para: string | null;
  }
  const porNegocio = new Map<string, Mudanca[]>();

  for (const atividade of atividades) {
    const quando = Date.parse(atividade.performed_at);
    if (!Number.isFinite(quando) || quando < inicio || quando > fim) continue;
    const mudancas = porNegocio.get(atividade.lead_id) ?? [];
    mudancas.push({
      quando,
      de: idDaEtapa(atividade.payload, "from_stage_id", "de"),
      para: idDaEtapa(atividade.payload, "to_stage_id", "para"),
    });
    porNegocio.set(atividade.lead_id, mudancas);
  }

  const contagem = new Map<string, { total: number; ganhos: number }>();

  for (const mudancas of porNegocio.values()) {
    mudancas.sort((a, b) => a.quando - b.quando);

    // O estado atual do negócio é o destino da ÚLTIMA mudança legível da
    // janela. Sem destino legível não há como dizer se ele encerrou — fica de
    // fora em vez de virar um 0% fabricado.
    let destino: string | null = null;
    const passou: string[] = [];
    for (const mudanca of mudancas) {
      if (mudanca.de) passou.push(mudanca.de);
      if (mudanca.para) {
        passou.push(mudanca.para);
        destino = mudanca.para;
      }
    }
    if (destino === null) continue;
    const ganhou = desfechos.get(destino);
    if (ganhou === undefined) continue; // aberto — os abertos ficam de fora.

    for (const etapaId of new Set(passou)) {
      const atual = contagem.get(etapaId) ?? { total: 0, ganhos: 0 };
      atual.total += 1;
      if (ganhou) atual.ganhos += 1;
      contagem.set(etapaId, atual);
    }
  }

  return etapas.map((etapa) => {
    const atual = contagem.get(etapa.id) ?? { total: 0, ganhos: 0 };
    const percentual =
      atual.total > 0 ? Math.round((100 * atual.ganhos) / atual.total) : null;
    return {
      etapa_id: etapa.id,
      total: atual.total,
      ganhos: atual.ganhos,
      percentual,
      sugestao: atual.total >= MINIMO_DE_CASOS ? percentual : null,
    };
  });
}
