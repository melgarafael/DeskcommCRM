import { describe, expect, it } from "vitest";

import {
  avaliarCanal,
  DIAS_ATE_AVISAR,
  emModoDeTeste,
  nomeDoCanal,
  numerosAutorizados,
  redeDoCanal,
  type CanalParaAvaliar,
} from "@/lib/channels/canal-mudo";

/**
 * A REGRA DO CANAL MUDO (doc 11, decisão B do dono).
 *
 * O canal em modo de teste sem número autorizado não responde a ninguém — e
 * esse é o estado que, esquecido, faz quem instalou concluir que o produto está
 * quebrado: as mensagens chegam, o Inbox enche, e a IA nunca fala.
 *
 * Os casos abaixo prendem as duas pontas: QUANDO avisar e QUANDO o aviso deixa
 * de valer sozinho. A segunda é a que costuma faltar — aviso que só some no
 * clique de alguém vira lista que ninguém lê.
 */

const AGORA = new Date("2026-09-19T12:00:00.000Z");
const haDias = (n: number): string =>
  new Date(AGORA.getTime() - n * 86_400_000).toISOString();

function canal(over: Partial<CanalParaAvaliar> = {}): CanalParaAvaliar {
  return {
    id: "canal-1",
    organization_id: "org-1",
    status: "WORKING",
    archived_at: null,
    last_status_change_at: haDias(DIAS_ATE_AVISAR + 1),
    metadata: { ai_gate: "allowlist", ai_test_phone_numbers: [] },
    tem_agente: true,
    ...over,
  };
}

describe("quando o canal mudo vira aviso", () => {
  it("ligado, em modo de teste, sem número e há dias: avisa", () => {
    const d = avaliarCanal(canal(), AGORA);
    expect(d.acao).toBe("avisar");
    expect(d.acao === "avisar" && d.diasMudo).toBe(DIAS_ATE_AVISAR + 1);
  });

  it("recém-ligado NÃO avisa — é o estado normal de quem está no wizard", () => {
    // Sem esta espera, o aviso chega no minuto em que a pessoa está montando a
    // instalação, que é exatamente quando ela não precisa dele.
    expect(avaliarCanal(canal({ last_status_change_at: haDias(0) }), AGORA).acao).toBe("aguardar");
    expect(
      avaliarCanal(canal({ last_status_change_at: haDias(DIAS_ATE_AVISAR - 1) }), AGORA).acao,
    ).toBe("aguardar");
  });

  it("no dia exato do limite já avisa", () => {
    expect(avaliarCanal(canal({ last_status_change_at: haDias(DIAS_ATE_AVISAR) }), AGORA).acao).toBe(
      "avisar",
    );
  });

  it("canal que não está WORKING não entra: quem avisa conexão caída é outro", () => {
    // Dois avisos para o mesmo silêncio seria a Central disputando com ela
    // mesma a atenção de quem lê. Parado, ele não responde de qualquer jeito.
    for (const status of ["STARTING", "SCAN_QR_CODE", "FAILED", "STOPPED", null]) {
      expect(avaliarCanal(canal({ status }), AGORA).acao, `status ${status}`).toBe("aguardar");
    }
  });

  it("sem data de mudança de situação, espera — não chuta a idade do silêncio", () => {
    expect(avaliarCanal(canal({ last_status_change_at: null }), AGORA).acao).toBe("aguardar");
    expect(avaliarCanal(canal({ last_status_change_at: "não é data" }), AGORA).acao).toBe(
      "aguardar",
    );
  });
});

describe("quando o aviso deixa de valer — o laço de retorno", () => {
  it("ganhou número autorizado: resolve", () => {
    const d = avaliarCanal(
      canal({ metadata: { ai_gate: "allowlist", ai_test_phone_numbers: ["+5511999990000"] } }),
      AGORA,
    );
    expect(d).toEqual({ acao: "resolver", motivo: "ganhou_numero" });
  });

  it("saiu do modo de teste (aberto ao público): resolve", () => {
    const d = avaliarCanal(canal({ metadata: { ai_gate: "open" } }), AGORA);
    expect(d).toEqual({ acao: "resolver", motivo: "saiu_do_modo_de_teste" });
  });

  it("canal arquivado: resolve — conexão aposentada não é problema aberto", () => {
    const d = avaliarCanal(canal({ archived_at: "2026-09-18T10:00:00.000Z" }), AGORA);
    expect(d).toEqual({ acao: "resolver", motivo: "canal_arquivado" });
  });

  it("resolver vence a espera: canal novo que JÁ tem número não fica pendente", () => {
    // A ordem importa. Se a checagem de tempo viesse antes, um canal que ganhou
    // número no primeiro dia continuaria com o aviso aberto até completar os
    // dias — e o aviso já não era verdade.
    const d = avaliarCanal(
      canal({
        last_status_change_at: haDias(0),
        metadata: { ai_gate: "allowlist", ai_test_phone_numbers: ["+5511999990000"] },
      }),
      AGORA,
    );
    expect(d).toEqual({ acao: "resolver", motivo: "ganhou_numero" });
  });
});

describe("leitura da metadata — o que o operador digitou pode chegar torto", () => {
  it("lista ausente, nula ou de outro tipo conta como nenhum número", () => {
    expect(numerosAutorizados(null)).toEqual([]);
    expect(numerosAutorizados({})).toEqual([]);
    expect(numerosAutorizados({ ai_test_phone_numbers: null })).toEqual([]);
    expect(numerosAutorizados({ ai_test_phone_numbers: "+5511999990000" })).toEqual([]);
  });

  it("entrada vazia dentro da lista não conta como número autorizado", () => {
    // Uma lista com `[""]` diz "tem número" para um `length > 0` ingênuo — e o
    // canal seguiria mudo sem aviso nenhum, que é o defeito inteiro.
    expect(numerosAutorizados({ ai_test_phone_numbers: ["", "   "] })).toEqual([]);
    expect(
      avaliarCanal(canal({ metadata: { ai_gate: "allowlist", ai_test_phone_numbers: [""] } }), AGORA)
        .acao,
    ).toBe("avisar");
  });

  it("o modo de teste é lido do `ai_gate`, como o runtime lê", () => {
    expect(emModoDeTeste({ ai_gate: "allowlist" })).toBe(true);
    expect(emModoDeTeste({ ai_gate: "open" })).toBe(false);
    expect(emModoDeTeste({ ai_gate_mode: "pre_go_live" })).toBe(false);
    expect(emModoDeTeste(null)).toBe(false);
  });
});

/**
 * QUAL DOS DOIS PROBLEMAS (#4909).
 *
 * O aviso antigo era o mesmo texto para os dois estados, e a saída que ele
 * oferecia — "abra o canal ao público" — só resolve um deles. Sem agente
 * publicado, abrir ao público deixa o canal exatamente tão mudo quanto estava.
 */
describe("o aviso distingue os dois casos", () => {
  it("canal COM agente atrás: o que falta é liberar um testador", () => {
    const d = avaliarCanal(canal({ tem_agente: true }), AGORA);
    expect(d).toMatchObject({ acao: "avisar", caso: "falta_testador" });
  });

  it("canal SEM agente publicado: o que falta é ligar/publicar o agente", () => {
    const d = avaliarCanal(canal({ tem_agente: false }), AGORA);
    expect(d).toMatchObject({ acao: "avisar", caso: "sem_agente" });
  });

  it("o caso não muda QUANDO avisa — a régua dos dias continua a mesma", () => {
    // Se o caso entrasse na conta do tempo, um canal sem agente passaria a
    // avisar em outra régua e o defeito viraria dois.
    const recente = canal({ tem_agente: false, last_status_change_at: haDias(DIAS_ATE_AVISAR - 1) });
    expect(avaliarCanal(recente, AGORA).acao).toBe("aguardar");
  });

  it("o caso não interfere nos dias mudos que o corpo do aviso informa", () => {
    // A decisão de responder NÃO muda com este aviso: só o texto e a saída.
    const d = avaliarCanal(canal({ tem_agente: false }), AGORA);
    expect(d.acao === "avisar" && d.diasMudo).toBe(DIAS_ATE_AVISAR + 1);
  });
});

describe("o nome e a rede do canal — o aviso diz QUAL canal", () => {
  it("o nome é o `display_name`, que é o que o operador vê em Conexões", () => {
    expect(nomeDoCanal(canal({ display_name: "  Instagram da loja  " }))).toBe(
      "Instagram da loja",
    );
  });

  it("sem nome, cai no número; sem número, no nome da sessão do transporte", () => {
    expect(nomeDoCanal(canal({ display_name: null, phone_number: "+55 11 90000-0000" }))).toBe(
      "+55 11 90000-0000",
    );
    expect(
      nomeDoCanal(canal({ display_name: "  ", phone_number: null, waha_session_name: "loja-1" })),
    ).toBe("loja-1");
  });

  it("canal sem nome nenhum devolve `null` — quem escreve escolhe a reserva", () => {
    expect(nomeDoCanal(canal({ display_name: null, phone_number: null }))).toBeNull();
  });

  it("a rede vem do TRANSPORTE traduzido — `zernio_social` pode ser Instagram ou Messenger", () => {
    expect(redeDoCanal(canal({ provider: "waha" }))).toBe("whatsapp");
    expect(redeDoCanal(canal({ provider: "meta_cloud" }))).toBe("whatsapp");
    expect(
      redeDoCanal(canal({ provider: "zernio_social", metadata: { social_platform: "instagram" } })),
    ).toBe("instagram");
    expect(
      redeDoCanal(canal({ provider: "zernio_social", metadata: { social_platform: "facebook" } })),
    ).toBe("messenger");
    expect(redeDoCanal(canal({ provider: "telegram" }))).toBe("telegram");
  });

  it("transporte desconhecido não vira palavra inventada — é `unknown`", () => {
    expect(redeDoCanal(canal({ provider: "zernio_social", metadata: {} }))).toBe("unknown");
    expect(redeDoCanal(canal({ provider: null }))).toBe("unknown");
  });
});
