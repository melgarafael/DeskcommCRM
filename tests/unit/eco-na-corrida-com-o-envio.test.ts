/**
 * O ECO QUE CHEGA NO MEIO DO ENVIO não pode pausar a IA nem duplicar a mensagem.
 *
 * Caso real (06/10/2026, campanha da Rodaê): a campanha gravou a mensagem sem
 * id; o eco do WAHA chegou 14 s depois e a ingestão levou 4 s. No meio, o envio
 * confirmou (gravou o id e virou `sent`). As duas guardas da ingestão erraram:
 *   - `jaRegistrada` leu ANTES — a linha ainda não tinha id;
 *   - `ehEcoDeEnvioNosso` leu DEPOIS — a linha já era `sent`, fora de "em voo".
 * Resultado: a IA pausada por 1 h na conversa e a mensagem duas vezes na tela.
 *
 * O dublê encena a corrida nas duas ordens, e respeita o unique
 * `(organization_id, external_id)` de `messages`: o banco recusa com 23505 a
 * segunda linha com o mesmo id, então o dublê também recusa.
 *   - o envio confirma ANTES de o eco ser gravado: o insert do eco bate no
 *     unique e sai pelo dedup de sempre (desde o #1855, que grava o eco bare);
 *   - o eco é gravado ANTES, o envio confirma e apaga o eco, e só então a
 *     ingestão lê de novo: é aqui que a re-checagem depois do insert decide.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { dispatchWahaEvent, type WahaEnvelope, type WahaPayload } from "@/lib/waha/ingest";

interface Linha {
  id: string;
  organization_id: string;
  conversation_id?: string;
  external_id: string | null;
  direction?: string;
  status?: string;
  body?: string | null;
  sent_via?: string;
  [k: string]: unknown;
}

const BARE = "3EB06FABDB312F95A4EB7B";
const TEXTO = "Olá, Luciano! Somos da RODAÊ bikes elétricas. Teria interesse?\n1. Sim\n2. Não";

type Corrida = "nenhuma" | "envio-confirma-no-insert-do-eco" | "envio-confirma-depois-do-insert-do-eco";

function banco(corrida: Corrida) {
  const envio: Linha = {
    id: "envio-campanha",
    organization_id: "org-1",
    conversation_id: "conversa-1",
    external_id: null,
    direction: "outbound",
    status: "queued",
    sent_via: "automation",
    body: TEXTO,
    type: "chat",
  };
  const messages: Linha[] = [envio];
  let ecoInserido = false;
  let envioConfirmou = false;
  /** O envio confirma: grava o id do canal e apaga o eco pelo id (`removerEcoDoProprioEnvio`). */
  const confirmarEnvio = () => {
    envioConfirmou = true;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.sent_via === "external_device") messages.splice(i, 1);
    Object.assign(envio, { external_id: BARE, status: "sent" });
  };
  const conversa: Record<string, unknown> = { id: "conversa-1", bot_silenced_until: null };

  const casa = (m: Linha, filtros: Array<[string, unknown, "eq" | "in" | "neq" | "is"]>) =>
    filtros.every(([c, v, op]) => {
      if (op === "in") return (v as unknown[]).includes(m[c]);
      if (op === "neq") return m[c] !== v;
      return m[c] === v;
    });

  const consulta = (acao: "select" | "delete") => {
    const filtros: Array<[string, unknown, "eq" | "in" | "neq" | "is"]> = [];
    const q: Record<string, unknown> = {
      eq(c: string, v: unknown) {
        filtros.push([c, v, "eq"]);
        return q;
      },
      in(c: string, v: unknown[]) {
        filtros.push([c, v, "in"]);
        return q;
      },
      neq(c: string, v: unknown) {
        filtros.push([c, v, "neq"]);
        return q;
      },
      is(c: string, v: unknown) {
        filtros.push([c, v, "is"]);
        return q;
      },
      gte: () => q,
      order: () => q,
      limit: () => q,
      async maybeSingle() {
        const achou = messages.find((m) => casa(m, filtros));
        return { data: achou ? { id: achou.id } : null, error: null };
      },
      then(ok: (v: unknown) => unknown) {
        if (acao === "delete") {
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m && casa(m, filtros)) messages.splice(i, 1);
          }
          return Promise.resolve(ok({ error: null }));
        }
        return Promise.resolve(ok({ data: messages.filter((m) => casa(m, filtros)), error: null }));
      },
    };
    return q;
  };

  const tabela = (nome: string) => ({
    select: () =>
      nome === "conversations"
        ? { eq() { return this; }, async maybeSingle() { return { data: { bot_silenced_until: conversa.bot_silenced_until }, error: null }; } }
        : (() => {
            // A ORDEM INVERSA: o eco já está gravado, e o envio confirma antes da
            // próxima leitura de `messages` que a ingestão fizer.
            if (nome === "messages" && corrida === "envio-confirma-depois-do-insert-do-eco" && ecoInserido && !envioConfirmou) confirmarEnvio();
            return consulta("select");
          })(),
    delete: () => consulta("delete"),
    insert: (linha: Record<string, unknown>) => ({
      select: () => ({
        async maybeSingle() {
          if (nome !== "messages") return { data: { id: "x" }, error: null };
          // O envio confirma exatamente agora, antes de o eco ser gravado.
          if (corrida === "envio-confirma-no-insert-do-eco") confirmarEnvio();
          const nova = { id: `eco-${messages.length + 1}`, ...linha } as Linha;
          // O unique `(organization_id, external_id)`: o banco recusa a duplicata.
          const duplicada = messages.some(
            (m) => m.external_id !== null && m.organization_id === nova.organization_id && m.external_id === nova.external_id,
          );
          if (duplicada) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          messages.push(nova);
          ecoInserido = true;
          return { data: { id: nova.id }, error: null };
        },
      }),
    }),
    update: (patch: Record<string, unknown>) => {
      if (nome === "conversations") Object.assign(conversa, patch);
      const enc: Record<string, unknown> = { error: null };
      enc.eq = () => enc;
      enc.in = () => enc;
      return enc;
    },
  });

  const admin = {
    from: (nome: string) => tabela(nome),
    rpc: async (fn: string) => {
      if (fn === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
      if (fn === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
      return { data: null, error: null };
    },
  };
  return { admin, messages, conversa, envio };
}

const SESSION = { id: "sessao-1", organization_id: "org-1" };
const envelope = (p: WahaPayload): WahaEnvelope => ({ event: "message.any", session: "default", payload: p });

/** O eco real: pelo `@c.us`, enquanto o envio foi pelo `@lid`. */
const eco = (body: string): WahaPayload => ({
  id: `true_5513996919846@c.us_${BARE}`,
  from: "5513996919846@c.us",
  fromMe: true,
  body,
  timestamp: 1_760_000_000,
});

describe("eco que chega no meio do envio", () => {
  it("⭐ eco gravado ANTES de o envio confirmar: a re-checagem depois do insert reconhece o eco e a IA NÃO é pausada", async () => {
    const { admin, conversa, messages } = banco("envio-confirma-depois-do-insert-do-eco");

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco(TEXTO)), "req-0");

    expect(conversa.bot_silenced_until, "a IA foi pausada por ter falado — o caso do Luciano").toBeNull();
    expect(messages.map((m) => m.id), "a mensagem da campanha ficou duas vezes na conversa").toEqual(["envio-campanha"]);
  });

  it("CONTROLE do dedup: o envio confirma no insert do eco, o unique recusa o eco e a IA NÃO é pausada", async () => {
    const { admin, conversa, messages } = banco("envio-confirma-no-insert-do-eco");

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco(TEXTO)), "req-1");

    expect(conversa.bot_silenced_until, "a IA foi pausada por ter falado — o caso do Luciano").toBeNull();
    expect(
      messages.map((m) => m.id),
      "a mensagem da campanha ficou duas vezes na conversa",
    ).toEqual(["envio-campanha"]);
  });

  it("CONTROLE: digitação real no celular (texto diferente, nenhum id nosso) AINDA pausa", async () => {
    const { admin, conversa, messages } = banco("nenhuma");
    const humano: WahaPayload = { ...eco("oi, é o Cristiano respondendo do celular"), id: "true_5513996919846@c.us_AAAABBBBCCCCDDDDEEEE" };

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(humano), "req-2");

    expect(conversa.bot_silenced_until, "o atendente respondeu pelo celular e a IA continuou solta").not.toBeNull();
    expect(messages).toHaveLength(2);
  });

  it("CONTROLE: id NOSSO já gravado antes do eco — sai pelo dedup de sempre, sem inserir", async () => {
    const { admin, conversa, messages, envio } = banco("nenhuma");
    Object.assign(envio, { external_id: BARE, status: "sent" });

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco(TEXTO)), "req-3");

    expect(conversa.bot_silenced_until).toBeNull();
    expect(messages).toHaveLength(1);
  });
});
