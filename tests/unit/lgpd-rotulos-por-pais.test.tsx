/**
 * OS RÓTULOS LEGAIS SEGUEM O PAÍS DA ORGANIZAÇÃO — nos DOIS lados (#2344).
 *
 * ─── O que estava errado ────────────────────────────────────────────────────
 *
 * Uma organização de Portugal recebia o relatório de acesso do RGPD no
 * vocabulário da LGPD brasileira: o rodapé dizia "Controlador" e "Encarregado
 * (DPO)", quando o RGPD em pt-PT chama os mesmos papéis de "responsável pelo
 * tratamento" (art. 4.º, n.º 7) e "encarregado da proteção de dados" (art.
 * 37.º). A política de privacidade da instalação fazia o mesmo, e ainda
 * imprimia "CNPJ" para o número que em Portugal é NIPC.
 *
 * No Brasil o outro lado do mesmo defeito: o rodapé rotulava a citação de
 * "Base legal", mas o art. 18 da LGPD é um DIREITO do titular — a base legal
 * fica nos arts. 7 e 11. Portugal já rotulava "Direito exercido" (doc 88).
 *
 * ─── O que cada caso prova ──────────────────────────────────────────────────
 *
 * 1. Portugal: o payload carrega os papéis do RGPD, o PDF os imprime, o
 *    `data.json` os leva, e a política cita RGPD e NIPC — sem nenhum termo
 *    brasileiro à vista;
 * 2. Brasil: o payload continua SEM as chaves novas (doc 88), o PDF continua
 *    com "Controlador" e "Encarregado (DPO)", a política continua com
 *    controlador, CNPJ e LGPD — e a citação ganha o rótulo certo de direito.
 *
 * Sem este arquivo os dois casos são VERMELHOS: o rodapé português sai com os
 * papéis brasileiros e o brasileiro continua com "Base legal".
 */
import type { ReactElement, ReactNode } from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Banco falso: `organizations` devolve a linha do teste; o resto, vazio. */
const banco = vi.hoisted(() => ({ org: {} as Record<string, unknown> }));
/** O operador da política pública, resolvido por teste. */
const operador = vi.hoisted(() => ({
  valor: {
    sistema: "Marca da Revenda",
    nome: "Silva & Filhos",
    razaoSocial: "Silva & Filhos ME",
    cnpj: null as string | null,
    dpoEmail: "dpo@sf.test",
    politicaPropria: null as string | null,
    resolvido: true,
    pais: null as string | null,
  },
}));

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.test" } }));
vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: async () => ({ valor: "" }) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const consulta = (tabela: string): unknown => {
      const q: unknown = new Proxy(
        {},
        {
          get(_, prop) {
            if (prop === "then")
              return (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) =>
                Promise.resolve({
                  data: tabela === "organizations" ? [banco.org] : [],
                  error: null,
                  count: 0,
                }).then(ok, erro);
            if (prop === "maybeSingle" || prop === "single")
              return async () => ({ data: tabela === "organizations" ? banco.org : null, error: null });
            return () => q;
          },
        },
      );
      return q;
    };
    return { from: consulta, rpc: async () => ({ data: null, error: null }) };
  },
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((destino: string) => {
    throw new Error(`NEXT_REDIRECT:${destino}`);
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
vi.mock("@/lib/i18n/idiomaAnonimo", () => ({ idiomaDoVisitante: async () => "pt-BR" }));
vi.mock("@/lib/legal/operador", () => ({
  resolverOperador: async () => operador.valor,
  nomeDoOperador: () => operador.valor.razaoSocial ?? "o operador desta instalação",
}));

import PrivacyPage from "@/app/legal/privacy/page";
import { collectExportData, type ExportPayload } from "@/lib/lgpd/export-collector";
import { LgpdExportPdf } from "@/lib/lgpd/pdf-renderer";

/** O payload da organização do país escolhido, pelo coletor de verdade. */
async function payloadDe(country: string | null): Promise<ExportPayload> {
  banco.org = {
    legal_name: "Silva & Filhos ME",
    display_name: "Silva & Filhos",
    dpo_email: "dpo@sf.test",
    country,
    timezone: country === "PT" ? "Europe/Lisbon" : "America/Sao_Paulo",
  };
  return await collectExportData({
    organizationId: "org-1",
    requestId: "r1",
    externalCustomerId: null,
    contactId: null,
  });
}

function textos(no: ReactNode): string[] {
  if (no === null || no === undefined || typeof no === "boolean") return [];
  if (typeof no === "string") return [no];
  if (typeof no === "number") return [String(no)];
  if (Array.isArray(no)) return no.flatMap(textos);
  const el = no as ReactElement<{ children?: ReactNode }>;
  if (el.props && "children" in el.props) return textos(el.props.children);
  return [];
}

/** O PDF como texto, com os espaços do parser colapsados. */
function pdfDe(payload: ExportPayload): string {
  return textos(
    LgpdExportPdf({
      data: { ...payload, generated_at: "2026-10-05T12:34:56.000Z", contact: null },
    }),
  )
    .join(" ")
    .replace(/\s+/g, " ");
}

/** A política de privacidade pública, com o operador do teste. */
async function politica(pais: string | null, cnpj: string | null): Promise<string> {
  operador.valor = { ...operador.valor, pais, cnpj };
  const { container } = render(await PrivacyPage());
  return container.textContent ?? "";
}

beforeEach(() => {
  operador.valor = { ...operador.valor, pais: null, cnpj: null };
});

describe("Portugal: o titular e o operador leem os termos do RGPD", () => {
  it("o PDF chama os papéis pelo nome do RGPD e a citação de direito exercido", async () => {
    const payload = await payloadDe("PT");

    // O `data.json` português leva os rótulos do país (o brasileiro continua
    // sem as chaves, pelo `foraDoBrasil`).
    expect(payload.papel_controlador).toBe("Responsável pelo tratamento");
    expect(payload.papel_encarregado).toBe("Encarregado da proteção de dados");
    expect(payload.lei_rotulo).toBe("Direito exercido");

    const pdf = pdfDe(payload);
    expect(pdf).toContain("Responsável pelo tratamento: Silva & Filhos ME");
    expect(pdf).toContain("Encarregado da proteção de dados: dpo@sf.test");
    expect(pdf).toContain("Direito exercido: RGPD art. 15.º (Regulamento (UE) 2016/679)");
    expect(pdf, "o rodapé ainda chama os papéis pela lei brasileira").not.toMatch(
      /Controlador:|Encarregado \(DPO\)/,
    );
  });

  it("a política da instalação cita RGPD e NIPC, sem nenhum termo brasileiro", async () => {
    const texto = await politica("PT", "509 234 115");

    expect(texto).toContain("1. Quem é o responsável pelo tratamento");
    expect(texto).toContain("(NIPC 509 234 115)");
    expect(texto).toContain("O RGPD garante-lhe confirmar se há tratamento");
    expect(texto).toContain("fale com o encarregado da proteção de dados:");
    expect(texto, "a política portuguesa ainda fala a língua da LGPD").not.toMatch(
      /LGPD|CNPJ|controlador/i,
    );
  });
});

describe("Brasil: os termos continuam os da LGPD, e a citação é rotulada de direito", () => {
  it("o PDF mantém Controlador e Encarregado (DPO), e rotula a citação de direito exercido", async () => {
    const payload = await payloadDe(null);

    // Doc 88: o `data.json` brasileiro não ganha chave nova — o rótulo sai do
    // PERFIL do Brasil no renderizador.
    expect(payload.papel_controlador).toBeUndefined();
    expect(payload.papel_encarregado).toBeUndefined();
    expect(payload.lei_rotulo).toBeUndefined();

    const pdf = pdfDe(payload);
    expect(pdf).toContain("Controlador: Silva & Filhos ME");
    expect(pdf).toContain("Encarregado (DPO): dpo@sf.test");
    expect(pdf).toContain("Direito exercido: LGPD Art. 18, II (Lei nº 13.709/2018)");
    expect(pdf, "o art. 18 da LGPD é um direito, não uma base legal").not.toContain("Base legal");
  });

  it("a política continua a de antes: controlador, CNPJ e LGPD", async () => {
    const texto = await politica(null, "12.345.678/0001-90");

    expect(texto).toContain("1. Quem é o controlador");
    expect(texto).toContain("(CNPJ 12.345.678/0001-90)");
    expect(texto).toContain("A LGPD garante a você confirmar se há tratamento");
    expect(texto).toContain("fale com o encarregado de dados:");
  });
});
