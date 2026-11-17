/**
 * #4835 — A CARÊNCIA ANTES DO MODELO PAGO, com RELÓGIO CONTROLADO.
 *
 * O que se prova aqui, e o que NÃO se prova:
 *
 *  - a decisão e a leitura da janela, com `agora` injetado e `last_inbound_at`
 *    escrito à mão (nada de `sleep`: nenhum teste deste arquivo espera de
 *    verdade);
 *  - o par "lead chega fechado → espera" e "cliente escreve durante a espera →
 *    texto livre / passo dispensado", que é o ganho;
 *  - o caminho de hoje preservado: janela continua fechada na volta → modelo
 *    pago; carência 0 → modelo pago na primeira passada; passo que não é
 *    primeiro contato → modelo pago na primeira passada.
 *
 * O envio em si (o POST do modelo) é do turno — `runFlowDrivenTurn` mapeia
 * `texto_livre` para `passo = null` (o turno de IA responde) e `dispensar` para
 * um `skipped` com motivo. Aqui se prova a DECISÃO que esses dois ramos leem.
 */
import { describe, expect, it, vi } from "vitest";

import {
  CARENCIA_PADRAO_MS,
  carenciaDoAmbiente,
  decidirAntesDoModeloPago,
  jaEsperouPelaCarencia,
  lerJanelaDaConversa,
  rastroDaCarencia,
  type LeituraDaJanela,
} from "./carencia-antes-do-modelo";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "33333333-3333-4333-8333-333333333333";

/** O instante em que o lead chega (relógio do teste, nunca o de parede). */
const T0 = new Date("2026-11-17T12:00:00.000Z");
const emSegundos = (s: number): Date => new Date(T0.getTime() + s * 1_000);

function dbCom(linha: { provider?: string | null; ultimo_inbound: Date | null; ultima_saida?: Date | null }) {
  return {
    query: vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [
        {
          provider: linha.provider === undefined ? "meta_cloud" : linha.provider,
          last_inbound_at: linha.ultimo_inbound,
          last_outbound_at: linha.ultima_saida ?? null,
        },
      ],
    })),
  };
}

describe("lerJanelaDaConversa", () => {
  it("lead recém-chegado, nunca escreveu: janela fechada e PRIMEIRO contato", async () => {
    const db = dbCom({ ultimo_inbound: null });
    await expect(
      lerJanelaDaConversa(db as never, { organizationId: ORG, conversationId: CONVERSA, agora: T0 }),
    ).resolves.toEqual({ fechada: true, primeiroContato: true } satisfies LeituraDaJanela);
    // A consulta é escopada pela organização E pela conversa (nada de varredura).
    expect(db.query.mock.calls[0]?.[1]).toEqual([ORG, CONVERSA]);
  });

  it("conversa já saiu alguma vez: não é primeiro contato", async () => {
    const db = dbCom({ ultimo_inbound: null, ultima_saida: emSegundos(-3600) });
    await expect(
      lerJanelaDaConversa(db as never, { organizationId: ORG, conversationId: CONVERSA, agora: T0 }),
    ).resolves.toEqual({ fechada: true, primeiroContato: false });
  });

  it("cliente escreveu há 3 s: a janela está ABERTA na leitura", async () => {
    const db = dbCom({ ultimo_inbound: emSegundos(-3) });
    await expect(
      lerJanelaDaConversa(db as never, { organizationId: ORG, conversationId: CONVERSA, agora: T0 }),
    ).resolves.toEqual({ fechada: false, primeiroContato: true });
  });

  it("canal por QR (waha) não tem janela: nada a esperar", async () => {
    const db = dbCom({ provider: "waha", ultimo_inbound: null });
    await expect(
      lerJanelaDaConversa(db as never, { organizationId: ORG, conversationId: CONVERSA, agora: T0 }),
    ).resolves.toEqual({ fechada: false, primeiroContato: true });
  });

  it("conversa inexistente: sem leitura, sem carência (fail-open)", async () => {
    const db = { query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] })) };
    await expect(
      lerJanelaDaConversa(db as never, { organizationId: ORG, conversationId: CONVERSA, agora: T0 }),
    ).resolves.toBeNull();
  });
});

describe("decidirAntesDoModeloPago — a carência", () => {
  const fechadaPrimeiroContato: LeituraDaJanela = { fechada: true, primeiroContato: true };

  it("janela fechada + primeiro contato: espera N e não gasta nada", () => {
    const decisao = decidirAntesDoModeloPago({
      passoEhModeloPago: true,
      temTextoLivreNoLugar: true,
      carenciaMs: CARENCIA_PADRAO_MS,
      janela: fechadaPrimeiroContato,
      jaEsperou: false,
      agora: T0,
    });
    expect(decisao).toEqual({ acao: "esperar", esperaMs: 10_000, ate: emSegundos(10) });
  });

  it("CARÊNCIA 0 desliga: o modelo pago sai na primeira passada, como hoje", () => {
    expect(
      decidirAntesDoModeloPago({
        passoEhModeloPago: true,
        temTextoLivreNoLugar: true,
        carenciaMs: 0,
        janela: fechadaPrimeiroContato,
        jaEsperou: false,
        agora: T0,
      }),
    ).toEqual({ acao: "enviar" });
  });

  it("passo que NÃO é o primeiro contato não atrasa: modelo pago como hoje", () => {
    expect(
      decidirAntesDoModeloPago({
        passoEhModeloPago: true,
        temTextoLivreNoLugar: true,
        carenciaMs: CARENCIA_PADRAO_MS,
        janela: { fechada: true, primeiroContato: false },
        jaEsperou: false,
        agora: T0,
      }),
    ).toEqual({ acao: "enviar" });
  });

  it("passo que não é modelo pago nunca espera", () => {
    expect(
      decidirAntesDoModeloPago({
        passoEhModeloPago: false,
        temTextoLivreNoLugar: true,
        carenciaMs: CARENCIA_PADRAO_MS,
        janela: fechadaPrimeiroContato,
        jaEsperou: false,
        agora: T0,
      }),
    ).toEqual({ acao: "enviar" });
  });
});

describe("decidirAntesDoModeloPago — a reconferência na volta", () => {
  it("o cliente escreveu em 3 s: a reserva da IA devolve TEXTO LIVRE, nenhum modelo pago", () => {
    // Relógio controlado: o lead chegou em T0, o cliente escreveu em T0+3 s, o
    // job volta em T0+10 s. A leitura da volta é a mesma função do código.
    const janelaNaVolta: LeituraDaJanela = { fechada: false, primeiroContato: true };
    expect(
      decidirAntesDoModeloPago({
        passoEhModeloPago: true,
        temTextoLivreNoLugar: true,
        carenciaMs: CARENCIA_PADRAO_MS,
        janela: janelaNaVolta,
        jaEsperou: true,
        agora: emSegundos(10),
      }),
    ).toEqual({ acao: "texto_livre" });
  });

  it("passo de modelo puro com a janela aberta na volta: DISPENSA o passo (não tem texto livre a mandar)", () => {
    expect(
      decidirAntesDoModeloPago({
        passoEhModeloPago: true,
        temTextoLivreNoLugar: false,
        carenciaMs: CARENCIA_PADRAO_MS,
        janela: { fechada: false, primeiroContato: true },
        jaEsperou: true,
        agora: emSegundos(10),
      }),
    ).toMatchObject({ acao: "dispensar" });
  });

  it("janela CONTINUA fechada na volta: modelo pago sai como hoje", () => {
    expect(
      decidirAntesDoModeloPago({
        passoEhModeloPago: true,
        temTextoLivreNoLugar: true,
        carenciaMs: CARENCIA_PADRAO_MS,
        janela: { fechada: true, primeiroContato: true },
        jaEsperou: true,
        agora: emSegundos(10),
      }),
    ).toEqual({ acao: "enviar" });
  });

  it("a carência NÃO se repete: com o rastro no payload, a volta decide e conclui", () => {
    const rastro = rastroDaCarencia({ esperaMs: CARENCIA_PADRAO_MS, agora: T0 });
    expect(jaEsperouPelaCarencia(rastro)).toBe(true);
    // E o rastro sobrevive ao merge com o resto do payload do job.
    expect(jaEsperouPelaCarencia({ ...rastro, node_id: "n-1", fixed_body: "oi" })).toBe(true);
    expect(jaEsperouPelaCarencia({ node_id: "n-1" })).toBe(false);
    expect(jaEsperouPelaCarencia(null)).toBe(false);
  });
});

describe("carenciaDoAmbiente", () => {
  it("ausente ou inválido cai no padrão de 10 s; 0 desliga", () => {
    expect(carenciaDoAmbiente(undefined)).toBe(CARENCIA_PADRAO_MS);
    expect(carenciaDoAmbiente(null)).toBe(CARENCIA_PADRAO_MS);
    expect(carenciaDoAmbiente(Number.NaN)).toBe(CARENCIA_PADRAO_MS);
    expect(carenciaDoAmbiente(0)).toBe(0);
    expect(carenciaDoAmbiente(15_500)).toBe(15_500);
  });
});
