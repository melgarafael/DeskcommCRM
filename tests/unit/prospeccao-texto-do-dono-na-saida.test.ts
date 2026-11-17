import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import type { ChannelSendResult } from "@/lib/agent-engine/channel-adapter";
import { audit } from "@/lib/audit";
import { campaignConfigSchema } from "@/lib/prospecting/schema";
import { ProspectingError } from "@/lib/prospecting/provider";
import { activateCampaign, validateConfig } from "@/lib/prospecting/store";
import { ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  comSaida,
  palavraDeSaida,
  problemaNoTextoDaSaida,
  problemaNoTextoDaSaidaNoIdioma,
  rodapeDeSaida,
  TAMANHO_MAXIMO_DO_TEXTO_DA_SAIDA,
  temSaida,
  textoDaSaidaEfetivo,
} from "@/lib/prospecting/rodape-de-saida";
import { enviarComSaidaConfiguravel } from "@/lib/prospecting/saida-configuravel";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
// O `store.ts` (o SALVAR e o `validateConfig`) puxa estes módulos; os dublês são
// os mesmos do teste de ativação (`prospeccao-arquivar-campanha.test.ts`), que já
// prova que `validateConfig` passa com eles.
vi.mock("@/lib/atendimento/origem", () => ({
  assertServiceBoundarySupabase: vi.fn(),
  beginServiceAtOrigin: vi.fn(),
}));
vi.mock("@/lib/agent-engine/agent/router-config", () => ({ loadActiveRouter: async () => null }));
vi.mock("@/lib/agent-engine/agent/agent-config", () => ({
  loadPublishedAgentConfig: async () => ({ agentId: "00000000-0000-4000-8000-000000000001" }),
}));
const auditMock = vi.mocked(audit);

/** O que o `audit` recebeu — o dublê não infere os parâmetros da função real. */
type RegistroAuditado = { action: string; metadata: Record<string, unknown> };
function registroAuditado(indice: number): RegistroAuditado | undefined {
  return (auditMock.mock.calls as unknown as Array<[RegistroAuditado]>)[indice]?.[0];
}

/**
 * O TEXTO DA SAÍDA É DO DONO DA CAMPANHA — E CONTINUA DETERMINÍSTICO (#4370).
 *
 * ## O pedido, medido no código de hoje
 *
 * A frase de saída era fixa (`rodapeDeSaida`): quem monta campanha em tom de
 * conversa via uma frase com cara de disparo em massa no fim da abordagem. O
 * dono passa a poder escrever o texto dele em `config.texto_da_saida`, e as
 * quatro garantias do rodapé continuam valendo:
 *
 *   1. o texto vem da CONFIGURAÇÃO, nunca do modelo — mesma redação em todos os
 *      envios, auditável;
 *   2. contém a palavra que `lib/opt-out/deteccao.ts` reconhece (PARAR em
 *      pt-BR, BAJA em espanhol) — sem ela a tela RECUSA, porque "é só me
 *      avisar" não é detectado e a pessoa pediria para sair sem sair;
 *   3. vazio = a frase padrão de hoje, BYTE POR BYTE (quem não mexer não vê
 *      diferença);
 *   4. a reserva da saída (`exit_offered_at`) acontece no MESMO envio de antes —
 *      o que muda é a redação, não a garantia de que a saída existe.
 *
 * O controle positivo está aqui de propósito: (3) é o comportamento antigo que
 * NÃO pode mudar. Um teste que só olhasse o texto novo passaria com o padrão
 * quebrado.
 */

const RAIZ = path.resolve(__dirname, "../..");

/** A frase de hoje, escrita por extenso: é o contrato do item 3. */
const PADRAO_PT = "Se não quiser mais receber mensagens, responda PARAR.";
const PADRAO_ES = "Si no quieres recibir más mensajes, responde BAJA.";
const PADRAO_EN = "If you'd rather not receive these messages, reply STOP.";

/** Exemplo do próprio issue — a redação que o autor quer poder usar. */
const TEXTO_DO_DONO = "Se não fizer sentido pra vocês, é só escrever PARAR que eu não chamo mais.";

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

const ORG = "00000000-0000-4000-8000-0000000000a1";
const CAMPANHA = "00000000-0000-4000-8000-0000000000a2";

/**
 * O banco mínimo do SALVAR (`activateCampaign`) e de `validateConfig`, com as
 * mesmas respostas do teste de ativação. A régua do texto roda ANTES de
 * qualquer `update`, então uma recusa tem de deixar `escritas` vazio.
 */
function bancoDoSalvar(locale: string | null = null) {
  const escritas: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/^(update|insert|delete)/i.test(sql)) escritas.push({ sql, params });
    const rows = (() => {
      if (sql.includes("pg_try_advisory_lock")) return [{ locked: true }];
      if (sql.includes("select locale from organizations")) return [{ locale }];
      if (sql.includes("from ai_agents a join ai_agent_versions"))
        return [{ tool_ids: ["crm_move_lead_stage"], pipeline_ids: [BASE.pipeline_id] }];
      if (sql.includes("from channel_sessions")) return [{ provider: "waha", status: "WORKING" }];
      if (sql.includes("from crm_stages"))
        return [{ id: BASE.stage_id }, { id: BASE.qualified_stage_id }];
      if (sql.startsWith("select * from prospecting_campaigns"))
        return [
          {
            id: CAMPANHA,
            name: "Clinica",
            status: "draft",
            search_status: "succeeded",
            config: null,
          },
        ];
      return [];
    })();
    return { rows, rowCount: rows.length };
  });
  const pool = { connect: async () => ({ query, release: vi.fn() }) };
  return { pool: pool as never, db: { query } as never, escritas };
}

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

describe("(3) campanha sem texto próprio: a frase de hoje, byte por byte", () => {
  it("o rodapé padrão não mudou em nenhum idioma", () => {
    // Controle positivo: se alguém "melhorar" a frase padrão, este teste cai.
    expect(rodapeDeSaida("pt-BR")).toBe(PADRAO_PT);
    expect(rodapeDeSaida("es-AR")).toBe(PADRAO_ES);
    expect(rodapeDeSaida("en-US")).toBe(PADRAO_EN);
    expect(rodapeDeSaida(null)).toBe(PADRAO_PT);
  });

  it("vazio, ausente ou só espaço = a MESMA frase, no mesmo lugar do corpo", () => {
    const esperado = `Oi, tudo bem?\n\n${PADRAO_PT}`;
    expect(comSaida("Oi, tudo bem?", "pt-BR", "")).toBe(esperado);
    expect(comSaida("Oi, tudo bem?", "pt-BR", undefined)).toBe(esperado);
    expect(comSaida("Oi, tudo bem?", "pt-BR", "   ")).toBe(esperado);
    // Assinatura antiga (dois argumentos) continua idêntica: é ela que o worker
    // e o `saida-configuravel.ts` chamam hoje.
    expect(comSaida("Oi, tudo bem?", "pt-BR")).toBe(esperado);
  });
});

describe("(1) e (2) campanha com texto do dono: sai o dele, e só se contiver a palavra", () => {
  it("o texto do dono SUBSTITUI a frase padrão — não soma a ela", () => {
    const corpo = comSaida("Oi! Vi a clínica de vocês no mapa.", "pt-BR", TEXTO_DO_DONO);
    expect(corpo).toBe(`Oi! Vi a clínica de vocês no mapa.\n\n${TEXTO_DO_DONO}`);
    expect(
      corpo.includes(PADRAO_PT),
      "a frase padrão continuou saindo junto do texto do dono — a saída virou duas frases",
    ).toBe(false);
  });

  it("não duplica quando o corpo já termina com o texto do dono", () => {
    const uma = comSaida("Bom dia.", "pt-BR", TEXTO_DO_DONO);
    expect(temSaida(uma, "pt-BR", TEXTO_DO_DONO)).toBe(true);
    expect(comSaida(uma, "pt-BR", TEXTO_DO_DONO)).toBe(uma);
  });

  it("texto sem a palavra de opt-out é RECUSADO na validação do schema", () => {
    const recusado = campaignConfigSchema.safeParse({
      ...BASE,
      texto_da_saida: "Se não fizer sentido, é só me avisar que eu não chamo mais.",
    });
    expect(recusado.success, "texto sem PARAR passou na validação").toBe(false);
    const recusa = recusado.success
      ? undefined
      : recusado.error.issues.find((i) => i.path.join(".") === "texto_da_saida");
    expect(
      recusa,
      "a recusa tem de ser DO CAMPO `texto_da_saida`, e não um 'chave desconhecida'",
    ).toBeDefined();
  });

  it("texto com a palavra passa na validação e chega ao schema como veio", () => {
    const ok = campaignConfigSchema.safeParse({ ...BASE, texto_da_saida: TEXTO_DO_DONO });
    expect(ok.success, ok.success ? "" : JSON.stringify(ok.error.issues)).toBe(true);
    expect(ok.success ? ok.data.texto_da_saida : null).toBe(TEXTO_DO_DONO);
  });
});

describe("(2) a palavra exigida é a do IDIOMA da instalação", () => {
  it("a régua do servidor e da tela recusa a palavra de OUTRO idioma", () => {
    expect(problemaNoTextoDaSaidaNoIdioma(TEXTO_DO_DONO, "pt-BR")).toBeNull();
    expect(
      problemaNoTextoDaSaidaNoIdioma("Si no tiene sentido, escriba BAJA y no escribo más.", "es-AR"),
    ).toBeNull();
    // PARAR numa instalação em espanhol: o schema genérico deixaria passar, e a
    // plantilla dali pede BAJA. A régua do idioma é que fecha isso.
    expect(problemaNoTextoDaSaidaNoIdioma(TEXTO_DO_DONO, "es-AR")).toBe("sem_palavra");
  });

  it("texto de outro idioma gravado por fora cai no padrão do idioma — nunca promete palavra morta", () => {
    expect(textoDaSaidaEfetivo(TEXTO_DO_DONO, "es-AR")).toBe(PADRAO_ES);
    expect(textoDaSaidaEfetivo(TEXTO_DO_DONO, "pt-BR")).toBe(TEXTO_DO_DONO);
    expect(comSaida("Hola", "es-AR", TEXTO_DO_DONO)).toBe(`Hola\n\n${PADRAO_ES}`);
  });

  it("texto que TROCA a palavra por sinônimo é recusado — o sinônimo não é resposta de saída", () => {
    // O pedido é explícito: a PALAVRA reconhecida continua no texto; escrever em
    // volta é livre, substituí-la por um sinônimo não. Estes três são os
    // sinônimos que alguém escreveria de boa-fé — e nenhum deles descadastra:
    // `cancelar` sozinho saiu do detector no #4579 (é resposta de menu), e
    // "chega"/"que não" nunca estiveram lá.
    for (const texto of [
      "Se não quiser mais, responda CANCELAR.",
      "Se não fizer sentido, é só escrever CHEGA.",
      "Se não quiser mais, é só responder que não.",
    ]) {
      expect(
        problemaNoTextoDaSaidaNoIdioma(texto, "pt-BR"),
        `sinônimo aceito no lugar da palavra: ${texto}`,
      ).toBe("sem_palavra");
      // E a recusa acontece AO SALVAR: o schema tem de barrar o texto, no campo.
      const recusado = campaignConfigSchema.safeParse({ ...BASE, texto_da_saida: texto });
      expect(recusado.success, `o schema aceitou um sinônimo: ${texto}`).toBe(false);
      const recusa = recusado.success
        ? undefined
        : recusado.error.issues.find((i) => i.path.join(".") === "texto_da_saida");
      expect(recusa, `a recusa não é do campo texto_da_saida: ${texto}`).toBeDefined();
    }
    // Por que a recusa é a certa: nenhuma dessas respostas é pedido de saída. Se
    // o rodapé ensinasse uma delas, a pessoa responderia e seguiria recebendo.
    expect(ehPedidoDeOptOut("CANCELAR")).toBe(false);
    expect(ehPedidoDeOptOut("CHEGA")).toBe(false);
    expect(ehPedidoDeOptOut("que não")).toBe(false);
    // `SAIR` é o caso de borda: o detector o reconhece SOZINHO (está em
    // `PALAVRAS_DE_OPT_OUT`), mas ele não é a palavra que este idioma promete —
    // a régua exige a do idioma da instalação (PARAR em pt, BAJA em es, STOP em
    // en), para a campanha não ensinar duas saídas diferentes na mesma operação.
    expect(ehPedidoDeOptOut("SAIR")).toBe(true);
    expect(problemaNoTextoDaSaidaNoIdioma("Se não quiser mais, responda SAIR.", "pt-BR")).toBe(
      "sem_palavra",
    );
  });

  it("tamanho e link, sem palavra, e vazio como válido", () => {
    expect(problemaNoTextoDaSaida("Se não fizer sentido, é só me avisar.")).toBe("sem_palavra");
    expect(
      problemaNoTextoDaSaida(`Responda PARAR que eu não chamo mais. ${"a".repeat(TAMANHO_MAXIMO_DO_TEXTO_DA_SAIDA)}`),
    ).toBe("longo");
    expect(problemaNoTextoDaSaida("Para sair, escreva PARAR em https://exemplo.com/sair")).toBe(
      "link",
    );
    // Vazio é o contrato do item 3: significa "usa a frase padrão".
    expect(problemaNoTextoDaSaida("")).toBeNull();
    expect(problemaNoTextoDaSaida("   ")).toBeNull();
    expect(problemaNoTextoDaSaida(undefined)).toBeNull();
  });
});

describe("(4) a reserva da saída continua acontecendo no MESMO envio de antes", () => {
  beforeEach(() => {
    auditMock.mockClear();
  });

  const AGORA = "2026-11-11T13:00:00.000000Z";

  function contagem(extra: Record<string, unknown> = {}) {
    return [
      ["exit_offer_message_id", [{ id: "msg-1" }]],
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
            ...extra,
          },
        ],
      ],
    ] as ReadonlyArray<readonly [string, unknown[]]>;
  }

  it("quem reserva leva o texto do dono, e a reserva fica amarrada a ESTA mensagem", async () => {
    const { query, sqls } = dbFalso(contagem({ texto_da_saida: TEXTO_DO_DONO }));
    const enviar = vi.fn(async (_corpo: string): Promise<ChannelSendResult> => ({
      kind: "sent",
      idempotencyKey: "k",
      messageId: "m",
    }));

    await enviarComSaidaConfiguravel(
      {
        db: { query } as never,
        organizationId: "org-a",
        conversationId: "conv-1",
        via: "inbound_turn",
        mensagem: { jobId: "job-1", seq: 1 },
        avisar: vi.fn(),
      },
      "só cumprimento",
      enviar,
    );

    // O corpo que o canal transmite tem o texto do dono.
    expect(enviar.mock.calls[0]?.[0]).toContain(TEXTO_DO_DONO);

    // A reserva é amarrada à mensagem que leva ESSE texto ($4): com o padrão no
    // lugar, o `strpos` não acharia a saída e o envio seria desfeito — a saída
    // voltaria a ser oferecida e o texto do dono sumiria do caminho.
    const amarrar = sqls.find(({ sql }) => sql.includes("exit_offer_message_id = alvo.id"));
    expect(amarrar, "o envio que reserva tem de amarrar a saída à mensagem").toBeDefined();
    expect(amarrar!.params[3]).toBe(TEXTO_DO_DONO);

    // O contador continua sendo o mesmo: texto próprio não mudou QUEM reserva.
    const contar = sqls.find(({ sql }) => sql.includes("automatic_sends = p.automatic_sends + 1"));
    expect(contar, "a contagem atômica da saída continua no caminho").toBeDefined();
    expect(contar!.sql).toContain("p.exit_offered_at is null");
    expect(contar!.sql).toContain("c.config->>'exit_offer' = 'second_message'");

    // Nada foi desfeito, e a auditoria registra que o texto era do dono.
    expect(
      sqls.some(({ sql }) => sql.includes("greatest(automatic_sends - 1, 0)")),
      "a reserva foi desfeita mesmo com a mensagem enviada",
    ).toBe(false);
    expect(auditMock).toHaveBeenCalledTimes(1);
    const registro = registroAuditado(0);
    expect(registro, "a saída oferecida tem de continuar auditada").toBeDefined();
    expect(registro!.action).toBe("prospecting.exit_offered");
    expect(registro!.metadata).toMatchObject({
      message_number: 2,
      texto_personalizado: true,
    });
  });

  it("sem texto próprio, o mesmo envio audita texto_personalizado=false", async () => {
    const { query } = dbFalso(contagem({ texto_da_saida: null }));
    const enviar = vi.fn(async (_corpo: string): Promise<ChannelSendResult> => ({
      kind: "sent",
      idempotencyKey: "k",
      messageId: "m",
    }));
    await enviarComSaidaConfiguravel(
      {
        db: { query } as never,
        organizationId: "org-a",
        conversationId: "conv-1",
        via: "inbound_turn",
        mensagem: { jobId: "job-1", seq: 1 },
        avisar: vi.fn(),
      },
      "só cumprimento",
      enviar,
    );
    expect(enviar.mock.calls[0]?.[0]).toBe(`só cumprimento\n\n${PADRAO_PT}`);
    const registro = registroAuditado(0);
    expect(registro, "a saída padrão também é auditada").toBeDefined();
    expect(registro!.metadata).toMatchObject({ texto_personalizado: false });
  });
});

describe("o caminho de envio lê o texto da CAMPANHA, não o do modelo", () => {
  it("o worker passa `cfg.texto_da_saida` para o `comSaida` da 1ª bolha", () => {
    const worker = fs.readFileSync(path.join(RAIZ, "lib/prospecting/worker.ts"), "utf8");
    expect(
      worker,
      "o modo `first_message` não usa o texto configurado da campanha",
    ).toMatch(/comSaida\([^)]*cfg\.texto_da_saida/);
    expect(worker).not.toMatch(/generated\.texto\s*\+\s*["'`]/);
  });
});

/**
 * ─── (5) A PALAVRA QUE ESTÁ LÁ E NÃO SE LÊ (#4370) ──────────────────────────
 *
 * O pedido diz "a PALAVRA continua presente", e o defeito que sobrava passa por
 * aqui: `~PARAR~` TEM a palavra e o schema aceitava. No aparelho, `~x~` é
 * riscado no WhatsApp, `||x||` é spoiler e crases viram código — a campanha
 * inicia e a instrução manda responder algo que o cliente desenha como
 * APAGADO. É a mesma família de erro que o rodapé existe para impedir (prometer
 * uma saída que não se consegue usar), só que pela FORMA.
 */
describe("(5) a palavra não pode ir escondida por formatação", () => {
  /** A régua que a tela e o servidor aplicam: o idioma é o da instalação. */
  const noIdioma = (texto: string) => problemaNoTextoDaSaidaNoIdioma(texto, "pt-BR");

  it("riscado, spoiler e código em cima da palavra são RECUSADOS ao salvar", () => {
    for (const texto of [
      "Se não quiser mais, responda ~PARAR~.",
      "Se não quiser mais, responda ~~PARAR~~.",
      "Se não quiser mais, responda ||PARAR||.",
      "Se não quiser mais, responda `PARAR`.",
      "Se não quiser mais, responda ```PARAR```.",
      // O til de "cerca de" ANTES do riscado de verdade: sem a borda de letra, o
      // padrão pareava o til solto com o que abre `~PARAR~` e deixava `PARAR~`
      // de fora do par — a palavra riscada passava como legível.
      "Custa ~R$ 50. Se não quiser mais, responda ~PARAR~.",
    ])
      expect(noIdioma(texto), `a palavra escondida passou: ${texto}`).toBe("palavra_escondida");
  });

  it("o schema NÃO recusa a palavra riscada — a recusa é do salvar (#4647, decisão (a))", () => {
    // A sonda do mantenedor: este é o MESMO parse que o envio faz a cada rodada
    // (`worker.ts`). Se ele lançar, o `ZodError` não é `ProspectingError` e a
    // campanha pausa com «Falha inesperada no envio» — o efeito que a decisão
    // (a) recusa. Aqui se mede o `parse` de verdade, não o olho.
    const config = { ...BASE, texto_da_saida: "Se não quiser mais, responda ~PARAR~." };
    let parsed: unknown = null;
    expect(
      () => {
        parsed = campaignConfigSchema.parse(config);
      },
      "o schema que o envio faz lançou para a campanha já salva",
    ).not.toThrow();
    expect(parsed).not.toBeNull();
    // E o texto que esse envio leva é a frase padrão do idioma: a palavra
    // riscada não sai (é ilegível no aparelho), mas a saída não some.
    expect(textoDaSaidaEfetivo(config.texto_da_saida, "pt-BR")).toBe(PADRAO_PT);
  });

  it("quem recusa a palavra riscada é o SALVAR — 422 com a frase que ensina o conserto", async () => {
    const { pool, escritas } = bancoDoSalvar();
    const erro = await activateCampaign(
      pool,
      {} as never,
      ORG,
      CAMPANHA,
      campaignConfigSchema.parse({
        ...BASE,
        texto_da_saida: "Se não quiser mais, responda ~PARAR~.",
      }),
    ).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ProspectingError);
    expect((erro as ProspectingError).status).toBe(422);
    expect((erro as ProspectingError).escopo).toBe("campanha");
    const mensagem = (erro as ProspectingError).message;
    // A frase antiga mandaria INCLUIR uma palavra que já está no texto: conserto
    // que não se acha lendo o aviso. A de agora nomeia a marcação.
    expect(mensagem).toContain("riscada");
    expect(mensagem, "a recusa manda incluir uma palavra que já está lá").not.toContain(
      "precisa conter",
    );
    // E NADA foi gravado: a campanha não inicia com um texto que o cliente lê apagado.
    expect(escritas).toEqual([]);
  });

  it("o ENVIO e a RETOMADA aceitam a campanha já salva com o texto riscado — não pausam", async () => {
    const { db } = bancoDoSalvar();
    const config = campaignConfigSchema.parse({
      ...BASE,
      texto_da_saida: "Se não quiser mais, responda ~PARAR~.",
    });
    // Sem `aoGravar` é o caminho do `worker.ts` (a cada envio) e o da rota de
    // retomada: a campanha já existe, e o texto dela não pode impedir o envio.
    await expect(validateConfig(db, ORG, config)).resolves.toBeDefined();
  });

  it("o servidor pega o caso que só a régua do IDIOMA vê", () => {
    // pt instalado, BAJA legível e PARAR riscado: o schema genérico passa (há
    // palavra de saída no texto) e é `validarTextoDaSaidaNoIdioma` quem recusa.
    const misto = "Si no quieres más, escribe BAJA (o ~~PARAR~~ también vale).";
    expect(problemaNoTextoDaSaida(misto), "o schema genérico já recusaria — o caso perde o sentido").toBeNull();
    expect(noIdioma(misto)).toBe("palavra_escondida");
  });

  it("palavra LEGÍVEL continua aceita — negrito, acento, caixa e o til de 'cerca de'", () => {
    expect(noIdioma("Se não quiser mais, responda *PARAR*.")).toBeNull();
    expect(noIdioma("Se não for o caso, é só responder PARÁR.")).toBeNull();
    expect(noIdioma("Se não quiser mais, pode responder parar.")).toBeNull();
    // Um til solto (de "cerca de", sem par fechando) não é riscado; a palavra
    // está fora dele e continua visível.
    expect(noIdioma("Custa ~R$ 50 por mês. Para sair, responda PARAR.")).toBeNull();
    // DOIS tis de "cerca de", com a palavra legível entre eles: o riscado do
    // WhatsApp não fecha depois de espaço nem atravessa linha, então não há par.
    // Medido na triagem: o padrão sem essa borda devolvia `palavra_escondida`.
    expect(noIdioma("Planos de ~R$ 50. Para sair, responda PARAR. Entrega em ~3 dias.")).toBeNull();
    expect(noIdioma("Custa ~50 reais.\nPara sair, responda PARAR.\nPrazo ~2 dias.")).toBeNull();
  });

  it("texto escondido gravado por fora não sai: cai na frase padrão de hoje", () => {
    const escondido = "Se não quiser mais, responda ~PARAR~.";
    expect(textoDaSaidaEfetivo(escondido, "pt-BR")).toBe(PADRAO_PT);
    expect(comSaida("Oi, tudo bem?", "pt-BR", escondido)).toBe(`Oi, tudo bem?\n\n${PADRAO_PT}`);
  });

  it("o detector continua reconhecendo a resposta com o rodapé personalizado", () => {
    // O rodapé é texto da EMPRESA: não é pedido de opt-out.
    expect(ehPedidoDeOptOut(TEXTO_DO_DONO)).toBe(false);
    // A resposta que ele ENSINA a dar é, e continua sendo, a palavra sozinha.
    expect(ehPedidoDeOptOut("PARAR")).toBe(true);
    expect(ehPedidoDeOptOut("parar.")).toBe(true);
    expect(ehPedidoDeOptOut("Parar!")).toBe(true);
  });

  it("a palavra que o texto do dono ENSINA é a que o detector reconhece — nos três idiomas", () => {
    // O laço é o ponto: a régua de aceitação (`problemaNoTextoDaSaidaNoIdioma`) e
    // o detector são DOIS lados do mesmo contrato, e o que fecha o laço é a
    // palavra que o texto manda responder. Sem este teste, um texto aceito com
    // uma palavra que o detector não conhece passaria — a pessoa responderia e
    // seguiria recebendo.
    const casos = [
      { locale: "pt-BR", texto: "Se não fizer sentido, é só responder PARAR.", resposta: "Parar!" },
      { locale: "es-AR", texto: "Si no tiene sentido, escribí BAJA y no escribo más.", resposta: "baja." },
      { locale: "en-US", texto: "If this isn't for you, reply STOP and I won't write again.", resposta: "STOP" },
    ] as const;
    for (const { locale, texto, resposta } of casos) {
      expect(
        problemaNoTextoDaSaidaNoIdioma(texto, locale),
        `o texto com tom próprio foi recusado em ${locale}`,
      ).toBeNull();
      // A palavra do texto é a do idioma — o dono escreve EM VOLTA dela, não no
      // lugar dela.
      expect(texto).toContain(palavraDeSaida(locale));
      // E ela, respondida sozinha (com caixa e pontuação do dia a dia), descadastra.
      expect(ehPedidoDeOptOut(resposta), `a resposta ensinada em ${locale} não descadastra`).toBe(
        true,
      );
    }
  });

  it("a recusa chega traduzida em espanhol e em inglês", () => {
    const chave =
      "A palavra está no texto, mas riscada, escondida ou em código. Tire a marcação de cima dela: é o que a pessoa vai responder.";
    // pt-BR é a CHAVE do dicionário; o espanhol é coluna dele.
    expect(traduzir(chave, "pt-BR")).toBe(chave);
    expect(traduzir(chave, "es")).not.toBe(chave);
    // O inglês deste produto mora no catálogo (`em_construcao`, ainda não
    // carregado em runtime) — a frase tem de existir lá para o dia da promoção.
    const en = JSON.parse(
      fs.readFileSync(path.join(RAIZ, "lib/i18n/traducoes/en.json"), "utf8"),
    ) as Record<string, string>;
    expect(en[chave], "a frase da recusa não está no catálogo em inglês").toBeTruthy();
    // As OUTRAS recusas do mesmo campo — inclusive a de "sem a palavra", que é a
    // dos casos (2) e (3) — também precisam de inglês: sem elas, a validação que
    // o pedido chama de clara só existiria em pt e es.
    for (const outra of [
      "Inclua a palavra que a pessoa responde para sair; sem ela o pedido não é reconhecido.",
      "Use até 160 caracteres e nenhum link.",
    ]) {
      expect(en[outra], `sem inglês para a recusa: ${outra}`).toBeTruthy();
      expect(traduzir(outra, "es"), `sem espanhol para a recusa: ${outra}`).not.toBe(outra);
    }
  });
});
