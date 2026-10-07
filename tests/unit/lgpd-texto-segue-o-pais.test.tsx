/**
 * O QUE O TITULAR E O ENCARREGADO LEEM SEGUE O PAÍS DA ORGANIZAÇÃO — e o
 * Brasil fica byte a byte igual (doc 88, Portugal no seletor).
 *
 * Antes deste PR o e-mail ao titular e o alarme ao encarregado traziam a LGPD
 * escrita em duro. Com Portugal no seletor, o PDF citaria o RGPD e o e-mail que
 * o acompanha diria "LGPD Lei nº 13.709/2018" ao mesmo titular.
 *
 * ─── O Brasil é comparado com o que ele produzia ANTES ─────────────────────
 *
 * Os arquivos em `tests/fixtures/lgpd-brasil-antes-do-doc88/` foram gravados
 * rodando ESTAS mesmas entradas contra o código anterior à mudança (origin/main
 * @ c85293f05). Comparar com eles, e não com uma lista de trechos, é o que
 * prova "byte a byte": um trecho conferido deixa passar o resto do texto.
 *
 * Exceção deliberada: `pdf-textos-cpf-da-conversa-e-aviso.txt` foi REGRAVADO
 * no PR #2355 (issue #2341), que troca no Brasil também o ponteiro "valor no
 * arquivo de dados" pelo CPF mascarado. Essa linha não é mais a de antes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enviados = vi.hoisted(() => [] as Array<{ subject: string; html: string; text: string }>);
const banco = vi.hoisted(() => ({ org: {} as Record<string, unknown> }));
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
/** Banco falso: `organizations` devolve a linha do teste; toda outra tabela, vazio. */
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

import { PERFIS_DO_PAIS, perfilDoPais, type PerfilDoPais } from "@/lib/legal/perfil-do-pais";
import { sendExportEmail } from "@/lib/lgpd/email-delivery";
import { collectExportData, type ExportPayload } from "@/lib/lgpd/export-collector";
import { LgpdExportPdf } from "@/lib/lgpd/pdf-renderer";
import { triggerSlaAlarm, type AlarmThreshold } from "@/lib/lgpd/sla-alarm";
import type { LgpdRequest } from "@/lib/lgpd/types";

const FIXTURES = join(__dirname, "..", "fixtures", "lgpd-brasil-antes-do-doc88");
const fixture = (nome: string) => readFileSync(join(FIXTURES, nome), "utf8");

const MARCA = {
  nome: "Silva & Filhos",
  logoUrl: null,
  accent: "#2f6f4e",
  accentFg: "#ffffff",
  origens: { nome: "banco", cor: "banco" },
} as const;

/** País sintético SEM lei revisada: prova que o ramo não-BR não inventa lei. */
const XISTAO: PerfilDoPais = { ...perfilDoPais("PT"), codigo: "XI", nome: "Xistão", lei: null };

beforeEach(() => {
  enviados.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
  PERFIS_DO_PAIS.XI = XISTAO;
});
afterEach(() => {
  vi.useRealTimers();
  delete PERFIS_DO_PAIS.XI;
});

async function emailPara(perfil: PerfilDoPais, fuso?: string) {
  await sendExportEmail({
    to: "titular@x.test",
    requestId: "3f2a9c10-0000-4000-8000-000000000001",
    signedUrl: "https://storage.test/report.pdf?token=abc",
    signedUrlDados: "https://storage.test/data.json?token=abc",
    expiresAt: new Date("2026-10-08T12:00:00.000Z"),
    marca: MARCA,
    perfil,
    fuso,
  });
  return enviados[0]!;
}

const ALARMES: ReadonlyArray<readonly [AlarmThreshold, string]> = [
  ["data_request_d5", "2026-10-01"],
  ["redact_d10", "2026-10-20"],
];

async function alarmesPara(country: string | null, tipo?: string) {
  const saida = [];
  for (const [threshold, due] of ALARMES) {
    enviados.length = 0;
    await triggerSlaAlarm({
      request: {
        id: "22222222-2222-4222-8222-222222222222",
        organization_id: "org-1",
        request_type: tipo ?? (threshold === "data_request_d5" ? "data_request" : "redact"),
        status: "pending",
        attempts: 0,
        received_at: "2026-09-20T12:00:00.000Z",
        due_at: due,
        request_payload: {},
      } as unknown as LgpdRequest,
      threshold,
      organizationDpoEmail: "dpo@x.test",
      organizationName: "Empresa <B>",
      marca: MARCA,
      country,
    });
    saida.push(enviados[0]!);
  }
  return saida;
}

async function dataJson(country: string | null, timezone: string, pais?: string | null) {
  banco.org = {
    legal_name: "Bem Viver LTDA",
    display_name: "Bem Viver",
    dpo_email: "dpo@bv.test",
    country,
    timezone,
  };
  const pedido = {
    organizationId: "org-1",
    requestId: "r1",
    externalCustomerId: null,
    ...(pais === undefined ? {} : { pais }),
  };
  const vazio = await collectExportData({ ...pedido, contactId: null });
  const cheio = await collectExportData({ ...pedido, contactId: "c1" });
  return { vazio, cheio };
}

/** O JSON como o worker o grava (`JSON.stringify(data, null, 2)`), sem o relógio. */
const comoGravado = (p: ExportPayload) => JSON.stringify({ ...p, generated_at: "X" }, null, 2);

function textos(no: ReactNode): string[] {
  if (no === null || no === undefined || typeof no === "boolean") return [];
  if (typeof no === "string") return [no];
  if (typeof no === "number") return [String(no)];
  if (Array.isArray(no)) return no.flatMap(textos);
  const el = no as ReactElement<{ children?: ReactNode }>;
  if (el.props && "children" in el.props) return textos(el.props.children);
  return [];
}

function pdfDe(
  base: ExportPayload,
  extra: { contato?: Record<string, unknown>; unsignedWarning?: boolean } = {},
): string[] {
  return textos(
    LgpdExportPdf({
      unsignedWarning: extra.unsignedWarning,
      data: {
        ...base,
        generated_at: "2026-10-05T12:34:56.000Z",
        contact: {
          id: "c1",
          full_name: "Ana",
          email: "ana@x.test",
          phone_number: "+5511999998888",
          cpf: "52998224725",
          // Onde a pergunta de roteiro do tipo `cpf` grava: é de lá que o PDF
          // lê o valor que imprime mascarado (issue #2341).
          custom_fields: { cpf: "52998224725" },
          source: "whatsapp",
          created_at: "2026-01-02T03:04:05.000Z",
          is_anonymized: false,
          ...extra.contato,
        } as never,
        consents: [{ scope: "marketing", granted: true, granted_at: "2026-02-03T04:05:06.000Z" } as never],
      },
    }),
  );
}

describe("e-mail ao titular", () => {
  it("Brasil: igual, byte a byte, ao que saía antes do doc 88", async () => {
    expect(JSON.stringify(await emailPara(perfilDoPais("BR")), null, 2)).toBe(fixture("email.json"));
  });

  it("Portugal: pt-PT, sem LGPD, citando o RGPD como direito exercido", async () => {
    const { subject, html, text } = await emailPara(perfilDoPais("PT"), "Europe/Lisbon");
    const tudo = `${subject}\n${html}\n${text}`;
    expect(tudo).not.toMatch(/LGPD|13\.709/);
    expect(html).toContain('<html lang="pt-PT">');
    expect(subject).toBe("Pedido de acesso aos seus dados pessoais #3f2a9c10");
    expect(html).toContain("Descarregar relatório");
    for (const corpo of [html, text])
      expect(corpo).toContain(
        "Direito exercido: acesso aos dados pessoais, RGPD art. 15.º (Regulamento (UE) 2016/679).",
      );
  });

  it("Portugal: o prazo do link sai no fuso da organização, com o nome do fuso", async () => {
    // 12:00 UTC de 08/10 é 13:00 em Lisboa (horário de verão); em São Paulo
    // seria 09:00 — o horário que o e-mail fixo mostrava a quem está em Lisboa.
    const { text } = await emailPara(perfilDoPais("PT"), "Europe/Lisbon");
    const linha = text.split("\n").find((l) => l.startsWith("A ligação expira em"))!;
    expect(linha).toContain("13:00:00");
    expect(linha).not.toContain("09:00:00");
    expect(linha).toMatch(/GMT\+1|WEST/);
  });

  it("país sem lei revisada: nenhuma lei citada, nem a brasileira", async () => {
    const { subject, html, text } = await emailPara(XISTAO, "Europe/Lisbon");
    const tudo = `${subject}\n${html}\n${text}`;
    expect(tudo).not.toMatch(/LGPD|13\.709|RGPD|Direito exercido/);
  });
});

describe("alarme ao encarregado", () => {
  it("Brasil: igual, byte a byte, nos dois limiares", async () => {
    expect(JSON.stringify(await alarmesPara(null), null, 2)).toBe(fixture("alarmes.json"));
    // `BR` escrito é o mesmo Brasil que a coluna vazia.
    expect(JSON.stringify(await alarmesPara("BR"), null, 2)).toBe(fixture("alarmes.json"));
  });

  it("Portugal: sem LGPD; prazo declarado interno e mais curto que o do RGPD", async () => {
    for (const { subject, html, text } of await alarmesPara("PT")) {
      expect(`${subject}\n${html}\n${text}`).not.toMatch(/LGPD|13\.709|Base legal/);
      expect(subject).toMatch(/^\[Pedido de titular\] /);
      for (const corpo of [html, text])
        expect(corpo).toContain(
          "Prazo interno do sistema, mais curto que o prazo legal (RGPD: um mês, art. 12.º, n.º 3).",
        );
    }
  });

  it("Brasil: o apagamento da loja sai igual, byte a byte, ao de antes", async () => {
    expect(JSON.stringify(await alarmesPara(null, "store_redact"), null, 2)).toBe(
      fixture("alarmes-store-redact.json"),
    );
  });

  it("Portugal: o apagamento da loja não é pedido de titular nem leva o prazo do RGPD", async () => {
    // `store_redact` é a Nuvemshop avisando que o lojista desinstalou o app; o
    // art. 12.º, n.º 3 rege só os pedidos dos arts. 15.º a 22.º.
    for (const { subject, html, text } of await alarmesPara("PT", "store_redact")) {
      const tudo = `${subject}\n${html}\n${text}`;
      expect(subject).toMatch(/^\[Apagamento da loja\] /);
      expect(tudo).not.toMatch(/Pedido de titular|RGPD|LGPD|13\.709/);
      expect(text).toContain("Prazo interno do sistema.");
    }
  });

  it("país sem lei revisada: o prazo é interno e nenhuma lei é afirmada", async () => {
    for (const { subject, html, text } of await alarmesPara("XI")) {
      const tudo = `${subject}\n${html}\n${text}`;
      expect(tudo).not.toMatch(/LGPD|13\.709|RGPD/);
      expect(text).toContain("Prazo interno do sistema, mais curto que o prazo legal.");
    }
  });
});

describe("data.json e PDF de acesso", () => {
  it("Brasil: o data.json é o de antes, sem `lei_rotulo` nem `fuso`", async () => {
    const { vazio, cheio } = await dataJson(null, "America/Sao_Paulo");
    expect(comoGravado(vazio)).toBe(fixture("data-vazio.json"));
    expect(comoGravado(cheio)).toBe(fixture("data-cheio.json"));
    for (const p of [vazio, cheio]) {
      expect(Object.keys(p)).not.toContain("lei_rotulo");
      expect(Object.keys(p)).not.toContain("fuso");
    }
  });

  it("Portugal: o data.json leva o rótulo e o fuso da organização", async () => {
    const { vazio, cheio } = await dataJson("PT", "Europe/Lisbon");
    for (const p of [vazio, cheio]) {
      expect(p.lei_citada).toBe("RGPD art. 15.º (Regulamento (UE) 2016/679)");
      expect(p.lei_rotulo).toBe("Direito exercido");
      expect(p.fuso).toBe("Europe/Lisbon");
    }
  });

  it("Brasil: o texto do PDF é o de antes, com \"Base legal\"", async () => {
    const { cheio } = await dataJson(null, "America/Sao_Paulo");
    expect(pdfDe(cheio).join("\u0001")).toBe(fixture("pdf-textos.txt"));
  });

  it("Brasil: CPF informado na conversa sai mascarado (#2341) e o aviso de assinatura sai como antes", async () => {
    const { cheio } = await dataJson(null, "America/Sao_Paulo");
    const pdf = pdfDe(cheio, { contato: { cpf_informado_na_conversa: true }, unsignedWarning: true });
    expect(pdf.join("\u0001")).toBe(fixture("pdf-textos-cpf-da-conversa-e-aviso.txt"));
  });

  it("Portugal: o CPF que veio da conversa é chamado de CPF, não de NIF", async () => {
    // O valor só vem da pergunta de roteiro do tipo `cpf`, validada como CPF.
    const { cheio } = await dataJson("PT", "Europe/Lisbon");
    const pdf = pdfDe(cheio, { contato: { cpf_informado_na_conversa: true } });
    const i = pdf.indexOf("Informado na conversa (***.***.*47-25)");
    expect(pdf.slice(i - 2, i)).toEqual(["CPF", ":"]);
    // O que está guardado na coluna, numa organização portuguesa, é o NIF.
    const guardado = pdfDe(cheio, { contato: { cpf_present: true } });
    const j = guardado.indexOf("Armazenado (criptografado)");
    expect(guardado.slice(j - 2, j)).toEqual(["NIF", ":"]);
  });

  it("Portugal: o aviso de assinatura pendente não nomeia a LGPD", async () => {
    const { cheio } = await dataJson("PT", "Europe/Lisbon");
    const tudo = pdfDe(cheio, { unsignedWarning: true }).join(" ");
    expect(tudo).toContain("ASSINATURA DIGITAL PAdES PENDENTE");
    expect(tudo).not.toMatch(/LGPD/);
  });

  it("o país resolvido pelo worker vale sobre o lido no coletor: PDF e e-mail têm a mesma lei", async () => {
    // A linha da organização diz Brasil; o worker já resolveu Portugal.
    const { cheio } = await dataJson("BR", "Europe/Lisbon", "PT");
    expect(cheio.lei_citada).toBe("RGPD art. 15.º (Regulamento (UE) 2016/679)");
    expect(cheio.documento_rotulo).toBe("NIF");
    const { cheio: semPais } = await dataJson("BR", "America/Sao_Paulo");
    expect(comoGravado(semPais)).toBe(fixture("data-cheio.json"));
  });

  it("o worker lê o país uma vez e passa o mesmo perfil ao coletor e ao e-mail", () => {
    const fonte = readFileSync(join(__dirname, "..", "..", "workers", "lgpd-export-worker.ts"), "utf8");
    expect(fonte.match(/perfilDaOrganizacao\(/g)).toHaveLength(1);
    expect(fonte).toMatch(/pais:\s*perfil\.codigo/);
    expect(fonte).toMatch(/sendExportEmail\(\{[^}]*\bperfil,/);
  });

  it("Portugal: o PDF diz \"Direito exercido\" e as datas saem no fuso de Lisboa", async () => {
    const { cheio } = await dataJson("PT", "Europe/Lisbon");
    const tudo = pdfDe(cheio).join(" ").replace(/\s+/g, " ");
    expect(tudo).toContain("Direito exercido: RGPD art. 15.º (Regulamento (UE) 2016/679)");
    expect(tudo).not.toContain("Base legal");
    // 12:34:56 UTC de 05/10 é 13:34:56 em Lisboa; em São Paulo seria 09:34:56.
    expect(tudo).toContain("13:34:56");
    expect(tudo).not.toContain("09:34:56");
  });
});
