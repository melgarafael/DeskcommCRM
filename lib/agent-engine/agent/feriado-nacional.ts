/**
 * O FERIADO NACIONAL NO TURNO — o fato que faltava no contexto do agente.
 *
 * ─── O defeito, medido (#3877) ──────────────────────────────────────────────
 *
 * Em 02/11/2026 (Finados, feriado nacional) dois agentes desta instalação
 * disseram a clientes "atendemos hoje até as 18h", e um deles convidou a pessoa
 * a ir até a loja. A empresa estava fechada.
 *
 * O prompt informa o horário semanal (seg–sex, 8h–18h) e o bloco `## Agora`
 * (`lib/tempo/agora.ts`) diz o dia da semana. Com essas duas informações o
 * agente fez exatamente o que foi mandado fazer: era segunda-feira, o
 * expediente de segunda vale, logo atende. O que ele não tinha — em lugar
 * nenhum do turno — era o fato de que AQUELE dia é feriado nacional.
 *
 * O CRM já calcula esse calendário: `isHolidayBR` (`lib/lgpd/holidays-br.ts`),
 * usado pelo prazo da LGPD, cobre 2000–2100 com a Páscoa calculada. Não existe
 * segunda régua de feriado neste arquivo, e não pode passar a existir: duas
 * listas de datas divergem no primeiro ano em que uma delas é atualizada.
 *
 * ─── Fuso PRIMEIRO, data depois ─────────────────────────────────────────────
 *
 * A pergunta do turno é "que dia é hoje NA ORGANIZAÇÃO", e a data civil vem de
 * `dataIsoNoFuso`/`somarDiasNoFuso` — a mesma régua do vencimento de proposta,
 * que soma dia de CALENDÁRIO e não blocos de 24h. Às 21h30 de 02/11 em São
 * Paulo já é 03/11 em UTC: um turno que formatasse a data em UTC diria "hoje
 * não é feriado" no próprio feriado e "hoje é feriado" no dia seguinte.
 * Feriado marcado no dia errado é pior que feriado nenhum.
 *
 * `isHolidayBR` lê a data de calendário em `America/Sao_Paulo` por desenho
 * (é o fuso do prazo legal). Para ele responder sobre a data LOCAL da
 * organização sem uma segunda régua, a data civil é ancorada ao MEIO-DIA UTC
 * do próprio dia: 12:00Z é 09:00 em São Paulo do MESMO dia, então a função
 * brasileira recebe exatamente a data que o turno quer perguntar. A âncora é
 * imune a horário de verão porque meio-dia UTC está longe das duas viradas.
 *
 * ─── País ≠ Brasil NÃO recebe feriado brasileiro ────────────────────────────
 *
 * O calendário é por ORGANIZAÇÃO (`organizations.country`, nulo = Brasil,
 * migration 0277) e quem resolve isso é `perfil-do-pais.ts`. Uma clínica em
 * Lisboa com o Finados no prompt prometeria fechamento num dia em que abre —
 * o mesmo defeito, ao contrário. Feriado LOCAL/municipal e o calendário de
 * outros países são outra fatia (declarada fora de escopo na issue).
 *
 * ─── O fato NEGATIVO também é fato ──────────────────────────────────────────
 *
 * Dia comum rende bloco dizendo que hoje e amanhã NÃO são feriados. Omitir o
 * bloco nos dias comuns faria o agente ver a ausência da informação como
 * "não sei" — e o silêncio é onde ele inventa. O custo é uma linha de prompt
 * por turno.
 *
 * ─── Isto INFORMA; não bloqueia nada ────────────────────────────────────────
 *
 * Nada aqui mexe em `aviso-fora-do-horario` nem em bloqueio de envio: o agente
 * recebe o fato e decide com ele. Uma empresa que abre no feriado continua
 * podendo atender — quem sabe disso é a equipe, e é por isso que o texto manda
 * confirmar antes de prometer, em vez de afirmar que está fechado.
 *
 * ─── Falha ABERTA ───────────────────────────────────────────────────────────
 *
 * `organizations.timezone` não tem CHECK e o `Intl` lança em fuso torto: fuso
 * inválido degrada para `FUSO_PADRAO`, como em `renderAgora`. A leitura do país
 * (`lerFeriadoDoTurno`) nunca lança: falhou, o turno segue sem o fato, nunca sem
 * o atendimento.
 */
import { isHolidayBR } from "@/lib/lgpd/holidays-br";
import { perfilDoPais } from "@/lib/legal/perfil-do-pais";
import { dataIsoNoFuso, somarDiasNoFuso } from "@/lib/propostas/data-no-fuso";
import { FUSO_PADRAO, fusoValido } from "@/lib/tempo/fusos";

import type { Logger } from "../obs/logger";
import type { Queryable } from "../queue/queue";

/** O que o turno precisa saber: as duas datas locais e se cada uma é feriado. */
export interface FeriadoNoTurno {
  /** Data civil de HOJE na organização, `YYYY-MM-DD`. */
  hojeEm: string;
  /** Data civil de AMANHÃ na organização, `YYYY-MM-DD`. */
  amanhaEm: string;
  hoje: boolean;
  amanha: boolean;
}

/** `2026-11-02` → `02/11/2026`, o formato que o agente lê e repete. */
function diaMesAno(dataIso: string): string {
  const [ano, mes, dia] = dataIso.split("-");
  return `${dia}/${mes}/${ano}`;
}

/**
 * A data CIVIL recebe a régua brasileira de feriado, sem segunda lista.
 *
 * A âncora ao meio-dia UTC existe para `isHolidayBR` (que formata em
 * `America/Sao_Paulo`) enxergar a data local pedida — ver o cabeçalho.
 */
function ehFeriadoNacionalBrasileiro(dataIso: string): boolean {
  return isHolidayBR(new Date(`${dataIso}T12:00:00.000Z`));
}

/**
 * Hoje e amanhã são feriado nacional? `null` = o país não é o Brasil, e a
 * pergunta não se aplica a esta organização.
 *
 * `agora` é parâmetro, nunca `new Date()` interno: o turno tem relógio
 * injetável (`deps.clock`) e um segundo relógio aqui faria o teste com clock
 * fixo medir uma coisa e a produção outra.
 */
export function feriadoNacionalNoTurno(
  agora: Date,
  fuso: string,
  pais: string | null | undefined,
): FeriadoNoTurno | null {
  // `perfilDoPais` é a régua de país do repo: nulo/vazio = Brasil, e país
  // desconhecido degrada para o mesmo padrão (com rastro no log, lá).
  if (perfilDoPais(pais).codigo !== "BR") return null;

  const fusoEmVigor = fusoValido(fuso) ? fuso : FUSO_PADRAO;
  const hojeEm = dataIsoNoFuso(agora, fusoEmVigor);
  const amanhaEm = somarDiasNoFuso(agora, 1, fusoEmVigor);

  return {
    hojeEm,
    amanhaEm,
    hoje: ehFeriadoNacionalBrasileiro(hojeEm),
    amanha: ehFeriadoNacionalBrasileiro(amanhaEm),
  };
}

/**
 * O fato do turno, lido do banco: o país vem de `organizations.country` (nulo =
 * Brasil, a régua de `perfil-do-pais.ts`) e o resto é `feriadoNacionalNoTurno`.
 *
 * A leitura é PRÓPRIA deste módulo, e não do `fuso-da-org.ts`: aquela função é
 * mockada por vários testes de vizinhança (`assistido-*`, `janela-*`,
 * `autonomia-*`), e acrescentar um segundo export a um módulo mockado quebra
 * todos eles por um motivo que não tem nada a ver com o defeito. O custo é uma
 * consulta de chave primária por turno.
 *
 * ⚠️ Falha ABERTA, e o `null` aqui significa "não sei o país", não "não é
 * feriado": derrubar o turno por causa de uma leitura de configuração seria
 * trocar uma frase errada por um agente mudo (doutrina de `fuso-da-org.ts`).
 * Sem o país, o bloco não entra e o motivo vai ao log.
 */
export async function lerFeriadoDoTurno(
  db: Queryable,
  organizationId: string,
  agora: Date,
  fuso: string,
  log?: Logger,
): Promise<FeriadoNoTurno | null> {
  let pais: string | null = null;
  try {
    const { rows } = await db.query<{ country: string | null }>(
      "select country from organizations where id = $1",
      [organizationId],
    );
    pais = rows[0]?.country ?? null;
  } catch (err) {
    log?.warn("não consegui ler o país da organização — o turno segue sem feriado nacional", {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
    return null;
  }
  return feriadoNacionalNoTurno(agora, fuso, pais);
}

/**
 * O bloco `## Feriado nacional` que entra no sufixo por-lead do turno, ao lado
 * do `## Agora`. Vazio (`''`) quando o país não é o Brasil.
 *
 * ⚠️ Não cita nome de feriado ("Finados"): o calendário de `holidays-br.ts` é
 * de DATAS, e inventar o nome para cada uma seria escrever, aqui, a lista que
 * o cabeçalho proíbe.
 */
export function blocoDoFeriado(f: FeriadoNoTurno | null): string {
  if (f === null) return "";

  const hoje = `Hoje (${diaMesAno(f.hojeEm)})`;
  const amanha = `Amanhã (${diaMesAno(f.amanhaEm)})`;

  if (f.hoje && f.amanha) {
    return [
      "## Feriado nacional",
      `${hoje} e ${amanha.charAt(0).toLowerCase()}${amanha.slice(1)} são feriados nacionais no Brasil. ` +
        "Feriado nacional não é dia útil: o expediente normal do horário de funcionamento NÃO vale para nenhum dos dois dias. " +
        "Não prometa atendimento nesses dias e não convide a pessoa a ir até a loja sem antes confirmar com a equipe.",
    ].join("\n");
  }

  if (f.hoje) {
    return [
      "## Feriado nacional",
      `${hoje} é feriado nacional no Brasil. ` +
        "Feriado nacional não é dia útil: o expediente normal do horário de funcionamento NÃO vale para hoje. " +
        "Não diga que a empresa atende hoje nem convide a pessoa a ir até a loja sem antes confirmar com a equipe.",
    ].join("\n");
  }

  if (f.amanha) {
    return [
      "## Feriado nacional",
      `${amanha} é feriado nacional no Brasil. ` +
        "Feriado nacional não é dia útil: o expediente normal do horário de funcionamento NÃO vale para amanhã. " +
        "Não prometa atendimento para amanhã assumindo dia útil nem marque compromisso lá; se a pessoa pedir, confirme com a equipe.",
    ].join("\n");
  }

  return [
    "## Feriado nacional",
    `${hoje} e ${amanha.charAt(0).toLowerCase()}${amanha.slice(1)} NÃO são feriados nacionais no Brasil.`,
  ].join("\n");
}
