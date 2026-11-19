/**
 * O PRAZO DE UM PASSO RELATIVO A UM CAMPO DE DATA DO CARD (#4717 item 4).
 *
 * ═══ O QUE MUDOU ═══
 *
 * O plano de tarefas nasceu com UMA régua de prazo: `vence_em_dias`, contado da
 * aplicação (`agora + N × 24h`). Isso cobre "ligar em 2 dias" e não cobre
 * "cobrar 7 dias ANTES da data da viagem" — o processo comercial que mais
 * precisa de checklist é justamente o que tem data na frente (viagem,
 * casamento, cirurgia, entrega), e nele o prazo das tarefas não é medido do
 * dia em que alguém aplicou o plano: é medido do dia do EVENTO.
 *
 * ═══ O QUE FICA GRAVADO ═══
 *
 * Cada passo pode declarar, além do modo antigo:
 *
 *   { "modo": "campo_de_data", "campo": "data_da_viagem", "dias": -7 }
 *
 * `campo` é a CHAVE do campo personalizado de DATA do NEGÓCIO (a mesma que
 * `camposDeDataDoNegocio` oferece aos seletores, `lib/leads/campos-do-funil.ts`)
 * e o valor do card mora em `crm_leads.custom_fields` no formato `YYYY-MM-DD`
 * (o `<input type="date">` grava assim; data cheia vinda de API vale pelo dia
 * que ela significa, régua de `diaDe`). `dias` é o deslocamento: NEGATIVO é
 * antes da data do campo, POSITIVO é depois, `0` é o próprio dia.
 *
 * Ausente, o passo é o de sempre: `{ modo: "dias_a_partir_de_hoje", dias }`,
 * normalizado de `vence_em_dias`. Plano antigo NÃO muda de comportamento — a
 * normalização devolve exatamente o número que já estava lá.
 *
 * ═══ A CONTA MORA NO BANCO, E SÓ LÁ ═══
 *
 * `fn_prazo_do_campo(p_dia, p_dias, p_fuso)` é a ÚNICA implementação da conta:
 * a aplicação do plano a chama para gravar a tarefa e o gatilho
 * `crm_leads_recalcula_prazos_do_plano` a chama quando a data do card muda.
 * Escrever a aritmética duas vezes (uma em TS, outra em SQL) é o defeito que
 * este módulo existe para não repetir: as duas "calculam o prazo", só que uma
 * delas atravessa o horário de verão e a outra não.
 *
 * Por que 09:00 e não meia-noite: o prazo é um dia de TRABALHO. Uma tarefa que
 * vence à meia-noite do dia 10 aparece atrasada durante todo o dia 10, porque
 * já passou; às 09:00 ela vence quando o expediente começa — a mesma hora da
 * varredura do gatilho de data (`HORA_DA_VARREDURA`, `lib/automation/cron-de-data.ts`).
 *
 * ═══ CAMPO VAZIO NÃO INVENTA PRAZO ═══
 *
 * Data ausente (ou lixo) não vira "hoje", não vira "daqui a N dias" e não vira
 * erro que derruba o plano inteiro: o passo nasce SEM prazo (`due_date` nulo, o
 * mesmo estado que a coluna já trata como "sem prazo") e o motivo fica gravado
 * em `crm_tasks.prazo_motivo`, junto da chave em `crm_tasks.prazo_campo` — é
 * com esse par que a tela diz QUAL campo falta preencher.
 */
import { z } from "zod";

import type { Db } from "@/lib/db";
import { diaDe } from "@/lib/kanban/calendario-do-funil";
import { LIMITES_DO_PLANO } from "@/lib/tarefas/limites-do-plano";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

/** Os dois modos. A ordem é a que a tela mostra. */
export const MODOS_DE_PRAZO = ["dias_a_partir_de_hoje", "campo_de_data"] as const;
export type ModoDePrazo = (typeof MODOS_DE_PRAZO)[number];

/**
 * Por que a tarefa nasceu (ou ficou) sem prazo.
 *
 * Código, não frase: quem traduz é a tela, e o código é o que viaja no payload
 * da atividade e no `detail` da aplicação. `campo_de_data_invalido` cobre o
 * valor que existe e não é data (`"amanhã"`, `"2026-02-30"`), que a régua de
 * `diaDe` recusa — o operador precisa saber que o campo está PREENCHIDO torto,
 * e não que está vazio.
 */
export const MOTIVOS_SEM_PRAZO = {
  campoVazio: "campo_de_data_vazio",
  campoInvalido: "campo_de_data_invalido",
} as const;
export type MotivoSemPrazo = (typeof MOTIVOS_SEM_PRAZO)[keyof typeof MOTIVOS_SEM_PRAZO];

/**
 * O prazo de UM passo, já normalizado. Discriminado por `modo` de propósito:
 * quem consome não pode ler `dias` sem saber de onde ele conta.
 */
export type PrazoDoPasso =
  | { modo: "dias_a_partir_de_hoje"; dias: number }
  | { modo: "campo_de_data"; campo: string; dias: number };

/**
 * A forma que o passo aceita em `settings.task_plans[].passos[]`.
 *
 * `campo` é opcional no schema e obrigatório no `modo: "campo_de_data"` — a
 * conferência fica no `superRefine` do passo (`lib/tarefas/plano.ts`), não aqui,
 * porque a frase de recusa é da tela do plano.
 */
export const prazoDoPassoSchema = z.object({
  modo: z.enum(MODOS_DE_PRAZO),
  campo: z.string().trim().min(1).max(LIMITES_DO_PLANO.campoDeData).nullish(),
  dias: z.number().int().min(-LIMITES_DO_PLANO.venceEmDias).max(LIMITES_DO_PLANO.venceEmDias),
});

export type PrazoDoPassoBruto = z.infer<typeof prazoDoPassoSchema>;

/**
 * O prazo normalizado de um passo gravado — inclusive o passo ANTIGO, que só
 * tem `vence_em_dias`.
 *
 * `vence_em_dias` sempre ganha quando falta `prazo`: é o formato que o produto
 * gravou até aqui e o que o curso semeia. Quando os dois vêm, o `prazo` manda —
 * ele é a forma nova, e o número antigo (quando sobra no JSON de um plano
 * editado à mão) é lixo de edição, não a intenção de quem gravou.
 */
export function prazoDoPasso(
  passo: { vence_em_dias?: number | null; prazo?: PrazoDoPassoBruto | null },
): PrazoDoPasso {
  if (passo.prazo) {
    return passo.prazo.modo === "campo_de_data"
      ? { modo: "campo_de_data", campo: String(passo.prazo.campo ?? ""), dias: passo.prazo.dias }
      : { modo: "dias_a_partir_de_hoje", dias: passo.prazo.dias };
  }
  return { modo: "dias_a_partir_de_hoje", dias: passo.vence_em_dias ?? 0 };
}

/** Os valores de `crm_leads.custom_fields`, com lixo virando objeto vazio. */
export function camposDoNegocio(campos: unknown): Record<string, unknown> {
  return campos && typeof campos === "object" && !Array.isArray(campos)
    ? (campos as Record<string, unknown>)
    : {};
}

/**
 * O dia que o campo do card guarda, ou `null`.
 *
 * A régua é a de `diaDe` (`lib/kanban/calendario-do-funil.ts`), a MESMA do
 * Calendário do funil: campo de data é `YYYY-MM-DD`, data cheia vale pelo dia
 * que ela significa, e o que não é data devolve `null` — nunca um palpite.
 */
export function diaDoCampoDoNegocio(
  campos: unknown,
  chave: string,
): { dia: string | null; preenchido: boolean } {
  const bruto = camposDoNegocio(campos)[chave];
  const preenchido = bruto !== undefined && bruto !== null && String(bruto).trim() !== "";
  return { dia: diaDe(bruto), preenchido };
}

/**
 * O instante do prazo, no fuso da organização.
 *
 * A conta é `fn_prazo_do_campo` (migration, `baseline.sql`): dia + deslocamento
 * no calendário e 09:00 no fuso do tenant. Uma ida ao banco por passo é o preço
 * de ter UMA implementação da conta; o `fuso` chega já validado por
 * `fusoUtilizavel` (o `at time zone` do Postgres estoura com fuso inexistente).
 */
export async function prazoDoCampoNoFuso(
  db: Db,
  pedido: { dia: string; dias: number; fuso: string },
): Promise<string> {
  const linha = await db.queryOne<{ prazo: Date | string | null }>(
    `select fn_prazo_do_campo($1::date, $2::integer, $3::text) as prazo`,
    [pedido.dia, pedido.dias, fusoUtilizavel(pedido.fuso)],
  );
  const valor = linha?.prazo ?? null;
  if (valor instanceof Date) return valor.toISOString();
  if (typeof valor === "string") return new Date(valor).toISOString();
  throw new Error("fn_prazo_do_campo não devolveu prazo");
}

/** O que a aplicação precisa saber para gravar UM passo de data. */
export interface PrazoDoCampoResolvido {
  /** Instante ISO do prazo; `null` = nasce sem prazo. */
  venceEm: string | null;
  motivo: MotivoSemPrazo | null;
}

/**
 * Resolve o prazo de um passo de campo de data contra o card.
 *
 * Não lança por campo vazio: ausência é resposta (`sem prazo` + motivo), não
 * falha. Lança só quando o banco não responde — quem chama decide se isso
 * derruba a aplicação (`falha`), e é o que mantém o desfecho de infra visível.
 */
export async function resolverPrazoDoCampo(
  db: Db,
  pedido: { campo: string; dias: number; campos: unknown; fuso: string },
): Promise<PrazoDoCampoResolvido> {
  const { dia, preenchido } = diaDoCampoDoNegocio(pedido.campos, pedido.campo);
  if (!dia) {
    return {
      venceEm: null,
      motivo: preenchido ? MOTIVOS_SEM_PRAZO.campoInvalido : MOTIVOS_SEM_PRAZO.campoVazio,
    };
  }
  return {
    venceEm: await prazoDoCampoNoFuso(db, { dia, dias: pedido.dias, fuso: pedido.fuso }),
    motivo: null,
  };
}
