import { beforeEach, describe, expect, it, vi } from "vitest";

import { splitForSend } from "@/lib/agent-engine/agent/split-message";
import type { ChannelSendResult } from "@/lib/agent-engine/channel-adapter";
import { audit } from "@/lib/audit";
import { PALAVRAS_DE_OPT_OUT, ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";
import {
  comSaida,
  contemPalavraDeSaida,
  palavraDeSaida,
  problemaNoTextoDaSaidaNoIdioma,
  rodapeDeSaida,
  textoDaSaidaEfetivo,
} from "@/lib/prospecting/rodape-de-saida";
import { enviarComSaidaConfiguravel } from "@/lib/prospecting/saida-configuravel";
import { campaignConfigSchema } from "@/lib/prospecting/schema";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
const auditMock = vi.mocked(audit);

/**
 * A SAÍDA PERSONALIZADA NO BALÃO SEPARADO (#4370).
 *
 * O corpo do pedido entrou no #4416: o dono da campanha escreve o texto da
 * saída em `config.texto_da_saida`, e a palavra que `lib/opt-out/deteccao.ts`
 * reconhece sozinha continua obrigatória. O que faltava era o caminho em que a
 * resposta sai em VÁRIAS mensagens curtas ("Responder em várias mensagens
 * curtas" ligado, o mesmo estilo que dá o tom de conversa):
 *
 *   1. a saída é um parágrafo próprio, então ela vira a ÚLTIMA bolha — e quem
 *      decide "esta tentativa já ofereceu a saída?" no reprocesso lia a PRIMEIRA.
 *      Resultado medido: o texto personalizado sumia do retry enquanto
 *      `exit_offered_at` seguia dizendo que a saída tinha sido oferecida;
 *   2. `split_max_chars` aceita de 80 a 4000 e o texto do dono vai até 160: com
 *      teto menor que o rodapé, a frase é picada em duas bolhas e NENHUMA a
 *      contém inteira. O `strpos` que amarrava a reserva à mensagem da saída
 *      filtrava por isso, não achava nada, e o envio desfazia a própria reserva
 *      — a saída voltava a ser oferecida depois, possivelmente com outro texto.
 *
 * Os quatro casos do pedido estão nos blocos (1) a (4); os dois defeitos acima,
 * no (5) e no (6). A régua do texto é a do servidor (`...NoIdioma`), a mesma que
 * a tela e o `validateConfig` aplicam.
 */

const RAIZ_TEXTO = "Se não fizer sentido pra vocês, é só me avisar que eu não chamo mais.";
const TEXTO_DO_DONO = "Se não fizer sentido pra vocês, é só escrever PARAR que eu não chamo mais.";
const TEXTO_COM_SINONIMO = "Se não fizer sentido pra vocês, responda SAIR que eu não chamo mais.";
const TEXTO_ES = "Si no tiene sentido, escriba BAJA y no escribo más.";

const BASE = {
  agent_id: "00000000-0000-4000-8000-000000000001",
  channel_session_id: "00000000-0000-4000-8000-000000000002",
  pipeline_id: "00000000-0000-4000-8000-000000000003",
  stage_id: "00000000-0000-4000-8000-000000000004",
  qualified_stage_id: "00000000-0000-4000-8000-000000000005",
  instruction: "Apresente o site e pergunte se faz sentido para a clínica.",
  qualification: "Confirmar se quem responde decide sobre o site.",
  legal_basis_ref: "LIA-2026-11",
};

/** O problema relatado pelo schema para o campo `texto_da_saida`, se houver. */
function recusaDoCampo(texto: string) {
  const r = campaignConfigSchema.safeParse({ ...BASE, texto_da_saida: texto });
  if (r.success) return undefined;
  return r.error.issues.find((i) => i.path.join(".") === "texto_da_saida");
}

describe("(1) texto do dono COM a palavra: aceito, e é ele que sai", () => {
  it("passa nas duas réguas e chega ao schema como foi escrito", () => {
    expect(problemaNoTextoDaSaidaNoIdioma(TEXTO_DO_DONO, "pt-BR")).toBeNull();
    expect(recusaDoCampo(TEXTO_DO_DONO)).toBeUndefined();
    const r = campaignConfigSchema.safeParse({ ...BASE, texto_da_saida: TEXTO_DO_DONO });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
    expect(r.success ? r.data.texto_da_saida : null).toBe(TEXTO_DO_DONO);
  });

  it("sai na abordagem no lugar da frase padrão, e não junto dela", () => {
    const corpo = comSaida("Oi! Vi a clínica de vocês no mapa.", "pt-BR", TEXTO_DO_DONO);
    expect(corpo).toBe(`Oi! Vi a clínica de vocês no mapa.\n\n${TEXTO_DO_DONO}`);
    expect(corpo.includes(rodapeDeSaida("pt-BR"))).toBe(false);
    // O texto efetivo é o dele: é ele que vai para a bolha, para a amarração da
    // reserva ($4 do `SQL_AMARRAR_RESERVA_A_MENSAGEM`) e para a prévia da tela.
    expect(textoDaSaidaEfetivo(TEXTO_DO_DONO, "pt-BR")).toBe(TEXTO_DO_DONO);
  });

  it("vale para o espanhol, com a palavra que a instalação de lá oferece", () => {
    expect(problemaNoTextoDaSaidaNoIdioma(TEXTO_ES, "es-AR")).toBeNull();
    expect(recusaDoCampo(TEXTO_ES)).toBeUndefined();
    expect(comSaida("Hola", "es-AR", TEXTO_ES)).toBe(`Hola\n\n${TEXTO_ES}`);
  });
});

describe("(2) texto SEM a palavra: recusado ao salvar", () => {
  it("a recusa é do campo, com mensagem própria (não 'chave desconhecida')", () => {
    expect(problemaNoTextoDaSaidaNoIdioma(RAIZ_TEXTO, "pt-BR")).toBe("sem_palavra");
    const recusa = recusaDoCampo(RAIZ_TEXTO);
    expect(recusa, "texto sem a palavra passou na validação do schema").toBeDefined();
    expect(recusa!.message).toMatch(/palavra/);
  });

  it("gravado por fora (idioma da organização mudou depois), o envio cai na frase padrão", () => {
    // O texto é válido em pt e inválido numa instalação em espanhol: em vez de
    // prometer PARAR para quem responde BAJA, sai a frase de sempre.
    expect(textoDaSaidaEfetivo(TEXTO_DO_DONO, "es-AR")).toBe(rodapeDeSaida("es-AR"));
  });
});

describe("(3) texto que TROCA a palavra por sinônimo: recusado", () => {
  it.each([
    ["SAIR (que o detector até reconhece sozinho)", TEXTO_COM_SINONIMO],
    ["DESCADASTRAR", "Se não fizer sentido, responda DESCADASTRAR que eu não chamo mais."],
    ["CANCELAR", "Se não fizer sentido, responda CANCELAR que eu não chamo mais."],
    ["«me avisar»", RAIZ_TEXTO],
  ])("%s não passa: a saída promete UMA palavra por idioma", (_nome, texto) => {
    expect(problemaNoTextoDaSaidaNoIdioma(texto, "pt-BR")).toBe("sem_palavra");
    expect(recusaDoCampo(texto), `"${texto}" foi aceito`).toBeDefined();
  });

  it("SAIR sozinho bloquearia o contato, mas não é o que o rodapé promete", () => {
    // O contraste que justifica a régua não ser `PALAVRAS_DE_OPT_OUT`: o
    // detector aceita SAIR; o rodapé desta instalação pede PARAR. Um texto que
    // instrui SAIR funciona por acidente hoje e quebra se o conjunto mudar.
    expect(ehPedidoDeOptOut("SAIR")).toBe(true);
    expect(contemPalavraDeSaida("responda SAIR", "pt-BR")).toBe(false);
    expect(contemPalavraDeSaida(TEXTO_DO_DONO, "pt-BR")).toBe(true);
  });
});

describe("(4) o detector continua reconhecendo a resposta do cliente", () => {
  it.each([
    ["pt-BR", "PARAR"],
    ["es-AR", "BAJA"],
    ["en-US", "STOP"],
  ])("%s: a palavra do rodapé é a que o detector aceita sozinha", (locale, palavra) => {
    expect(palavraDeSaida(locale)).toBe(palavra);
    expect(PALAVRAS_DE_OPT_OUT.has(palavra.toLowerCase())).toBe(true);
    // Caixa e pontuação não importam — é assim que a pessoa digita no celular.
    for (const resposta of [palavra, palavra.toLowerCase(), `${palavra}.`, ` ${palavra}! `])
      expect(ehPedidoDeOptOut(resposta), `"${resposta}" não foi reconhecida`).toBe(true);
  });

  it("a resposta chega depois de um rodapé personalizado: a palavra está lá, legível", () => {
    // A garantia que fecha o laço: o texto aceito contém EXATAMENTE a palavra
    // que o detector reconhece — o cliente copia o que lê e é reconhecido.
    const texto = TEXTO_DO_DONO;
    expect(contemPalavraDeSaida(texto, "pt-BR")).toBe(true);
    expect(ehPedidoDeOptOut(palavraDeSaida("pt-BR"))).toBe(true);
  });

  it("a palavra solta no meio de uma frase continua NÃO sendo opt-out", () => {
    // O rodapé não pode ensinar a pessoa a escrever algo que o detector ignora
    // por segurança: "pode parar, obrigado" não bloqueia (é o que separa de
    // "tem como parar a dor?").
    expect(ehPedidoDeOptOut("pode parar, obrigado")).toBe(false);
  });
});

describe("(5) o balão separado: a saída sai INTEIRA, uma vez", () => {
  const corpo = comSaida(
    "Oi! Somos a Acme.\n\nPodemos te mostrar o serviço?",
    "pt-BR",
    TEXTO_DO_DONO,
  );

  it("com o teto padrão (600), a saída é a última bolha e aparece uma vez só", () => {
    const bolhas = splitForSend(corpo, true, 600, 3);
    expect(bolhas.length).toBeGreaterThan(1);
    expect(bolhas.at(-1)).toBe(TEXTO_DO_DONO);
    expect(bolhas.filter((b) => b.includes("PARAR"))).toHaveLength(1);
    // Nada se perde e nada duplica: a concatenação é o corpo que a campanha mandou.
    expect(bolhas.join("\n\n")).toBe(corpo);
  });

  it("com teto menor que o rodapé (o mínimo aceito é 80), a frase é picada — e nada se perde", () => {
    // Fato medido, e a razão do conserto do (6): a instrução fica partida em
    // duas mensagens físicas, e nenhuma delas contém a frase inteira.
    const TEXTO_LONGO =
      "Se não fizer sentido pra vocês agora, é só escrever PARAR aqui nesta conversa que eu não chamo mais ninguém desta clínica, combinado?";
    expect(TEXTO_LONGO.length).toBeGreaterThan(80);
    expect(problemaNoTextoDaSaidaNoIdioma(TEXTO_LONGO, "pt-BR")).toBeNull();
    const bolhas = splitForSend(comSaida("Oi!", "pt-BR", TEXTO_LONGO), true, 80, 5);
    expect(bolhas.some((b) => b.includes(TEXTO_LONGO))).toBe(false);
    expect(bolhas.join(" ")).toContain(TEXTO_LONGO);
    // E a palavra não some: quem responde o que leu continua reconhecido.
    expect(bolhas.join(" ")).toMatch(/\bPARAR\b/u);
  });
});

const MSG = { jobId: "job-1", seq: 1 };
const AGORA = "2026-11-11T13:00:00.000000Z";

/** db falso com respostas por trecho de SQL; a ORDEM decide o casamento. */
function dbFalso(respostas: ReadonlyArray<readonly [string, unknown[]]>) {
  const sqls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    sqls.push({ sql, params: [...params] });
    const achou = respostas.find(([trecho]) => sql.includes(trecho));
    return { rows: achou ? achou[1] : [] };
  });
  return { query, sqls };
}

describe("(6) reprocesso e reserva no envio fatiado em bolhas", () => {
  beforeEach(() => auditMock.mockClear());

  const envioOk = async (_corpo: string): Promise<ChannelSendResult> => ({
    kind: "sent",
    idempotencyKey: "k",
    messageId: "m",
  });

  it("o reprocesso lê o envio INTEIRO, não a 1ª bolha, e repete o texto do dono", async () => {
    // O que o banco guardou: a resposta em duas bolhas, com a saída na última.
    const guardado = `Oi! Somos a Acme.\n\nPodemos te mostrar o serviço? ${TEXTO_DO_DONO}`;
    const { query, sqls } = dbFalso([
      ["string_agg", [{ body: guardado, locale: "pt-BR", texto_da_saida: TEXTO_DO_DONO }]],
    ]);
    const enviar = vi.fn(envioOk);

    await enviarComSaidaConfiguravel(
      {
        db: { query } as never,
        organizationId: "org-a",
        conversationId: "conv-1",
        via: "followup",
        mensagem: MSG,
        avisar: vi.fn(),
      },
      "Oi! Somos a Acme.\n\nPodemos te mostrar o serviço?",
      enviar,
    );

    // A decisão cobre as bolhas do MESMO envio, na ordem. A fronteira é o
    // `envio_seq` gravado na escrita (#4370, migration 9406): o `seq` é o
    // contador do TURNO e, sozinho, atravessa o envio seguinte — foi assim que
    // o mantenedor mediu os cenários B e C. O caso de dois envios no mesmo job
    // está no invariante `reprocesso-da-saida-le-so-o-envio.test.ts`.
    const consulta = sqls.find(({ sql }) => sql.includes("string_agg"));
    expect(consulta, "a decisão ainda lê uma mensagem física só").toBeDefined();
    expect(consulta!.sql).toContain("l2.envio_seq = $3");
    expect(consulta!.sql).toContain("order by l2.seq");
    // Linha gravada ANTES da 9406 não tem a marca: cai na régua anterior.
    expect(consulta!.sql).toContain("l2.envio_seq is null and l2.seq >= $3");

    // E o corpo desta tentativa volta a ter a saída personalizada.
    expect(String(enviar.mock.calls[0]?.[0])).toBe(
      `Oi! Somos a Acme.\n\nPodemos te mostrar o serviço?\n\n${TEXTO_DO_DONO}`,
    );
    // Reprocesso não conta de novo (uma consulta só) nem audita.
    expect(query).toHaveBeenCalledTimes(1);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("envio guardado SEM a saída continua sem ela: o reprocesso não inventa rodapé", async () => {
    const { query } = dbFalso([
      [
        "string_agg",
        [{ body: "Oi! Somos a Acme.", locale: "pt-BR", texto_da_saida: TEXTO_DO_DONO }],
      ],
    ]);
    const enviar = vi.fn(envioOk);
    await enviarComSaidaConfiguravel(
      {
        db: { query } as never,
        organizationId: "org-a",
        conversationId: "conv-1",
        via: "followup",
        mensagem: MSG,
        avisar: vi.fn(),
      },
      "Oi! Somos a Acme.",
      enviar,
    );
    expect(String(enviar.mock.calls[0]?.[0])).toBe("Oi! Somos a Acme.");
  });

  it("a reserva amarra na bolha que leva a saída — e, picada, na última", async () => {
    const { query, sqls } = dbFalso([
      ["exit_offer_message_id", [{ id: "msg-saida" }]],
      [
        "returning p.id as candidato_id",
        [
          {
            candidato_id: "cand-1",
            campanha_id: "camp-1",
            exit_offered_at: AGORA,
            leva_a_saida: true,
            numero_da_mensagem: 2,
            locale: "pt-BR",
            reservada_em_texto: AGORA,
            texto_da_saida: TEXTO_DO_DONO,
          },
        ],
      ],
    ]);
    const enviar = vi.fn(envioOk);

    await enviarComSaidaConfiguravel(
      {
        db: { query } as never,
        organizationId: "org-a",
        conversationId: "conv-1",
        via: "inbound_turn",
        mensagem: MSG,
        avisar: vi.fn(),
      },
      "Podemos te mostrar o serviço?",
      enviar,
    );

    const amarrar = sqls.find(({ sql }) => sql.includes("exit_offer_message_id = alvo.id"));
    expect(amarrar, "o envio que reserva tem de amarrar a saída à mensagem").toBeDefined();
    // `strpos` ORDENA: havendo uma bolha com a frase inteira, é ela; sem
    // nenhuma (rodapé picado pelo teto de caracteres), a última — antes o
    // filtro deixava o `alvo` vazio e a reserva era desfeita na hora.
    expect(amarrar!.sql).toContain("order by (strpos(");
    expect(amarrar!.sql).not.toMatch(/and strpos\(/);
    // E o texto amarrado é o do DONO, não a frase padrão.
    expect(amarrar!.params[3]).toBe(TEXTO_DO_DONO);

    // A reserva ficou: nada foi desfeito.
    expect(
      sqls.some(({ sql }) => sql.includes("greatest(automatic_sends - 1, 0)")),
      "a reserva foi desfeita mesmo com a saída amarrada",
    ).toBe(false);
  });
});
