/**
 * O NÚMERO QUE A LIGAÇÃO DISCA — perguntado ao WhatsApp, não adivinhado.
 *
 * Medido na VPS em 2026-09-15: o contato `+5531998966398` foi discado como
 * `5531998966398@s.whatsapp.net`, e o WhatsApp o registra como `553198966398`.
 * O WAHA respondeu `check-exists` das DUAS grafias com
 * `{"numberExists":true,"chatId":"553198966398@c.us"}` — é essa resposta,
 * copiada do terminal, que os casos abaixo usam. Ver `lib/voice/numero-discavel.ts`.
 */
import { describe, expect, it, vi } from "vitest";

const transporte = vi.hoisted(() => ({ cliente: null as unknown }));
vi.mock("@/lib/waha/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getWahaClient: () => transporte.cliente,
}));

import { wahaAdapter } from "@/lib/channels/adapters/waha";
import type { ChannelAdapter } from "@/lib/channels";
import type { WahaClient } from "@/lib/waha/client";
import { phoneJidDigitsFromCheckResult } from "@/lib/waha/resolve-contact-whatsapp-id";
import { resolverNumeroDiscavel } from "@/lib/voice/numero-discavel";

const ORG = "11111111-1111-4111-8111-111111111111";
const RESPOSTA_MEDIDA = { numberExists: true, chatId: "553198966398@c.us" };

type Sessao = { provider: string; waha_session_name?: string | null; meta_phone_number_id?: string | null; zernio_account_id?: string | null };

function supabaseCom(sessoes: Sessao[]) {
  const filtros: Array<[string, unknown]> = [];
  const cadeia: Record<string, unknown> = {};
  cadeia.select = () => cadeia;
  cadeia.limit = () => cadeia;
  cadeia.eq = (c: string, v: unknown) => (filtros.push([c, v]), cadeia);
  cadeia.is = (c: string, v: unknown) => (filtros.push([c, v]), cadeia);
  cadeia.in = (c: string, v: unknown) => (filtros.push([c, v]), cadeia);
  cadeia.then = (ok: (r: unknown) => unknown) => ok({ data: sessoes, error: null });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { from: () => cadeia } as any, filtros };
}

const SESSAO_DE_MENSAGEM: Sessao = { provider: "waha", waha_session_name: "org_988371bf_8a08b2" };

/** Um canal que sabe (ou não) dizer o número registrado — sem nomear plataforma. */
function canal(responde?: (phone: string) => Promise<string | null>, configurado = true) {
  const perguntas: Array<{ sessionRef: string; phone: string }> = [];
  const adapter = {
    isConfigured: () => configurado,
    ...(responde
      ? {
          resolveRegisteredPhone: vi.fn(async (i: { sessionRef: string; phone: string }) => {
            perguntas.push({ sessionRef: i.sessionRef, phone: i.phone });
            return responde(i.phone);
          }),
        }
      : {}),
  } as unknown as ChannelAdapter;
  return { adapter, perguntas };
}

describe("phoneJidDigitsFromCheckResult — só endereço de TELEFONE serve para ligar", () => {
  it("c.us e s.whatsapp.net viram dígitos; o sufixo de aparelho sai", () => {
    expect(phoneJidDigitsFromCheckResult(RESPOSTA_MEDIDA)).toBe("553198966398");
    expect(
      phoneJidDigitsFromCheckResult({ numberExists: true, chatId: "553198966398:12@s.whatsapp.net" }),
    ).toBe("553198966398");
  });

  it("@lid sozinho NÃO serve: o WaCalls transformaria os dígitos do lid num telefone inexistente", () => {
    expect(phoneJidDigitsFromCheckResult({ numberExists: true, chatId: "59782320914646@lid" })).toBeNull();
  });

  it("com lid no chatId e telefone no pn, vale o pn", () => {
    expect(
      phoneJidDigitsFromCheckResult({
        numberExists: true,
        chatId: "59782320914646@lid",
        pn: "553198966398@c.us",
      }),
    ).toBe("553198966398");
  });

  it("número que não existe não devolve nada", () => {
    expect(phoneJidDigitsFromCheckResult({ numberExists: false, chatId: "553198966398@c.us" })).toBeNull();
  });
});

describe("resolverNumeroDiscavel — pela porta do canal", () => {
  it("o caso medido: cadastro COM o nono, canal responde SEM — disca o do canal", async () => {
    const { db, filtros } = supabaseCom([SESSAO_DE_MENSAGEM]);
    const { adapter, perguntas } = canal(async () => "553198966398");

    const r = await resolverNumeroDiscavel(db, ORG, "+5531998966398", { adapterDe: () => adapter });

    expect(r).toEqual({ digitos: "553198966398", fonte: "whatsapp" });
    // A pergunta vai com o identificador da sessão que o seam resolveu.
    expect(perguntas).toEqual([{ sessionRef: "org_988371bf_8a08b2", phone: "+5531998966398" }]);
    // Sessões desta organização, em pé, não arquivadas, só de mensagem.
    expect(filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", ORG],
        ["status", "WORKING"],
        ["archived_at", null],
      ]),
    );
    expect(filtros.find(([c]) => c === "provider")?.[1]).not.toContain("wacalls");
  });

  it("canal que não sabe responder é pulado; o seguinte que sabe responde", async () => {
    const { db } = supabaseCom([
      { provider: "meta_cloud", meta_phone_number_id: "123" },
      SESSAO_DE_MENSAGEM,
    ]);
    const mudo = canal();
    const sabe = canal(async () => "553198966398");
    const r = await resolverNumeroDiscavel(db, ORG, "+5531998966398", {
      adapterDe: (provider) => (provider === "meta_cloud" ? mudo.adapter : sabe.adapter),
    });
    expect(r.digitos).toBe("553198966398");
  });

  it("sem sessão de mensagens em pé, disca o cadastro sem perguntar a ninguém", async () => {
    const { db } = supabaseCom([]);
    const { adapter, perguntas } = canal(async () => "553198966398");
    const r = await resolverNumeroDiscavel(db, ORG, "+5531998966398", { adapterDe: () => adapter });
    expect(r).toEqual({ digitos: "5531998966398", fonte: "cadastro" });
    expect(perguntas).toEqual([]);
  });

  it("canal não configurado, que falha ou que não sabe o número cai no cadastro", async () => {
    const { db } = supabaseCom([SESSAO_DE_MENSAGEM]);
    for (const { adapter } of [
      canal(async () => "553198966398", false),
      canal(async () => {
        throw new Error("transporte_500");
      }),
      canal(async () => null),
    ]) {
      expect(await resolverNumeroDiscavel(db, ORG, "+5531998966398", { adapterDe: () => adapter })).toEqual({
        digitos: "5531998966398",
        fonte: "cadastro",
      });
    }
  });

  it("canal que aceita e não responde não segura a ligação além do prazo", async () => {
    // Sem prazo: duas grafias × 15 s de teto passavam dos 30 s do navegador, a
    // tela mostrava erro e a ligação saía mesmo assim, uma por clique.
    const { db } = supabaseCom([SESSAO_DE_MENSAGEM]);
    const { adapter } = canal(() => new Promise(() => undefined));
    const inicio = Date.now();
    const r = await resolverNumeroDiscavel(db, ORG, "+5531998966398", { adapterDe: () => adapter, prazoMs: 50 });
    expect(r).toEqual({ digitos: "5531998966398", fonte: "cadastro" });
    expect(Date.now() - inicio).toBeLessThan(2_000);
  });
});

describe("o adaptador pergunta ao transporte as duas grafias", () => {
  it("devolve o JID de telefone que o transporte registrou — a resposta medida", async () => {
    const perguntas: string[] = [];
    transporte.cliente = {
      checkContactExists: vi.fn(async (_s: string, digitos: string) => {
        perguntas.push(digitos);
        return digitos === "553198966398" ? RESPOSTA_MEDIDA : { numberExists: false };
      }),
    } as unknown as WahaClient;
    const r = await wahaAdapter.resolveRegisteredPhone!({
      organizationId: ORG,
      sessionRef: "sessao",
      phone: "+5531998966398",
    });
    expect(perguntas).toEqual(["5531998966398", "553198966398"]);
    expect(r).toBe("553198966398");
  });

  it("só @lid não serve, e transporte ausente responde null", async () => {
    transporte.cliente = {
      checkContactExists: vi.fn(async () => ({ numberExists: true, chatId: "59782320914646@lid" })),
    } as unknown as WahaClient;
    expect(
      await wahaAdapter.resolveRegisteredPhone!({ organizationId: ORG, sessionRef: "s", phone: "+5531998966398" }),
    ).toBeNull();
    transporte.cliente = null;
    expect(
      await wahaAdapter.resolveRegisteredPhone!({ organizationId: ORG, sessionRef: "s", phone: "+5531998966398" }),
    ).toBeNull();
  });
});
