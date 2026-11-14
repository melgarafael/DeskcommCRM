import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import type { ChannelSendResult } from "@/lib/agent-engine/channel-adapter";
import { audit } from "@/lib/audit";
import { campaignConfigSchema } from "@/lib/prospecting/schema";
import {
  comSaida,
  problemaNoTextoDaSaida,
  problemaNoTextoDaSaidaNoIdioma,
  rodapeDeSaida,
  TAMANHO_MAXIMO_DO_TEXTO_DA_SAIDA,
  temSaida,
  textoDaSaidaEfetivo,
} from "@/lib/prospecting/rodape-de-saida";
import { enviarComSaidaConfiguravel } from "@/lib/prospecting/saida-configuravel";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
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
