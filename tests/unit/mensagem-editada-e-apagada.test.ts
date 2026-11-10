import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it } from "vitest";

/**
 * A MENSAGEM QUE O CLIENTE EDITOU OU APAGOU.
 *
 * ─── O defeito, relatado olhando a tela ─────────────────────────────────────
 *
 * O dono editou uma mensagem no celular e o inbox seguiu mostrando o texto
 * antigo. Nenhum erro em lugar nenhum: o evento chega (quando assinado), o
 * parser não o reconhece, a rota responde 200, a linha fica como estava.
 *
 * É pior que uma falha visível. Combinar preço, prazo ou endereço a partir de um
 * texto que o cliente já corrigiu gera uma divergência que ninguém rastreia
 * depois — os dois lados juram ter lido coisas diferentes, e os dois têm razão.
 *
 * ─── O que estes casos prendem ──────────────────────────────────────────────
 *
 * Que a edição case pela mensagem ORIGINAL (não pelo id do evento); que apagar
 * não apague a LINHA; que uma edição de mensagem desconhecida não invente
 * conversa; e que a tela DIGA que houve edição — o texto novo sozinho mente por
 * omissão, porque se lê como se sempre tivesse dito aquilo.
 */
import { parseZernioEdicao } from "@/lib/channels/zernio/webhook";
import { aplicarEdicaoZernio } from "@/lib/channels/zernio/ingest";

const zEvento = (event: string, extra: Record<string, unknown> = {}) => ({
  event,
  message: { platform: "whatsapp", platformMessageId: "wamid.ABC", ...extra },
});

describe("leitura do evento (Zernio)", () => {
  it("reconhece edição e traz o corpo novo", () => {
    const e = parseZernioEdicao(zEvento("message.edited", { content: "preço novo: 300" }));
    expect(e).toMatchObject({ externalId: "wamid.ABC", tipo: "edited", body: "preço novo: 300" });
  });

  it("reconhece apagamento — que não tem corpo a trazer", () => {
    const e = parseZernioEdicao(zEvento("message.deleted"));
    expect(e).toMatchObject({ externalId: "wamid.ABC", tipo: "deleted" });
  });

  it("mensagem nova NÃO entra por aqui — tem outro caminho", () => {
    // Misturá-las faria uma edição criar conversa do nada.
    expect(parseZernioEdicao(zEvento("message.received"))).toBeNull();
    expect(parseZernioEdicao(null)).toBeNull();
  });

  it("edição de outra plataforma é ignorada", () => {
    // A mesma conta serve Instagram e Facebook; não há linha nossa para corrigir.
    expect(
      parseZernioEdicao({
        event: "message.edited",
        message: { platform: "instagram", platformMessageId: "x" },
      }),
    ).toBeNull();
  });

  it("sem id da mensagem não há o que corrigir", () => {
    expect(parseZernioEdicao({ event: "message.edited", message: { platform: "whatsapp" } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------

const ops: { tabela: string; op: string; payload?: unknown; filtros: [string, unknown][] }[] = [];
let afetadas: unknown[] = [{ id: "m1" }];

function chain(tabela: string, op: string, payload?: unknown): Record<string, unknown> {
  const filtros: [string, unknown][] = [];
  ops.push({ tabela, op, payload, filtros });
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then")
          return (ok: (v: unknown) => unknown) => ok({ data: afetadas, error: null });
        return (...args: unknown[]) => {
          if (prop === "eq") filtros.push([String(args[0]), args[1]]);
          return proxy;
        };
      },
    },
  ) as Record<string, unknown>;
  return proxy;
}

const admin = {
  from: (t: string) => ({
    update: (p: unknown) => chain(t, "update", p),
    insert: (p: unknown) => chain(t, "insert", p),
    delete: () => chain(t, "delete"),
  }),
} as never;

beforeEach(() => {
  ops.length = 0;
  afetadas = [{ id: "m1" }];
});

describe("aplicar na linha que já existe", () => {
  it("edição sobrescreve o corpo e carimba quando", async () => {
    const r = await aplicarEdicaoZernio(admin, "org", {
      externalId: "wamid.ABC",
      tipo: "edited",
      body: "preço novo: 300",
    });
    expect(r).toBe("aplicado");
    const up = ops.find((o) => o.op === "update");
    expect(up?.payload).toMatchObject({ body: "preço novo: 300" });
    expect(up?.payload).toHaveProperty("edited_at");
  });

  it("apagar NÃO apaga a linha — carimba `revoked_at`", async () => {
    // Sumir com a linha deixaria a resposta seguinte respondendo ao nada, e
    // levaria junto o histórico de quem atendeu.
    await aplicarEdicaoZernio(admin, "org", { externalId: "wamid.ABC", tipo: "deleted", body: null });
    expect(ops.some((o) => o.op === "delete")).toBe(false);
    const up = ops.find((o) => o.op === "update");
    expect(up?.payload).toHaveProperty("revoked_at");
    // E não mexe no corpo: quem decide o que mostrar é a tela, e limpar aqui
    // impediria o atendente de entender depois o que tinha sido combinado.
    expect(up?.payload).not.toHaveProperty("body");
  });

  it("edição sem corpo novo não ZERA o texto", async () => {
    // Trocar a versão velha (útil) por vazio (inútil) é pior que não aplicar.
    await aplicarEdicaoZernio(admin, "org", { externalId: "wamid.ABC", tipo: "edited", body: null });
    const up = ops.find((o) => o.op === "update");
    expect(up?.payload).not.toHaveProperty("body");
    expect(up?.payload).toHaveProperty("edited_at");
  });

  it("casa por organização E por id externo — nunca só pelo id", async () => {
    // O id do provider não é garantidamente único entre tenants; sem a org,
    // uma edição de um cliente poderia reescrever a mensagem de outro.
    await aplicarEdicaoZernio(admin, "org", { externalId: "wamid.ABC", tipo: "deleted", body: null });
    const f = Object.fromEntries(ops.find((o) => o.op === "update")!.filtros);
    expect(f).toMatchObject({ organization_id: "org", external_id: "wamid.ABC" });
  });

  it("mensagem desconhecida devolve `sem_alvo`, sem inventar linha", async () => {
    afetadas = [];
    expect(
      await aplicarEdicaoZernio(admin, "org", { externalId: "nao-existe", tipo: "edited", body: "x" }),
    ).toBe("sem_alvo");
    expect(ops.some((o) => o.op === "insert")).toBe(false);
  });
});

describe("os elos que somem sem barulho", () => {
  it("o seam aplica a edição ANTES da ingestão", () => {
    // Deixá-la cair no `ingest` faria uma edição criar conversa e contato do
    // nada, com um texto sem nada antes dele.
    const fonte = readFileSync("lib/channels/inbound.ts", "utf8");
    expect(fonte).toMatch(/await aplicarEdicaoZernio\(/);
    expect(fonte.indexOf("parseZernioEdicao")).toBeLessThan(fonte.indexOf("ingestZernioInbound(admin"));
  });

  it("WAHA casa pela mensagem ORIGINAL, não pelo id do evento", () => {
    // `editedMessageId`/`revokedMessageId` apontam para a mensagem que mudou; o
    // `id` do payload é o do próprio evento. Casar pelo `id` não acharia nada —
    // e o silêncio pareceria "funcionou".
    const fonte = readFileSync("lib/waha/ingest.ts", "utf8");
    expect(fonte).toMatch(/p\.editedMessageId/);
    expect(fonte).toMatch(/p\.revokedMessageId/);
    expect(fonte).toMatch(/eventType === "message\.edited"/);
    expect(fonte).toMatch(/eventType === "message\.revoked"/);
  });

  it("o canal por QR ASSINA os dois eventos — sem isso nada chega", () => {
    // Este é o elo mais silencioso de todos: o código trata os eventos
    // perfeitamente e o transporte nunca os envia. Medido antes desta mudança —
    // `WHATSAPP_HOOK_EVENTS` não tinha nenhum dos dois, e a mensagem editada
    // pelo dono simplesmente nunca chegou ao CRM.
    for (const arquivo of ["docker-compose.prod.yml", "docker-compose.yml"]) {
      const compose = readFileSync(arquivo, "utf8");
      const linha = compose.split("\n").find((l) => l.includes("WHATSAPP_HOOK_EVENTS")) ?? "";
      expect(linha, `${arquivo} não assina message.edited`).toContain("message.edited");
      expect(linha, `${arquivo} não assina message.revoked`).toContain("message.revoked");
    }
  });

  it("as colunas novas chegam à tela — sem elas a bolha nunca sabe", () => {
    // O `select` do handler é a única porta: coluna fora dele não chega, e
    // `conv as unknown as Joined` faz isso NÃO ser erro de tipo.
    const fonte = readFileSync("app/api/v1/messages/_handler.ts", "utf8");
    expect(fonte).toMatch(/edited_at, revoked_at/);
  });

  it("a bolha DIZ que foi editada, e consulta a régua do texto apagado", () => {
    const fonte = readFileSync("components/inbox/MessageBubble.tsx", "utf8");
    expect(fonte).toMatch(/revoked_at/);
    expect(fonte).toMatch(/editada/);
    // Quem decide se o texto da apagada aparece na bolha é
    // `lib/messaging/apagada.ts`, não uma condição solta dentro dela.
    expect(fonte).toMatch(/textoDaApagadaApareceNaInbox/);
    const regua = readFileSync("lib/messaging/apagada.ts", "utf8");
    expect(regua).toMatch(/Esta mensagem foi apagada pelo contato/);
  });
});
