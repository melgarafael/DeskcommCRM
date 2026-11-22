/**
 * O ALARME AO ENCARREGADO FALA A LÍNGUA DE QUEM RECEBE, E O RODAPÉ DE FORA DO
 * BRASIL MUDA DE FIGURA QUANDO O MÊS LEGAL VENCE (issue #2347, itens 1 e 2).
 *
 * ─── Item 2: o ramo era por PAÍS, e o `lang` estava escrito em duro ─────────
 *
 * O `<html lang>` era o literal `pt-BR` e os rótulos saíam de `noBrasil`: uma
 * organização de Portugal — que fala português, mas não é o Brasil — recebia
 * `lang="pt-BR"`, e o "Acesse:" do texto sairia igual num país que não fale
 * português. Agora quem manda é a LÍNGUA do país (`PerfilDoPais.idioma`), e o
 * país continua decidindo só a LEI: as duas coisas são ortogonais.
 *
 * A prova usa um país SINTÉTICO que fala espanhol. Nenhum país do seletor fala
 * outra língua hoje, e é exatamente esse o caso que a issue manda cobrir — o
 * mecanismo tem de estar pronto ANTES de o país entrar, não depois. O perfil
 * dele é o de Portugal clonado (mesma lei revisada, RGPD), porque o que este
 * teste isola é a língua.
 *
 * ─── Item 1: 40 dias depois, o rodapé ainda prometia um prazo legal à frente ─
 *
 * O watcher reenvia o alarme todo dia enquanto o pedido não fecha. Passado o mês
 * do art. 12.º, n.º 3, dizer que o prazo interno é "mais curto que o prazo
 * legal" faz o encarregado concluir que ainda há folga — quando o prazo legal
 * também venceu. O rodapé passa a afirmar o vencimento, e o caso ANTES do mês
 * continua palavra por palavra como era.
 *
 * O Brasil não é testado aqui: `lgpd-texto-segue-o-pais` compara o alarme
 * brasileiro byte a byte com a fixture do que ele produzia antes do doc 88, e
 * é esse teste que guarda o "não mexeu".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enviados = vi.hoisted(() => [] as Array<{ subject: string; html: string; text: string }>);
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));
vi.mock("@/lib/email/roteador", () => ({
  sendEmail: vi.fn(async (e: { subject: string; html: string; text: string }) => {
    enviados.push(e);
    return { ok: true, id: "m1" };
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.test" } }));
vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: async () => ({ valor: "" }) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) }),
    rpc: async () => ({ data: null, error: null }),
  }),
}));

import { PERFIS_DO_PAIS, perfilDoPais, type PerfilDoPais } from "@/lib/legal/perfil-do-pais";
import { triggerSlaAlarm, type AlarmThreshold } from "@/lib/lgpd/sla-alarm";
import type { LgpdRequest } from "@/lib/lgpd/types";

const MARCA = {
  nome: "Silva & Filhos",
  logoUrl: null,
  accent: "#2f6f4e",
  accentFg: "#ffffff",
  origens: { nome: "banco", cor: "banco" },
} as const;

/**
 * País SINTÉTICO que fala espanhol: não existe país oferecido que não fale
 * português, e é o caso que a issue manda cobrir. Clona Portugal (mesma lei
 * revisada) para isolar a LÍNGUA — o que este teste prova é o idioma, não a lei.
 */
const SULISTAO: PerfilDoPais = {
  ...perfilDoPais("PT"),
  codigo: "SL",
  nome: "Sulistão",
  idioma: "es",
};

/** País SINTÉTICO sem lei revisada (mesmo perfil do irmão `lgpd-texto-segue-o-pais`). */
const XISTAO: PerfilDoPais = { ...perfilDoPais("PT"), codigo: "XI", nome: "Xistão", lei: null };

beforeEach(() => {
  enviados.length = 0;
  vi.useFakeTimers();
  PERFIS_DO_PAIS.SL = SULISTAO;
});
afterEach(() => {
  vi.useRealTimers();
  delete PERFIS_DO_PAIS.SL;
});

/** O pedido de 40 dias da issue: recebido em 20/08, alarmado em 05/10. */
const RECEBIDO_HA_MAIS_DE_UM_MES = "2026-08-20T12:00:00.000Z";
const RECEBIDO_HA_MENOS_DE_UM_MES = "2026-09-20T12:00:00.000Z";
const AGORA = "2026-10-05T12:00:00.000Z";

async function alarme(opcoes: {
  country: string | null;
  recebido?: string;
  agora?: string;
  tipo?: string;
  threshold?: AlarmThreshold;
  nome?: string;
}) {
  vi.setSystemTime(new Date(opcoes.agora ?? AGORA));
  enviados.length = 0;
  await triggerSlaAlarm({
    request: {
      id: "22222222-2222-4222-8222-222222222222",
      organization_id: "org-1",
      request_type: opcoes.tipo ?? "data_request",
      status: "pending",
      attempts: 0,
      received_at: opcoes.recebido ?? RECEBIDO_HA_MENOS_DE_UM_MES,
      due_at: "2026-10-01",
      request_payload: {},
    } as unknown as LgpdRequest,
    threshold: opcoes.threshold ?? "data_request_d5",
    organizationDpoEmail: "dpo@x.test",
    organizationName: opcoes.nome ?? "Empresa <B>",
    marca: MARCA,
    country: opcoes.country,
  });
  return enviados[0]!;
}

describe("item 1 — o rodapé depois do mês legal vencido", () => {
  const VENCEU = "O prazo do art. 12.º, n.º 3 do RGPD (um mês) venceu.";
  const AINDA_HA_FOLGA = "Prazo interno do sistema, mais curto que o prazo legal (RGPD: um mês, art. 12.º, n.º 3).";

  it("passado o mês, o rodapé diz que o prazo do art. 12.º, n.º 3 venceu", async () => {
    const { html, text, subject } = await alarme({
      country: "PT",
      recebido: RECEBIDO_HA_MAIS_DE_UM_MES,
    });

    expect(html).toContain(VENCEU);
    expect(text).toContain(VENCEU);
    expect(`${subject}\n${html}\n${text}`).not.toContain("mais curto que o prazo legal");
  });

  it("ANTES do mês o rodapé continua como era, palavra por palavra", async () => {
    const { html, text } = await alarme({ country: "PT", recebido: RECEBIDO_HA_MENOS_DE_UM_MES });

    expect(html).toContain(AINDA_HA_FOLGA);
    expect(text).toContain(AINDA_HA_FOLGA);
    expect(`${html}\n${text}`).not.toContain("venceu");
  });

  it("o mês é de CALENDÁRIO: 31/01 vence no fim de fevereiro, não em 03/03", async () => {
    const recebido = "2026-01-31T12:00:00.000Z";

    const antes = await alarme({ country: "PT", recebido, agora: "2026-02-28T11:00:00.000Z" });
    expect(antes.text).toContain(AINDA_HA_FOLGA);

    // O último dia legal ainda NÃO venceu às 13h: vale até o fim do dia.
    const noUltimoDia = await alarme({ country: "PT", recebido, agora: "2026-02-28T13:00:00.000Z" });
    expect(noUltimoDia.text).toContain(AINDA_HA_FOLGA);

    const depois = await alarme({ country: "PT", recebido, agora: "2026-03-01T00:00:00.000Z" });
    expect(depois.text).toContain(VENCEU);
  });

  /**
   * O PRAZO EM MESES ACABA NO FIM DO DIA, NÃO NA HORA DO RECEBIMENTO.
   *
   * O Regulamento (CEE) n.º 1182/71 conta prazo em meses até o FIM do dia que
   * corresponde ao dia do evento inicial: pedido recebido em 20/08 às 12h tem o
   * mês do art. 12.º, n.º 3 até o fim de 20/09 — não até as 12h de 20/09. A
   * versão anterior somava um mês ao INSTANTE (`setUTCMonth` na mesma hora) e o
   * alarme anunciava vencimento legal com o dia legal ainda correndo, na mesma
   * tela em que `due_at` era lido como dia civil que vale até o fim do dia.
   * Duas réguas para o mesmo prazo.
   */
  it("o mês legal vale até o FIM do dia correspondente, não até a hora do recebimento", async () => {
    const recebido = "2026-08-20T12:00:00.000Z";

    const noUltimoDia = await alarme({ country: "PT", recebido, agora: "2026-09-20T23:30:00.000Z" });
    expect(noUltimoDia.text).toContain(AINDA_HA_FOLGA);

    const diaSeguinte = await alarme({ country: "PT", recebido, agora: "2026-09-21T00:00:00.000Z" });
    expect(diaSeguinte.text).toContain(VENCEU);
  });

  it("país sem lei revisada não afirma vencimento de lei nenhuma", async () => {
    PERFIS_DO_PAIS.XI = XISTAO;
    try {
      const { text } = await alarme({ country: "XI", recebido: RECEBIDO_HA_MAIS_DE_UM_MES });

      expect(text).toContain("Prazo interno do sistema, mais curto que o prazo legal.");
      expect(text).not.toMatch(/RGPD|LGPD|venceu/);
    } finally {
      delete PERFIS_DO_PAIS.XI;
    }
  });

  it("o apagamento da loja continua com o prazo interno, sem prazo legal", async () => {
    const { text } = await alarme({
      country: "PT",
      recebido: RECEBIDO_HA_MAIS_DE_UM_MES,
      tipo: "store_redact",
    });

    expect(text).toContain("Prazo interno do sistema.");
    expect(text).not.toMatch(/RGPD|venceu/);
  });
});

describe("item 2 — o alarme é por IDIOMA do destinatário, não por país", () => {
  it("Portugal fala pt-PT: o lang deixa de ser o pt-BR de mentira", async () => {
    const { html, text } = await alarme({ country: "PT" });

    expect(html).toContain('<html lang="pt-PT">');
    expect(html).not.toContain('lang="pt-BR"');
    // Português: o "Acesse:" é a frase certa, não um vazamento.
    expect(text).toContain("Acesse:");
  });

  it("país que não fala português recebe o lang E o texto na língua dele", async () => {
    const { html, text, subject } = await alarme({ country: "SL" });

    expect(html).toContain('<html lang="es">');
    expect(html).not.toContain('lang="pt-BR"');
    expect(html).not.toContain("Acesse:");
    expect(text).toContain("Acceda:");
    expect(text).toContain("[Solicitud del interesado]");
    expect(subject).toContain("Solicitud 22222222 próxima al vencimiento");
    expect(text).toContain(
      "La solicitud #22222222 de Empresa <B> alcanzó el umbral D+5 (acceso a datos).",
    );
    expect(html).toContain("Ver solicitud en el panel");
    expect(html).toContain("Hola,");
    expect(html).toContain("Estado actual:");
    // A LEI não é do idioma: continua vindo do país (aqui, o RGPD de Portugal).
    expect(text).toContain("RGPD");
    // Nada de português sobrando no corpo de quem lê espanhol.
    expect(`${subject}\n${html}\n${text}`).not.toContain("mais curto que o prazo legal");
    expect(text).not.toContain("Ver solicitação no painel");
  });

  it("o Brasil fala pt-BR: o lang e o Acesse: continuam os de sempre", async () => {
    const { html, text } = await alarme({ country: "BR" });

    expect(html).toContain('<html lang="pt-BR">');
    expect(text).toContain("Acesse:");
    expect(text).toContain("[LGPD]");
  });

  it("país sem lei revisada e que não fala português: idioma sim, lei não", async () => {
    PERFIS_DO_PAIS.XT = { ...XISTAO, codigo: "XT", idioma: "es" };
    try {
      const { html, text } = await alarme({ country: "XT" });

      expect(html).toContain('<html lang="es">');
      expect(text).toContain("Plazo interno del sistema, más corto que el plazo legal.");
      expect(text).not.toMatch(/RGPD|LGPD/);
    } finally {
      delete PERFIS_DO_PAIS.XT;
    }
  });
});

/**
 * O nome da organização é texto de quem cadastrou. Como string de substituição
 * do `replace`, `$$`, `$&` e `$'` são PADRÕES, não caracteres: o Brasil saía
 * "Ca$h Store" e "Loja {org} Cia". E `{limiar}` no nome era trocado pelo limiar
 * quando o nome entrava antes dele. O nome tem de chegar verbatim.
 */
describe("o nome da organização chega verbatim, com `$` e chaves", () => {
  const html = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  for (const nome of ["Ca$$h Store", "Loja $& Cia", "A$'B", "{limiar} Ltda"]) {
    it(`BR: "${nome}" sai igual no texto e no HTML`, async () => {
      const email = await alarme({ country: "BR", nome });
      expect(email.text).toContain(`A solicitação LGPD #22222222 de ${nome} atingiu o limiar D+5 (acesso a dados).`);
      expect(email.html).toContain(
        `A solicitação LGPD <strong>#22222222</strong> de <strong>${html(nome)}</strong> atingiu o limiar <strong>D+5 (acesso a dados)</strong>.`,
      );
    });
  }
});
