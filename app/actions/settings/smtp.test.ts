/**
 * A TELA DE /admin/email NÃO DEVOLVE O TEXTO CRU DO POSTGRES (issue #2804).
 *
 * O defeito medido: salvar um servidor SMTP com `_` no endereço (o nome do
 * contêiner de um relé rodando na própria VPS) batia na CHECK
 * `platform_smtp_settings_host` e o toast mostrava
 *
 *   new row for relation "platform_smtp_settings" violates check constraint ...
 *
 * O conserto tem duas metades, e as duas são medidas aqui:
 *
 *   1. a action valida o formato ANTES de qualquer escrita (espelhando a CHECK,
 *      que segue sendo a fonte da verdade no banco);
 *   2. `saveSmtpConfig` mapeia a violação prevista para a mensagem do campo e
 *      qualquer outro erro para a genérica — o texto do banco fica SÓ no log do
 *      servidor, nunca no toast.
 *
 * A action roda de VERDADE (com o `lib/email/config` real): o banco é a única
 * borda dublada, então o caminho testado é o mesmo que a tela percorre.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  escrita: vi.fn(),
  audit: vi.fn(),
  log: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({
  requirePlatformAdminEscrita: deps.escrita,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/logger", () => ({
  logger: { error: deps.log, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { smtp_password_encrypted: null }, error: null }),
        }),
      }),
      upsert: (...args: unknown[]) => deps.upsert(...args),
    }),
    rpc: async () => ({ data: null, error: null }),
  }),
}));

import {
  FONTE_DO_FORMATO_DO_ENDERECO,
  MENSAGEM_DA_FALHA_AO_SALVAR_SMTP,
  MENSAGEM_DO_ENDERECO_DE_SERVIDOR,
  MENSAGEM_DO_REMETENTE_INVALIDO,
} from "@/lib/email/config";
import { updateSmtp } from "./smtp";

/** O caso da issue, ipsis litteris. */
const ENDERECO_DO_RELATO = "supabase_inbucket_deskcomm-crm";

type EntradaDoFormulario = {
  host: string;
  port: string;
  security: "starttls" | "tls" | "none";
  username: string;
  password: string;
  from_email: string;
  from_name: string;
};

const entrada = (extra: Partial<EntradaDoFormulario> = {}): EntradaDoFormulario => ({
  host: "smtp.empresa.com",
  port: "587",
  security: "starttls",
  username: "nao-responda@empresa.com",
  password: "",
  from_email: "nao-responda@empresa.com",
  from_name: "Empresa",
  ...extra,
});

const erroDeViolacao = (constraint: string) => ({
  code: "23514",
  message: `new row for relation "platform_smtp_settings" violates check constraint "${constraint}"`,
  details: null,
  hint: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  deps.escrita.mockResolvedValue({ user: { id: "eu" } });
  deps.upsert.mockResolvedValue({ error: null });
});

describe("o endereço do servidor SMTP não chega cru à tela (issue #2804)", () => {
  it("⭐ o `_` do nome de contêiner (o caso do relato) é ACEITO — decisão do item 2", async () => {
    const r = await updateSmtp(entrada({ host: ENDERECO_DO_RELATO }));

    expect(r).toEqual({ ok: true });
    expect(deps.upsert, "o endereço aceito não chegou à escrita").toHaveBeenCalledWith(
      expect.objectContaining({ smtp_host: ENDERECO_DO_RELATO }),
      expect.anything(),
    );
  });

  it("relé local com `_` (meu_relay) também é aceito", async () => {
    const r = await updateSmtp(entrada({ host: "meu_relay" }));

    expect(r).toEqual({ ok: true });
    expect(deps.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ smtp_host: "meu_relay" }),
      expect.anything(),
    );
  });

  it("espaço, barra e esquema CONTINUAM recusados antes da escrita, sem texto do banco", async () => {
    for (const host of ["https://smtp.empresa.com", "smtp.empresa.com/", "smtp empresa.com"]) {
      const r = await updateSmtp(entrada({ host }));
      expect(r, host).toEqual({ ok: false, error: MENSAGEM_DO_ENDERECO_DE_SERVIDOR });
    }
    expect(deps.upsert).not.toHaveBeenCalled();
  });

  it("cair na constraint do host (corrida com o banco) ainda sai como a mensagem do campo, e o cru fica no log", async () => {
    deps.upsert.mockResolvedValue({ error: erroDeViolacao("platform_smtp_settings_host") });

    const r = await updateSmtp(entrada());

    expect(r).toEqual({ ok: false, error: MENSAGEM_DO_ENDERECO_DE_SERVIDOR });
    expect(JSON.stringify(r)).not.toContain("check constraint");
    // O texto inteiro existe — no log do servidor, que é onde alguém age nele.
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining("[email.config]"),
      expect.objectContaining({ detail: expect.stringContaining("platform_smtp_settings_host") }),
    );
  });

  it("a constraint do remetente tem mensagem própria", async () => {
    deps.upsert.mockResolvedValue({ error: erroDeViolacao("platform_smtp_settings_from_email") });

    const r = await updateSmtp(entrada());

    expect(r).toEqual({ ok: false, error: MENSAGEM_DO_REMETENTE_INVALIDO });
  });

  it("erro inesperado do banco vira a genérica — nenhum texto do Postgres na resposta", async () => {
    deps.upsert.mockResolvedValue({
      error: { code: "08006", message: "connection failure", details: null, hint: null },
    });

    const r = await updateSmtp(entrada());

    expect(r).toEqual({ ok: false, error: MENSAGEM_DA_FALHA_AO_SALVAR_SMTP });
    expect(JSON.stringify(r)).not.toContain("connection failure");
    expect(deps.log).toHaveBeenCalled();
  });

  it("endereço válido salva (aparado) e não confunde sucesso com recusa", async () => {
    const r = await updateSmtp(entrada({ host: "  smtp.empresa.com  " }));

    expect(r).toEqual({ ok: true });
    expect(deps.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ smtp_host: "smtp.empresa.com" }),
      expect.anything(),
    );
    expect(deps.audit).toHaveBeenCalled();
  });

  it("endereço vazio continua sendo o 'apagar' que a constraint aceita como NULL", async () => {
    const r = await updateSmtp(entrada({ host: "" }));

    expect(r).toEqual({ ok: true });
    expect(deps.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ smtp_host: null }),
      expect.anything(),
    );
  });
});

/**
 * A régua da tela e a do banco são a MESMA (guarda trazida do #3227, de
 * @webtecnica). São três cópias — `lib/email/config.ts`, a migration 0669 e o
 * apêndice do baseline — e uma que ande sozinha devolve o defeito da #2804: a
 * tela aceita, o banco recusa, ou o contrário.
 *
 * No baseline há DUAS ocorrências da constraint: a do dump (velha, sem `_`) e a
 * do apêndice (a que vale, porque o apêndice roda por último). Só a ÚLTIMA é
 * comparada. A 0333 fica de fora: é a régua antiga, que a 0669 substitui.
 */
describe("a régua da tela e a do banco são a mesma (#2804)", () => {
  const CHECK_DO_HOST =
    /(?:add )?constraint platform_smtp_settings_host\s+check \(smtp_host is null or smtp_host ~ '([^']+)'\)/g;

  function ultimoFormatoNoSql(arquivo: string): string | undefined {
    const conteudo = readFileSync(join(process.cwd(), arquivo), "utf8");
    return [...conteudo.matchAll(CHECK_DO_HOST)].at(-1)?.[1];
  }

  it.each([
    "supabase/baseline.sql",
    "supabase/migrations/20261015090000_0669_o_endereco_do_servidor_aceita_sublinhado.sql",
  ])("%s declara, por último, o mesmo formato que lib/email/config.ts", (arquivo) => {
    const formato = ultimoFormatoNoSql(arquivo);
    // Controle positivo: varredura que não acha nada não pode passar por "em ordem".
    expect(formato).toBeDefined();
    expect(formato).toBe(FONTE_DO_FORMATO_DO_ENDERECO);
  });
});
