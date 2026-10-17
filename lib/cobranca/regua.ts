/**
 * A RÉGUA DA COBRANÇA, PURA (spec da cobrança do revendedor §3.2, D-5, D-6).
 *
 * Diz o que fazer com UMA assinatura agora: nada, reativar, suspender, avisar
 * ou cancelar no provedor. Sem banco e sem relógio: `agora` é injetado, e quem
 * age é `aplicarRegua` (`lib/cobranca/sincronizar.ts`), só por funções SQL
 * idempotentes. As garantias, cada uma com caso em `regua.test.ts`:
 *   - ninguém é suspenso sem o aviso final DESTA dívida gravado há ≥ 48 h
 *     corridas — a data de calendário não conta;
 *   - com provedor, nunca se suspende com leitura de mais de 1 h;
 *   - teste grátis vencido sem pagamento vira dívida (não é acesso eterno), e
 *     NÃO espera a tolerância de D-5 quando não há cobrança em jogo (nenhuma
 *     assinatura viva no provedor): o limite é o aviso final + 48 h (#2753);
 *   - a tolerância nunca fica abaixo de 5 dias, digite o dono o que digitar;
 *   - suspensão administrativa é do dono: a régua não avisa nem reativa.
 */
import type { AvisoDaRegua, EstadoDaAssinatura } from "@/lib/cobranca/vocabulario";
import { ehOperante, tipoDaSuspensao } from "@/lib/organizacao/operante";

/**
 * Boleto e Pix levam até 1 dia útil, e um fim de semana entra no meio (D-5).
 * O piso vale para a dívida de QUEM TEM PAGAMENTO no jogo — nunca para o trial
 * vencido, que a régua separa em `dividaDoTeste` (#2753).
 */
export const PISO_DA_TOLERANCIA_DIAS = 5;

const HORA_MS = 3_600_000;
const DIA_MS = 24 * HORA_MS;
const JANELA_DO_AVISO_FINAL_MS = 2 * DIA_MS;
const ESPERA_DEPOIS_DO_AVISO_FINAL_MS = 48 * HORA_MS;
const LEITURA_FRESCA_MS = HORA_MS;
const ANTECEDENCIA_DO_FIM_DO_TESTE_MS = 3 * DIA_MS;
/** Suspensa e ainda devendo: um lembrete por semana, com o caminho para pagar no e-mail. */
const LEMBRETE_DA_SUSPENSAO_MS = 7 * DIA_MS;

export interface AssinaturaNaRegua {
  readonly estado: EstadoDaAssinatura;
  readonly temProvedor: boolean;
  readonly cancelaNoFim: boolean;
  readonly assinaturasVivas: number;
  readonly trialAte: Date | null;
  readonly vencidaDesde: Date | null;
  readonly proximoVencimento: Date | null;
  readonly prazoExtraAte: Date | null;
  readonly ultimoAviso: AvisoDaRegua | null;
  readonly ultimoAvisoEm: Date | null;
  readonly relidaEm: Date | null;
  /** Plano com entrada paga (D-16): nunca houve teste grátis, mesmo com `trial_ate` gravado na criação. */
  readonly entradaPendente: boolean;
}

export interface OrgNaRegua {
  readonly status: string;
  readonly suspendedKind: string | null;
}

/**
 * De onde vem a dívida — muda a frase do aviso E se a tolerância de D-5 vale
 * (`dividaDoTeste` em `decidirRegua`): "teste" nunca pagou nada (#2753).
 */
export type OrigemDaDivida = "atraso" | "teste" | "cancelamento";

export type AcaoDaRegua =
  | { tipo: "nada" }
  | { tipo: "reativar" }
  | { tipo: "suspender"; debitoDesde: Date; origem: OrigemDaDivida }
  | { tipo: "avisar"; aviso: AvisoDaRegua; debitoDesde: Date | null; data: Date; origem: OrigemDaDivida }
  | { tipo: "cancelar_no_provedor" };

export interface DecisaoDaRegua {
  readonly acao: AcaoDaRegua;
  /** O estado depois da transição de tempo (teste vencido sem provedor vira `em_atraso`). */
  readonly estado: EstadoDaAssinatura;
  /** `vencida_desde` a gravar antes da ação; `null` = não mexe. */
  readonly gravarVencidaDesde: Date | null;
}

const NADA: AcaoDaRegua = { tipo: "nada" };

export function decidirRegua(
  a: AssinaturaNaRegua,
  org: OrgNaRegua,
  agora: Date,
  toleranciaConfigurada: number,
): DecisaoDaRegua {
  const t = agora.getTime();
  let estado = a.estado;
  let vencida = a.vencidaDesde;
  let gravar: Date | null = null;
  const decisao = (acao: AcaoDaRegua): DecisaoDaRegua => ({ acao, estado, gravarVencidaDesde: gravar });

  const suspensao = tipoDaSuspensao(org.status, org.suspendedKind);
  if (suspensao === "administrativa") return decisao(NADA);
  if (suspensao === null && !ehOperante(org.status)) {
    // Redigida ou arquivada: ninguém vai pagar nem usar. Cancela uma vez no provedor, sem aviso.
    const cobraAinda = a.temProvedor && a.estado !== "cancelada" && !a.cancelaNoFim;
    return decisao(cobraAinda ? { tipo: "cancelar_no_provedor" } : NADA);
  }

  // Teste grátis sem provedor que acabou: vira dívida desde o fim do teste. Com
  // provedor, quem traduz é `sincronizar` (a Stripe pode estar no teste dela).
  if (estado === "trial" && !a.temProvedor && (a.trialAte === null || a.trialAte.getTime() <= t)) {
    estado = "em_atraso";
    vencida = a.trialAte ?? agora;
    gravar = vencida;
  }

  const suspensaPorCobranca = suspensao === "cobranca";
  if ((estado === "ativa" || estado === "trial") && suspensaPorCobranca) return decisao({ tipo: "reativar" });

  let debito: Date | null = null;
  if (estado === "em_atraso" || (estado === "cancelada" && a.proximoVencimento === null)) {
    // Sem data persistida, `agora` mudaria a cada rodada e nenhum aviso
    // "pertenceria" à dívida: a primeira avaliação grava o início dela.
    if (vencida === null) {
      vencida = agora;
      gravar = agora;
    }
    debito = vencida;
  } else if (estado === "cancelada" && a.proximoVencimento !== null && a.proximoVencimento.getTime() <= t) {
    debito = a.proximoVencimento;
  }

  if (debito !== null) {
    // Dívida do teste (#2753): nasceu no fim do teste e não há cobrança em jogo
    // — nenhum provedor (nunca houve checkout), ou `vencida_desde` É o fim do
    // teste (estado.ts, `doTesteVencido`) e nenhuma assinatura viva no provedor.
    // Sem boleto nem Pix esperando compensação, a tolerância de D-5 não cabe:
    // vale o aviso final + 48 h. Com assinatura viva há cobrança em jogo (no
    // Asaas o 1º boleto vence no próprio fim do teste e fica PENDING até
    // compensar): é o caso de D-5, e ele espera a tolerância. A entrada paga
    // (D-16) grava `trial_ate` = criação sem ter havido teste.
    const dividaDoTeste =
      !a.entradaPendente &&
      (!a.temProvedor ||
        (a.assinaturasVivas === 0 && a.trialAte !== null && vencida !== null && vencida.getTime() === a.trialAte.getTime()));
    const origem: OrigemDaDivida = estado === "cancelada" ? "cancelamento" : dividaDoTeste ? "teste" : "atraso";
    if (suspensaPorCobranca) {
      // Um e-mail de "suspensa" e silêncio para sempre não recupera receita: um
      // lembrete por semana. `debitoDesde` = agora − 7 d faz a função SQL aceitar
      // o MESMO aviso de novo só quando o anterior é mais velho que isso.
      const desdeOUltimo = t - (a.ultimoAvisoEm?.getTime() ?? 0);
      return decisao(
        desdeOUltimo > LEMBRETE_DA_SUSPENSAO_MS
          ? { tipo: "avisar", aviso: "suspensa", debitoDesde: new Date(t - LEMBRETE_DA_SUSPENSAO_MS), data: debito, origem }
          : NADA,
      );
    }
    const tolerancia = Math.max(PISO_DA_TOLERANCIA_DIAS, Math.trunc(toleranciaConfigurada)) * DIA_MS;
    const limite = Math.max(
      // A tolerância é para a dívida de quem tem pagamento no jogo; a do teste
      // vencido é zero, e `prazo_extra_ate` continua valendo para as duas.
      debito.getTime() + (estado === "em_atraso" && origem !== "teste" ? tolerancia : 0),
      a.prazoExtraAte?.getTime() ?? 0,
    );
    // Um aviso só "pertence" a esta dívida se foi dado depois que ela começou:
    // quem pagou e voltou a dever recebe o aviso final de novo.
    const avisoDaDivida =
      a.ultimoAvisoEm !== null && a.ultimoAvisoEm.getTime() >= debito.getTime()
        ? { aviso: a.ultimoAviso, em: a.ultimoAvisoEm.getTime() }
        : null;
    const avisoFinalEm = avisoDaDivida?.aviso === "suspende_em_breve" ? avisoDaDivida.em : null;
    const leituraFresca = !a.temProvedor || (a.relidaEm !== null && a.relidaEm.getTime() >= t - LEITURA_FRESCA_MS);

    if (t >= limite && avisoFinalEm !== null && t - avisoFinalEm >= ESPERA_DEPOIS_DO_AVISO_FINAL_MS && leituraFresca) {
      return decisao({ tipo: "suspender", debitoDesde: debito, origem });
    }
    const avisoFinalDado = avisoDaDivida?.aviso === "suspende_em_breve" || avisoDaDivida?.aviso === "suspensa";
    if (t >= limite - JANELA_DO_AVISO_FINAL_MS && !avisoFinalDado) {
      const data = new Date(Math.max(limite, t + ESPERA_DEPOIS_DO_AVISO_FINAL_MS));
      return decisao({ tipo: "avisar", aviso: "suspende_em_breve", debitoDesde: debito, data, origem });
    }
    if (estado === "em_atraso" && avisoDaDivida === null) {
      return decisao({ tipo: "avisar", aviso: "venceu", debitoDesde: debito, data: debito, origem });
    }
    return decisao(NADA);
  }

  const fimDoTeste = a.trialAte?.getTime() ?? null;
  if (
    estado === "trial" &&
    a.assinaturasVivas === 0 &&
    a.ultimoAviso === null &&
    fimDoTeste !== null &&
    fimDoTeste > t &&
    fimDoTeste - ANTECEDENCIA_DO_FIM_DO_TESTE_MS <= t
  ) {
    return decisao({ tipo: "avisar", aviso: "trial_acabando", debitoDesde: null, data: new Date(fimDoTeste), origem: "teste" });
  }
  return decisao(NADA);
}
