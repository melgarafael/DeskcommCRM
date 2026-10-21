/**
 * O ENDEREÇO DO SERVIDOR É RECUSADO ANTES DE GRAVAR — E A TELA DIZ O PORQUÊ.
 *
 * ─── O defeito (#2804, medido pela tela do #2767) ───────────────────────────
 *
 * No banco fresco do baseline, salvar em `/admin/email` um servidor cujo nome
 * tem sublinhado — o nome de contêiner de um relé de e-mail na própria VPS,
 * `supabase_inbucket_deskcomm-crm` — batia na constraint
 * `platform_smtp_settings_host` (`supabase/baseline.sql`) e o toast mostrava a
 * mensagem CRUA do Postgres:
 *
 *   `new row for relation "platform_smtp_settings" violates check constraint
 *   "platform_smtp_settings_host"`
 *
 * Duas causas, e as duas medidas aqui: o Zod da action só limitava o TAMANHO
 * (`host: z.string().trim().max(253)`), então a régua do banco era descoberta
 * pelo operador; e o erro do Supabase subia para a tela sem tratamento.
 *
 * ─── O que este arquivo guarda ──────────────────────────────────────────────
 *
 *   1. endereço com sublinhado é recusado e a frase explica o formato (o
 *      defeito — este é o caso que fica VERMELHO se a validação sair);
 *   2. o mesmo vale com espaços em volta: o `trim` do Zod roda ANTES da régua,
 *      então `" …_… "` não escapa por causa do espaço;
 *   3. CONTROLE — domínio normal, com pontos e hífens, continua aceito e
 *      GRAVADO: uma recusa que recusa demais é o defeito simétrico, e trocaria
 *      um toast ruim por uma tela que não salva;
 *   4. CONTROLE — endereço VAZIO continua aceito e vira `null`: é assim que a
 *      instalação desliga o SMTP e volta ao serviço externo, e a constraint
 *      aceita (`smtp_host is null or …`);
 *   5. CONTROLE — quando o BANCO recusa, a frase é a nossa: nada de
 *      `violates check constraint` no que a tela mostra, e a causa crua vai
 *      para o log do servidor;
 *   6. a régua da action é a MESMA das duas cópias do SQL (baseline e a
 *      migration que criou a constraint) — a issue deixou aberta a decisão de
 *      aceitar `_`, e no dia em que ela for tomada os três andam juntos;
 *   7. as duas frases da recusa têm espanhol no dicionário.
 *
 * ─── Onde está o dublê ──────────────────────────────────────────────────────
 *
 * Na FRONTEIRA EXTERNA (o cliente do banco), no formato em que o Supabase
 * responde — `{ data, error }` —, e não nas funções que decidem:
 * `saveSmtpConfig` e `lerSmtp` rodam DE VERDADE. É o mesmo recorte de
 * `tests/unit/admin-avisa-sem-smtp.test.tsx`.
 *
 * Confira com: pnpm vitest run app/actions/settings/smtp-host-invalido.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";
import { FONTE_DO_FORMATO_DO_HOST } from "@/lib/email/host-do-servidor";
import { MENSAGEM_DA_RECUSA_DO_SMTP } from "@/lib/email/recusa-do-smtp";

/** A frase exata do Postgres que o operador via no toast (issue #2804). */
const MENSAGEM_CRUA_DO_POSTGRES =
  'new row for relation "platform_smtp_settings" violates check constraint "platform_smtp_settings_host"';

/** O nome de contêiner do relé — o caso real do relato. */
const HOST_COM_SUBLINHADO = "supabase_inbucket_deskcomm-crm";

const deps = vi.hoisted(() => ({
  upsert: vi.fn(),
  select: vi.fn(),
  audit: vi.fn(),
  escrita: vi.fn(),
}));

// A action passa pela `escritaDeAdminOuRecusa` (regra D), que chama este helper.
vi.mock("@/lib/auth/requirePlatformAdmin", () => ({
  requirePlatformAdminEscrita: () => deps.escrita(),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
// Irmã não medida aqui: o transporte SMTP precisa de `nodemailer` e de env, e
// nada do que este arquivo afirma passa por ela.
vi.mock("@/lib/email/smtp", () => ({ checkSmtpConfiguration: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => deps.select() }) }),
      upsert: deps.upsert,
    }),
    // `rpc` é a cifra da senha; nenhum caso daqui manda senha nova.
    rpc: async () => ({ data: null, error: null }),
  }),
}));

import { updateSmtp } from "./smtp";

const RAIZ = process.cwd();

/** Os campos que a tela manda, com o host que o caso quer medir. */
const formulario = (host: string) => ({
  host,
  port: "587",
  security: "starttls" as const,
  username: "nao-responda@exemplo.com.br",
  password: "",
  from_email: "nao-responda@exemplo.com.br",
  from_name: "Exemplo",
});

beforeEach(() => {
  vi.clearAllMocks();
  deps.escrita.mockResolvedValue({ user: { id: "eu" } });
  deps.select.mockResolvedValue({ data: null, error: null });
  deps.upsert.mockResolvedValue({ error: null });
});

describe("endereço do servidor SMTP recusado antes de gravar (#2804)", () => {
  it("o nome com sublinhado é recusado, sem chegar ao banco, com a frase do formato", async () => {
    const r = await updateSmtp(formulario(HOST_COM_SUBLINHADO));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe(MENSAGEM_DA_RECUSA_DO_SMTP.endereco);
    // A frase diz o que fazer, na língua de quem opera: o que o endereço aceita,
    // e o que fazer com o nome de contêiner que produziu o relato.
    expect(r.error).toMatch(/letras, números, pontos e hífens/);
    expect(r.error).toMatch(/sublinhado/);
    // ⚠️ E NÃO é a mensagem do banco: nenhuma gravação aconteceu para o banco
    // ter o que dizer.
    expect(deps.upsert).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("espaço em volta não escapa da régua: o trim do Zod roda antes dela", async () => {
    const r = await updateSmtp(formulario(`  ${HOST_COM_SUBLINHADO}  `));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe(MENSAGEM_DA_RECUSA_DO_SMTP.endereco);
    expect(deps.upsert).not.toHaveBeenCalled();
  });

  it("CONTROLE: domínio com pontos e hífens continua aceito e é gravado como digitado", async () => {
    const r = await updateSmtp(formulario("smtp.revenda-exemplo.com.br"));

    expect(r.ok).toBe(true);
    expect(deps.upsert).toHaveBeenCalledTimes(1);
    expect(deps.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ smtp_host: "smtp.revenda-exemplo.com.br", smtp_port: 587 }),
      { onConflict: "id" },
    );
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "platform_smtp_settings.updated" }),
    );
  });

  it("CONTROLE: endereço vazio continua aceito e vira null — a régua não passa a exigir host", async () => {
    const r = await updateSmtp(formulario(""));

    expect(r.ok).toBe(true);
    expect(deps.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ smtp_host: null }),
      { onConflict: "id" },
    );
  });

  it("CONTROLE: quando o banco recusa, a tela não vê o texto do Postgres — e o log vê", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    deps.upsert.mockResolvedValue({ error: { message: MENSAGEM_CRUA_DO_POSTGRES } });

    const r = await updateSmtp(formulario("smtp.revenda-exemplo.com.br"));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe(MENSAGEM_DA_RECUSA_DO_SMTP.gravacao);
    // O que o operador lê: nada de nome de tabela nem de constraint.
    expect(r.error).not.toMatch(/platform_smtp_settings|constraint|pg_|error/i);
    // E o que quem depura precisa continua existindo, no log do servidor.
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[admin/email]"), MENSAGEM_CRUA_DO_POSTGRES);
    expect(deps.audit).not.toHaveBeenCalled();

    log.mockRestore();
  });
});

describe("a régua da action e a do banco são a mesma (#2804, item 2 pendente)", () => {
  /** O miolo do CHECK, lido do próprio SQL — nunca de uma cópia no teste. */
  function formatoNoSql(arquivo: string): string[] {
    const conteudo = readFileSync(join(RAIZ, arquivo), "utf8");
    const achei = [
      ...conteudo.matchAll(
        /constraint platform_smtp_settings_host check \(smtp_host is null or smtp_host ~ '([^']+)'\)/g,
      ),
    ];
    return achei.map((m) => m[1]);
  }

  it.each([
    "supabase/baseline.sql",
    "supabase/migrations/20260919154000_0333_transporte_smtp_da_instalacao.sql",
  ])("%s declara o mesmo formato que lib/email/host-do-servidor.ts", (arquivo) => {
    const formatos = formatoNoSql(arquivo);
    // Controle positivo: uma varredura que não acha nada é indistinguível de
    // "está tudo em ordem" — e aqui ela tem de achar a constraint.
    expect(formatos.length).toBeGreaterThan(0);
    expect(formatos).toEqual(formatos.map(() => FONTE_DO_FORMATO_DO_HOST));
  });
});

describe("as frases da recusa são traduzíveis (#2804)", () => {
  it.each(Object.entries(MENSAGEM_DA_RECUSA_DO_SMTP))(
    "%s tem espanhol no dicionário",
    (_nome, frase) => {
      expect(DICIONARIO[frase]?.es).toBeTruthy();
    },
  );
});
