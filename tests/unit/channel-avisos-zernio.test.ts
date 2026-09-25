import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it } from "vitest";

/**
 * Avisos de canal — o que a plataforma decide sozinha.
 *
 * ─── O que estava invisível ────────────────────────────────────────────────
 *
 * Ela revisa os modelos aprovados e mexe no número por conta própria: reprova
 * um template, suspende a linha por falta de pagamento, exige KYC. Nada disso
 * chegava a lugar nenhum — a descoberta acontecia no disparo que não saiu, com
 * a campanha montada e o cliente esperando.
 *
 * ─── A severidade é a parte que se erra ────────────────────────────────────
 *
 * Marcar tudo como crítico é o mesmo que não marcar nada: o operador aprende a
 * ignorar a cor. Crítico fica para o que INTERROMPE o envio; boa notícia é
 * `info`, e vale registrar sem interromper ninguém.
 */
import {
  atualizarEspelhoDoTemplate,
  avisoDoEvento,
  registrarAviso,
} from "@/lib/channels/zernio/avisos";

const template = (status: string, reason: string | null = null) => ({
  event: "whatsapp.template.status_updated",
  template: { name: "cuenta_activa", status, ...(reason ? { reason } : {}) },
});

describe("revisão de modelo", () => {
  it("reprovado é CRÍTICO — a campanha que dependia dele não vai sair", () => {
    const a = avisoDoEvento(template("REJECTED", "Conteúdo promocional em modelo utility"));
    expect(a?.severity).toBe("critical");
    expect(a?.title).toContain("cuenta_activa");
    expect(a?.title).toContain("REJECTED");
    expect(a?.body).toContain("promocional");
  });

  it("aprovado é INFO — boa notícia não interrompe ninguém", () => {
    expect(avisoDoEvento(template("APPROVED"))?.severity).toBe("info");
  });

  it("pausado pede atenção sem parar tudo", () => {
    expect(avisoDoEvento(template("PAUSED"))?.severity).toBe("warn");
  });

  it("estado que a plataforma inventar depois vira warn, não explode", () => {
    // O vocabulário dela é aberto; um `as const` viraria erro em runtime.
    expect(avisoDoEvento(template("ALGO_NOVO"))?.severity).toBe("warn");
  });

  it('"NONE" não vira motivo — é como ela diz "sem motivo"', () => {
    // Repassá-lo mostraria ruído justo onde o operador procura a explicação.
    expect(avisoDoEvento(template("APPROVED", "NONE"))?.body).toBeNull();
  });
});

describe("estado do número", () => {
  const ev = (event: string, reason?: string) => avisoDoEvento({ event, ...(reason ? { reason } : {}) });

  it("suspenso é crítico e diz que NÃO dá para enviar", () => {
    const a = ev("whatsapp.number.suspended", "falta de pagamento");
    expect(a?.severity).toBe("critical");
    expect(a?.title).toMatch(/SUSPENSO/);
    expect(a?.body).toBe("falta de pagamento");
  });

  it("liberado (terminal) e recusado também são críticos", () => {
    expect(ev("whatsapp.number.released")?.severity).toBe("critical");
    expect(ev("whatsapp.number.declined")?.severity).toBe("critical");
  });

  it("conta desconectada é crítica — o canal para de funcionar inteiro", () => {
    expect(ev("account.disconnected")?.severity).toBe("critical");
  });

  it("verificação exigida pede ação, não é catástrofe", () => {
    expect(ev("whatsapp.number.verification_required")?.severity).toBe("warn");
    expect(ev("whatsapp.number.action_required")?.severity).toBe("warn");
  });

  it("ativado e reativado são info", () => {
    expect(ev("whatsapp.number.activated")?.severity).toBe("info");
    expect(ev("whatsapp.number.reactivated")?.severity).toBe("info");
  });

  it("evento de mensagem NÃO vira aviso — tem outro caminho", () => {
    expect(avisoDoEvento({ event: "message.received" })).toBeNull();
    expect(avisoDoEvento(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

const ops: { tabela: string; op: string; payload?: unknown }[] = [];
let jaAberto: unknown = null;
let linhasAfetadas: unknown[] = [{ id: "t1" }];

const eqCalls: { tabela: string; campo: string; valor: unknown }[] = [];

function chain(tabela: string, op: string, payload?: unknown): Record<string, unknown> {
  ops.push({ tabela, op, payload });
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "maybeSingle") return async () => ({ data: jaAberto, error: null });
        if (prop === "then")
          return (ok: (v: unknown) => unknown) => ok({ data: linhasAfetadas, error: null });
        if (prop === "eq")
          return (campo: string, valor: unknown) => {
            eqCalls.push({ tabela, campo, valor });
            return proxy;
          };
        return () => proxy;
      },
    },
  ) as Record<string, unknown>;
  return proxy;
}

const admin = {
  from: (t: string) => ({
    select: () => chain(t, "select"),
    insert: (p: unknown) => chain(t, "insert", p),
    update: (p: unknown) => chain(t, "update", p),
  }),
} as never;

beforeEach(() => {
  ops.length = 0;
  eqCalls.length = 0;
  jaAberto = null;
  linhasAfetadas = [{ id: "t1" }];
});

describe("gravação do aviso", () => {
  const aviso = { kind: "channel_number_alert" as const, severity: "critical" as const, title: "Número SUSPENSO", body: null };

  it("grava quando é novo", async () => {
    expect(await registrarAviso(admin, "org", aviso)).toBe("criado");
    const ins = ops.find((o) => o.tabela === "agent_inbox_items" && o.op === "insert");
    expect(ins?.payload).toMatchObject({ kind: "channel_number_alert", severity: "critical" });
  });

  it("NÃO repete o que já está aberto — Central ruidosa é Central que ninguém lê", async () => {
    // A plataforma reentrega quando não recebe 200, e alguns eventos chegam em
    // rajada (uma revisão em lote mexe em vários modelos de uma vez).
    jaAberto = { id: "existente" };
    expect(await registrarAviso(admin, "org", aviso)).toBe("ja_aberto");
    expect(ops.some((o) => o.op === "insert")).toBe(false);
  });
});

describe("espelho local do modelo", () => {
  it("atualiza o estado — ver o estado velho depois do aviso é pior que não avisar", async () => {
    const ok = await atualizarEspelhoDoTemplate(admin, "org", template("REJECTED", "motivo"));
    expect(ok).toBe(true);
    const up = ops.find((o) => o.tabela === "meta_templates" && o.op === "update");
    expect(up?.payload).toMatchObject({ status: "REJECTED", rejected_reason: "motivo" });
  });

  it("filtra por channel_session_id quando fornecido, evitando alterar conexão homônima", async () => {
    const ok = await atualizarEspelhoDoTemplate(
      admin,
      "org",
      template("REJECTED", "motivo"),
      "sessao-zernio-123",
    );
    expect(ok).toBe(true);
    const eqSession = eqCalls.find(
      (c) => c.tabela === "meta_templates" && c.campo === "channel_session_id",
    );
    expect(eqSession).toBeDefined();
    expect(eqSession?.valor).toBe("sessao-zernio-123");
  });

  it("filtra por idioma quando o evento contiver language", async () => {
    const evComIdioma = {
      event: "whatsapp.template.status_updated",
      template: { name: "cuenta_activa", status: "APPROVED", language: "pt_BR" },
    };
    const ok = await atualizarEspelhoDoTemplate(admin, "org", evComIdioma, "sessao-1");
    expect(ok).toBe(true);
    const eqLang = eqCalls.find(
      (c) => c.tabela === "meta_templates" && c.campo === "language",
    );
    expect(eqLang).toBeDefined();
    expect(eqLang?.valor).toBe("pt_BR");
  });

  it("modelo ainda não espelhado devolve false, sem inventar linha", async () => {
    // Quem sabe montar a linha inteira é o sync; inventá-la aqui, com o pouco
    // que o evento traz, criaria um registro incompleto para consertar depois.
    linhasAfetadas = [];
    expect(await atualizarEspelhoDoTemplate(admin, "org", template("APPROVED"))).toBe(false);
    expect(ops.some((o) => o.op === "insert")).toBe(false);
  });

  it("evento que não é de modelo não toca a tabela", async () => {
    expect(await atualizarEspelhoDoTemplate(admin, "org", { event: "message.received" })).toBe(false);
    expect(ops).toHaveLength(0);
  });
});

describe("o elo que some sem barulho", () => {
  it("o seam chama o aviso E o espelho — um sem o outro é meia solução", () => {
    // O sabote que atravessou a primeira versão destes casos: parar de
    // atualizar o espelho não derrubava nada. O operador leria "modelo
    // reprovado" e a tela de modelos mostraria APROVADO — pior que não avisar,
    // porque contradiz o aviso que ele acabou de ler.
    const fonte = readFileSync("lib/channels/inbound.ts", "utf8");
    expect(fonte, "não registra o aviso").toMatch(/await registrarAviso\(/);
    expect(fonte, "não atualiza o espelho do modelo").toMatch(
      /await atualizarEspelhoDoTemplate\(/,
    );
    expect(fonte, "não passa a sessão para atualizarEspelhoDoTemplate").toMatch(
      /await atualizarEspelhoDoTemplate\(\s*admin,\s*input\.session\.organization_id,\s*payload,\s*input\.session\.id,?\s*\)/,
    );
  });

  it("o aviso sai ANTES da ingestão — evento de revisão não é mensagem", () => {
    const fonte = readFileSync("lib/channels/inbound.ts", "utf8");
    expect(fonte.indexOf("avisoDoEvento")).toBeLessThan(fonte.indexOf("ingestZernioInbound(admin"));
  });
});
