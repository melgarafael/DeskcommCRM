/**
 * O AVISO DE FORA DO HORÁRIO SABE QUE HOJE É FERIADO NACIONAL (#3877, pedido 3).
 *
 * ─── O defeito medido ───────────────────────────────────────────────────────
 *
 * Em 02/11/2026 (Finados, segunda-feira, feriado nacional) dois agentes
 * disseram a clientes "atendemos hoje até as 18h". A janela semanal (seg–sex,
 * 8h–18h) não distingue feriado de dia útil: quem escreve no feriado recebia o
 * MESMO recado de um dia comum, prometendo atendimento num dia em que a
 * empresa está fechada.
 *
 * O pedido 1 (contexto do turno, `feriado-nacional.ts`) já entrega o FATO ao
 * prompt. Aqui se mede o pedido 3: o TEXTO do aviso. A chave nova
 * (`filters.business_hours.notice_feriado`) é OPCIONAL — sem ela o corpo
 * enviado é o `notice` de hoje, byte a byte.
 *
 * ─── Por que data fixa e fuso explícito ─────────────────────────────────────
 *
 * A régua de feriado é `isHolidayBR` (`lib/lgpd/holidays-br.ts`) e o fuso é o
 * da organização. Um teste com `new Date()` mediria o dia em que o CI rodou —
 * verde no ano em que o feriado cai no fim de semana, vermelho no outro. Aqui
 * o relógio é parâmetro: 02/11/2026 10:00 em `America/Sao_Paulo` (Finados) e
 * 03/11/2026 20:00 (terça, fora da janela).
 *
 * ─── As réguas duras continuam valendo no feriado ───────────────────────────
 *
 * Opt-out/`is_blocked`, titular anonimizado, dedupe por período fechado e
 * pacing são medidos AQUI, no feriado: o aviso não fura nenhuma delas para
 * "avisar que é feriado".
 */
import { describe, expect, it } from "vitest";

import {
  TAMANHO_MAXIMO_DO_TEXTO,
  enviaAvisoForaDoHorario,
  lerTextoDoAvisoDeFeriadoForaDoHorario,
  lerTextoDoAvisoForaDoHorario,
  textoDoAvisoHoje,
  type ContatoDoAviso,
  type PortasDoAviso,
} from "@/lib/agent-engine/agent/aviso-fora-do-horario";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";
const SESSAO = "55555555-5555-4555-8555-555555555555";

/** Janela do relato: segunda a sexta, 8h–18h, no fuso da organização. */
const JANELA = {
  timezone: "America/Sao_Paulo",
  start: "08:00",
  end: "18:00",
  weekdays: [1, 2, 3, 4, 5],
};

/** 02/11/2026 (Finados), segunda, 10:00 em São Paulo — DENTRO da janela semanal. */
const FINADOS_10H = new Date("2026-11-02T13:00:00.000Z");
/** 02/11/2026 (Finados), segunda, 20:00 em São Paulo — fora da janela. */
const FINADOS_20H = new Date("2026-11-02T23:00:00.000Z");
/** 03/11/2026, terça, 20:00 em São Paulo — dia útil, fora da janela. */
const DIA_UTIL_20H = new Date("2026-11-03T23:00:00.000Z");

const NOTICE =
  "Nosso atendimento funciona de segunda a sexta, das 8h às 18h. Recebemos sua mensagem e respondemos no próximo horário de atendimento.";
const NOTICE_FERIADO =
  "Hoje é feriado nacional e não estamos atendendo. Recebemos sua mensagem e respondemos no próximo dia útil.";

interface Cenario {
  contato?: Partial<ContatoDoAviso>;
  /** O fato do dia, injetado: a porta de produção lê `organizations.country`. */
  feriadoHoje?: boolean;
  jaAvisado?: boolean;
  pacing?: { liberado: boolean; motivo?: string };
}

/**
 * As portas do aviso em memória: nada de banco, nada de canal. O que importa é
 * o que SAI (`enviados`) e o motivo da decisão.
 */
function cenario(opcoes: Cenario = {}) {
  const enviados: { body: string; chave: string }[] = [];
  const portas: PortasDoAviso = {
    async leContato() {
      return {
        isBlocked: false,
        forceHuman: false,
        isAnonymized: false,
        phoneNumber: "+5511988887777",
        ...opcoes.contato,
      };
    },
    async ehNumeroInterno() {
      return false;
    },
    async jaAvisado() {
      return opcoes.jaAvisado ?? false;
    },
    // A PORTA NOVA: hoje é feriado nacional NA ORGANIZAÇÃO (fuso + país).
    async ehFeriadoNacionalHoje() {
      return opcoes.feriadoHoje ?? false;
    },
    pacing: {
      async decide() {
        return opcoes.pacing ?? { liberado: true };
      },
      async registraEnvio() {},
    },
    async envia(entrada) {
      enviados.push({ body: entrada.body, chave: entrada.chave });
    },
  };
  return { portas, enviados };
}

async function dispara(entrada: {
  agora: Date;
  texto: string | null;
  textoDeFeriado?: string | null;
  cenario?: Cenario;
}) {
  const c = cenario(entrada.cenario);
  const decisao = await enviaAvisoForaDoHorario(c.portas, {
    organizationId: ORG,
    conversationId: CONVERSA,
    contactId: CONTATO,
    channelSessionId: SESSAO,
    texto: entrada.texto,
    textoDeFeriado: entrada.textoDeFeriado ?? null,
    janela: JANELA,
    agora: entrada.agora,
  });
  return { decisao, enviados: c.enviados };
}

/**
 * Compara o corpo enviado carregando o NOME da configuração: a falha diz qual
 * texto vazou (`campo: "notice_feriado"` com o corpo do `notice` dentro), em
 * vez de só dois parágrafos diferentes.
 */
function esperaCampo(recebido: string | undefined, campo: string, esperado: string) {
  expect({ campo, corpo: recebido }).toEqual({ campo, corpo: esperado });
}

describe("aviso de fora do horário no feriado nacional (#3877)", () => {
  it("feriado nacional com texto próprio: envia o texto de feriado, não o notice", async () => {
    const { decisao, enviados } = await dispara({
      agora: FINADOS_10H,
      texto: NOTICE,
      textoDeFeriado: NOTICE_FERIADO,
      cenario: { feriadoHoje: true },
    });

    expect(decisao).toEqual({ enviar: true, texto: NOTICE_FERIADO });
    expect(enviados).toHaveLength(1);
    esperaCampo(enviados[0]?.body, "notice_feriado", NOTICE_FERIADO);
  });

  it("feriado nacional DEPOIS do expediente: o texto também é o de feriado", async () => {
    const { enviados } = await dispara({
      agora: FINADOS_20H,
      texto: NOTICE,
      textoDeFeriado: NOTICE_FERIADO,
      cenario: { feriadoHoje: true },
    });

    esperaCampo(enviados[0]?.body, "notice_feriado", NOTICE_FERIADO);
  });

  it("feriado nacional SEM texto próprio: o notice de hoje, byte a byte", async () => {
    const triggerConfig = { filters: { business_hours: { ...JANELA, notice: NOTICE } } };
    const doConfig = lerTextoDoAvisoForaDoHorario(triggerConfig);
    expect(doConfig).toBe(NOTICE);

    const { decisao, enviados } = await dispara({
      agora: FINADOS_10H,
      texto: doConfig,
      textoDeFeriado: null,
      cenario: { feriadoHoje: true },
    });

    expect(decisao).toEqual({ enviar: true, texto: NOTICE });
    expect(enviados).toHaveLength(1);
    // Byte a byte: mesmo comprimento, mesmo conteúdo — nada reescrito no feriado.
    expect(enviados[0]?.body).toBe(NOTICE);
    expect(enviados[0]?.body).toHaveLength(NOTICE.length);
  });

  it("dia útil com texto de feriado configurado: o feriado não vaza", async () => {
    const { enviados } = await dispara({
      agora: DIA_UTIL_20H,
      texto: NOTICE,
      textoDeFeriado: NOTICE_FERIADO,
      cenario: { feriadoHoje: false },
    });

    expect(enviados).toHaveLength(1);
    esperaCampo(enviados[0]?.body, "notice", NOTICE);
  });

  it("feriado + contato com opt-out: nada é enviado", async () => {
    const { decisao, enviados } = await dispara({
      agora: FINADOS_10H,
      texto: NOTICE,
      textoDeFeriado: NOTICE_FERIADO,
      cenario: { feriadoHoje: true, contato: { isBlocked: true } },
    });

    expect(decisao).toEqual({ enviar: false, motivo: "opt_out" });
    expect(enviados).toHaveLength(0);
  });

  it("feriado + titular anonimizado (LGPD): nada é enviado", async () => {
    const { decisao, enviados } = await dispara({
      agora: FINADOS_10H,
      texto: NOTICE,
      textoDeFeriado: NOTICE_FERIADO,
      cenario: { feriadoHoje: true, contato: { isAnonymized: true } },
    });

    expect(decisao).toEqual({ enviar: false, motivo: "titular_anonimizado" });
    expect(enviados).toHaveLength(0);
  });

  it("feriado + já avisado no período fechado: nada é enviado", async () => {
    const { decisao, enviados } = await dispara({
      agora: FINADOS_10H,
      texto: NOTICE,
      textoDeFeriado: NOTICE_FERIADO,
      cenario: { feriadoHoje: true, jaAvisado: true },
    });

    expect(decisao).toEqual({ enviar: false, motivo: "ja_avisado_no_periodo" });
    expect(enviados).toHaveLength(0);
  });

  it("feriado + pacing vetado: nada é enviado (o feriado não fura o anti-ban)", async () => {
    const { decisao, enviados } = await dispara({
      agora: FINADOS_10H,
      texto: NOTICE,
      textoDeFeriado: NOTICE_FERIADO,
      cenario: { feriadoHoje: true, pacing: { liberado: false, motivo: "cap_diario" } },
    });

    expect(decisao).toEqual({ enviar: false, motivo: "pacing:cap_diario" });
    expect(enviados).toHaveLength(0);
  });

  it("só o texto de feriado configurado: em dia útil não sai nada (sem texto de hoje)", async () => {
    const { decisao, enviados } = await dispara({
      agora: DIA_UTIL_20H,
      texto: null,
      textoDeFeriado: NOTICE_FERIADO,
      cenario: { feriadoHoje: false },
    });

    expect(decisao).toEqual({ enviar: false, motivo: "sem_configuracao" });
    expect(enviados).toHaveLength(0);
  });

  it("sem aviso configurado: nada é enviado, nem no feriado", async () => {
    const { decisao, enviados } = await dispara({
      agora: FINADOS_10H,
      texto: null,
      textoDeFeriado: null,
      cenario: { feriadoHoje: true },
    });

    expect(decisao.enviar).toBe(false);
    expect(enviados).toHaveLength(0);
  });
});

/**
 * A LEITURA da chave nova em `trigger_config` (jsonb livre) e a escolha do
 * texto. A chave é OPCIONAL: ausente, vazia, de outro tipo ou só espaços vale
 * `null` — e `null` significa "o aviso de hoje", nunca frase improvisada.
 */
describe("notice_feriado no trigger_config (#3877)", () => {
  const config = (bh: Record<string, unknown>) => ({ filters: { business_hours: bh } });

  it("lê a chave irmã do notice, e só ela", () => {
    const cfg = config({ ...JANELA, notice: NOTICE, notice_feriado: NOTICE_FERIADO });

    expect(lerTextoDoAvisoForaDoHorario(cfg)).toBe(NOTICE);
    expect(lerTextoDoAvisoDeFeriadoForaDoHorario(cfg)).toBe(NOTICE_FERIADO);
  });

  it("ausente, vazia, só espaços ou de outro tipo: null (nada inventado)", () => {
    expect(lerTextoDoAvisoDeFeriadoForaDoHorario(config({ ...JANELA, notice: NOTICE }))).toBeNull();
    expect(lerTextoDoAvisoDeFeriadoForaDoHorario(config({ ...JANELA, notice_feriado: "" }))).toBeNull();
    expect(lerTextoDoAvisoDeFeriadoForaDoHorario(config({ ...JANELA, notice_feriado: "   " }))).toBeNull();
    expect(lerTextoDoAvisoDeFeriadoForaDoHorario(config({ ...JANELA, notice_feriado: 42 }))).toBeNull();
    expect(lerTextoDoAvisoDeFeriadoForaDoHorario(null)).toBeNull();
  });

  it("respeita o mesmo teto de 1000 do notice", () => {
    const gigante = "x".repeat(TAMANHO_MAXIMO_DO_TEXTO + 500);
    const lido = lerTextoDoAvisoDeFeriadoForaDoHorario(config({ ...JANELA, notice_feriado: gigante }));

    expect(lido).toHaveLength(TAMANHO_MAXIMO_DO_TEXTO);
  });

  it("textoDoAvisoHoje escolhe pelo fato do dia, sem reescrever", () => {
    expect(textoDoAvisoHoje({ texto: NOTICE, textoDeFeriado: NOTICE_FERIADO, ehFeriadoNacional: true })).toBe(
      NOTICE_FERIADO,
    );
    expect(textoDoAvisoHoje({ texto: NOTICE, textoDeFeriado: NOTICE_FERIADO, ehFeriadoNacional: false })).toBe(NOTICE);
    expect(textoDoAvisoHoje({ texto: NOTICE, textoDeFeriado: null, ehFeriadoNacional: true })).toBe(NOTICE);
    expect(textoDoAvisoHoje({ texto: NOTICE, textoDeFeriado: "  ", ehFeriadoNacional: true })).toBe(NOTICE);
    expect(textoDoAvisoHoje({ texto: null, textoDeFeriado: NOTICE_FERIADO, ehFeriadoNacional: true })).toBe(
      NOTICE_FERIADO,
    );
  });
});
