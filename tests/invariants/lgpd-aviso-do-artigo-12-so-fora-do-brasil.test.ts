/**
 * O AVISO DO ART. 12.º VALE SÓ PARA ORGANIZAÇÃO FORA DO BRASIL (#2342) — os DOIS LADOS.
 *
 * ─── A decisão de produto que este arquivo prova cumprida ─────────────────────────────────────
 *
 * Decisão de 2026-10-16: os avisos novos valem só para organizações FORA do Brasil. No Brasil
 * nada muda por enquanto, porque a promessa feita quando Portugal entrou foi "o Brasil fica
 * exatamente igual" — e texto jurídico com o artigo errado chegando a titular real é pior que
 * nenhum texto. O texto brasileiro fica para uma revisão própria.
 *
 * Isso quer dizer, do lado do WORKER, que a organização brasileira segue EXATAMENTE como na main:
 * sem e-mail e sem `art12_notice` no pedido nem no registro de auditoria. Do lado da ROTA, que a
 * organização brasileira recebe a RECUSA (o produto, não um erro) ANTES de qualquer efeito: sem
 * e-mail, com o `due_at` intacto e sem `lgpd.art12_notice_sent`.
 *
 * ─── Por que o caso roda o worker e a rota DE VERDADE ────────────────────────────────────────
 *
 * Porque o alvo aqui é a DECISÃO, e decisão dublada mede o dublê. O país não vem de um mock: vem
 * da coluna `organizations.country` do banco, lida pelo mesmo `perfilDaOrganizacao` que a
 * produção usa — o `pgComoSupabase` só troca o TRANSPORTE (PostgREST→SQL), nunca a regra. O
 * worker e o handler da rota são os reais, importados, e a cascata também: os contatos são
 * anonimizados de fato pela RPC `fn_lgpd_cascade_redact_contact`.
 *
 * O que É substituído, e por quê: o transporte de e-mail (o e-mail teria de sair para medir que
 * saiu), a auth da rota (não há cookie neste banco), `audit()` (as chamadas ficam registradas
 * para a asserção) e o logger. Nenhum deles é o alvo.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { pgComoSupabase } from "../pg-como-supabase";

type Enviado = { to: string; subject: string; html: string; text: string; tags?: unknown };
type Auditoria = { action: string; metadata?: Record<string, unknown> };

const enviados = vi.hoisted(() => [] as Enviado[]);
const auditorias = vi.hoisted(() => [] as Auditoria[]);
/** A organização que a rota vai servir nesta chamada — a auth é o único "quem" trocado. */
const estado = vi.hoisted(() => ({ orgId: "", ator: "" }));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => database }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (entrada: Auditoria) => {
    auditorias.push(entrada);
  }),
}));
vi.mock("@/lib/email/roteador", () => ({
  sendEmail: vi.fn(async (email: Enviado) => {
    enviados.push(email);
    return { ok: true, id: "m1" };
  }),
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: estado.ator, idioma: "pt-BR" },
    org: { orgId: estado.orgId },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

// Banco descartável do baseline; nenhuma conexão ao banco da instalação.
if (!process.env.TEST_DB_CONTAINER) throw new Error("rode via pnpm test:db");
const pool = new pg.Pool({
  host: "127.0.0.1",
  port: Number(process.env.TEST_DB_PORT ?? 54329),
  user: "postgres",
  password: "postgres",
  database: "postgres",
  max: 4,
});
const database = pgComoSupabase(pool);

import type { EventRow } from "@/lib/event-log/dispatcher";
import { POST as postArt12 } from "@/app/api/v1/lgpd/requests/[id]/art12/route";
import { processLgpdRedact } from "@/workers/lgpd-redact-worker";

// Namespace próprio (`0657c000-`), para não colidir com os vizinhos que rodam no
// mesmo banco efêmero (ver `vitest.db.config.ts`: um banco por arquivo, mas o
// molde é compartilhado).
const ORG_BR = "0657c000-0000-4000-8000-000000000001";
const ORG_PT = "0657c000-0000-4000-8000-000000000002";
const CONTATO_BR = "0657c000-1111-4000-8000-000000000001";
const CONTATO_PT = "0657c000-1111-4000-8000-000000000002";
/** Pedido que o WORKER processa. */
const PEDIDO_BR = "0657c000-2222-4000-8000-000000000001";
const PEDIDO_PT = "0657c000-2222-4000-8000-000000000002";
/** Pedido que a ROTA serve (fica aberto: o worker já fechou os de cima). */
const PEDIDO_BR_ROTA = "0657c000-2222-4000-8000-000000000003";
const PEDIDO_PT_ROTA = "0657c000-2222-4000-8000-000000000004";

const EMAIL_BR = "titular.br@exemplo.test";
const EMAIL_PT = "titular.pt@exemplo.test";
/** O endereço do pedido que chega pela plataforma: a rota o lê do PAYLOAD. */
const EMAIL_PT_ROTA = "titular.rota@exemplo.test";
const RECEBIDO = "2026-09-10T12:00:00.000Z";
const DUE = "2026-10-05T00:00:00.000Z";

beforeAll(async () => {
  estado.ator = randomUUID();
  await pool.query(
    `insert into organizations(id, slug, legal_name, display_name, country)
     values ($1, $2, 'Loja BR', 'Loja BR', null), ($3, $4, 'Loja PT', 'Loja PT', 'PT')`,
    [ORG_BR, `br-2342-${ORG_BR}`, ORG_PT, `pt-2342-${ORG_PT}`],
  );
  await pool.query(
    `insert into contacts(id, organization_id, name, display_name, email)
     values ($1, $2, 'Beatriz BR', 'Beatriz BR', $3), ($4, $5, 'Ana PT', 'Ana PT', $6)`,
    [CONTATO_BR, ORG_BR, EMAIL_BR, CONTATO_PT, ORG_PT, EMAIL_PT],
  );
  for (const [pedido, org, contato, payload] of [
    [PEDIDO_BR, ORG_BR, CONTATO_BR, {}],
    [PEDIDO_PT, ORG_PT, CONTATO_PT, {}],
    [PEDIDO_BR_ROTA, ORG_BR, CONTATO_BR, {}],
    // O endereço vem do PAYLOAD neste, e não do contato: o caso do worker já
    // anonimizou o contato português (a cascata zera `contacts.email`), e é
    // exatamente para isso que a rota tem o fallback do payload — pedido que
    // chega de plataforma entrega o e-mail junto. O caminho do contato é o que o
    // caso do WORKER prova logo acima.
    [PEDIDO_PT_ROTA, ORG_PT, CONTATO_PT, { email: EMAIL_PT_ROTA }],
  ] as const) {
    await pool.query(
      `insert into lgpd_requests
         (id, organization_id, request_type, source, contact_id, status, received_at, due_at, request_payload, scope)
       values ($1, $2, 'redact', 'manual', $3, 'received', $4, $5, $6::jsonb, 'contact')`,
      [pedido, org, contato, RECEBIDO, DUE, JSON.stringify(payload)],
    );
  }
});

afterAll(async () => {
  await pool.query("delete from lgpd_requests where organization_id = any($1)", [[ORG_BR, ORG_PT]]);
  await pool.query(
    "delete from storage_redaction_queue where organization_id = any($1)",
    [[ORG_BR, ORG_PT]],
  );
  await pool.query("delete from contacts where organization_id = any($1)", [[ORG_BR, ORG_PT]]);
  await pool.query("delete from organizations where id = any($1)", [[ORG_BR, ORG_PT]]);
  await pool.end();
});

/** O evento que o worker consome — o mesmo que o dispatcher entrega em produção. */
function evento(org: string, pedido: string): EventRow {
  return {
    id: randomUUID(),
    organization_id: org,
    event_type: "lgpd.redact_received",
    entity_kind: "lgpd_request",
    entity_id: pedido,
    payload: { request_id: pedido, scope: "contact" },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  } as EventRow;
}

/** A chamada da rota, com o corpo real do contrato. */
function chamarRota(pedido: string, kind: "refusal" | "extension"): Promise<Response> {
  const req = new NextRequest(`http://localhost/api/v1/lgpd/requests/${pedido}/art12`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind,
      reason: "a terceira pessoa envolvida ainda não respondeu ao pedido",
    }),
  });
  return postArt12(req, { params: Promise.resolve({ id: pedido }) });
}

async function coluna<T>(pedido: string, colunaNome: string): Promise<T> {
  const { rows } = await pool.query(`select ${colunaNome} as valor from lgpd_requests where id = $1`, [
    pedido,
  ]);
  return rows[0]?.valor as T;
}

/** A ÚLTIMA auditoria daquele tipo — cada caso grava a dele. */
function ultimaAuditoria(action: string): Auditoria {
  const achadas = auditorias.filter((a) => a.action === action);
  expect(achadas.length, `a auditoria ${action} não foi gravada`).toBeGreaterThan(0);
  return achadas.at(-1)!;
}

describe("o WORKER: o aviso de apagamento só sai fora do Brasil", () => {
  it("organização BRASILEIRA: nenhum e-mail, e NENHUM `art12_notice` no pedido nem na auditoria", async () => {
    const antes = enviados.length;

    const resultado = await processLgpdRedact(evento(ORG_BR, PEDIDO_BR));

    expect(resultado.status).toBe("ok");
    expect(enviados.length, "o Brasil voltou a receber o e-mail do art. 12.º").toBe(antes);
    // O pedido segue como na main: `result` sem a chave do aviso.
    const result = await coluna<Record<string, unknown>>(PEDIDO_BR, "result");
    expect(Object.prototype.hasOwnProperty.call(result, "art12_notice")).toBe(false);
    // E o registro de auditoria também não ganhou a chave.
    const auditoria = ultimaAuditoria("lgpd.redact_completed");
    expect(Object.prototype.hasOwnProperty.call(auditoria.metadata ?? {}, "art12_notice")).toBe(false);
    // Prova de vacuidade: a cascata ACONTECEU — o que não aconteceu foi o aviso.
    expect(result).toMatchObject({ contact_id: CONTATO_BR });
    const emailDoContato = await pool.query("select email from contacts where id = $1", [CONTATO_BR]);
    expect(emailDoContato.rows[0].email, "o contato não foi anonimizado — o caso mediu outra coisa").toBeNull();
  });

  it("organização PORTUGUESA: o e-mail sai, e o resultado diz `sent`", async () => {
    const antes = enviados.length;

    const resultado = await processLgpdRedact(evento(ORG_PT, PEDIDO_PT));

    expect(resultado.status).toBe("ok");
    expect(enviados.length - antes, "o aviso não saiu para a organização portuguesa").toBe(1);
    const email = enviados.at(-1)!;
    expect(email.to).toBe(EMAIL_PT);
    expect(email.subject).toContain("O seu pedido de dados pessoais foi atendido");
    expect(await coluna<Record<string, unknown>>(PEDIDO_PT, "result")).toMatchObject({
      art12_notice: "sent",
    });
    expect(ultimaAuditoria("lgpd.redact_completed").metadata).toMatchObject({
      art12_notice: "sent",
    });
  });
});

describe("a ROTA: a organização brasileira é recusada antes de tocar em qualquer coisa", () => {
  it("BRASIL: 422 `lgpd_art12_so_fora_do_brasil` — sem e-mail, `due_at` intacto e sem auditoria", async () => {
    estado.orgId = ORG_BR;
    const enviadosAntes = enviados.length;
    const auditoriasAntes = auditorias.length;
    const dueAntes = await coluna<string>(PEDIDO_BR_ROTA, "due_at");

    // `extension` de propósito: é o `kind` que MEXERIA no `due_at` se a rota
    // passasse pela guarda do país.
    const resposta = await chamarRota(PEDIDO_BR_ROTA, "extension");

    expect(resposta.status).toBe(422);
    const corpo = (await resposta.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("lgpd_art12_so_fora_do_brasil");
    expect(enviados.length, "a recusa mandou e-mail").toBe(enviadosAntes);
    expect(new Date(await coluna<string>(PEDIDO_BR_ROTA, "due_at")).toISOString()).toBe(
      new Date(dueAntes).toISOString(),
    );
    expect(
      auditorias.slice(auditoriasAntes).filter((a) => a.action === "lgpd.art12_notice_sent"),
    ).toHaveLength(0);
    const payload = await coluna<Record<string, unknown>>(PEDIDO_BR_ROTA, "request_payload");
    expect(payload.art12, "a recusa gravou o marcador do aviso").toBeUndefined();
  });

  it("PORTUGAL: 200, e-mail enviado, auditoria gravada e a prorrogação empurra o `due_at`", async () => {
    estado.orgId = ORG_PT;
    const enviadosAntes = enviados.length;
    const auditoriasAntes = auditorias.length;
    // Um prazo no passado distante: a prorrogação de um mês é mais distante que ele.
    await pool.query("update lgpd_requests set due_at = $2 where id = $1", [
      PEDIDO_PT_ROTA,
      "2020-01-05T00:00:00.000Z",
    ]);

    const resposta = await chamarRota(PEDIDO_PT_ROTA, "extension");

    expect(resposta.status).toBe(200);
    expect(enviados.length - enviadosAntes).toBe(1);
    expect(enviados.at(-1)!.to).toBe(EMAIL_PT_ROTA);
    const novas = auditorias
      .slice(auditoriasAntes)
      .filter((a) => a.action === "lgpd.art12_notice_sent");
    expect(novas).toHaveLength(1);
    expect(novas[0]!.metadata).toMatchObject({ kind: "extension", prorrogou_prazo: true });

    // O `due_at` novo é um DIA CIVIL (meia-noite UTC), e é mais distante que o antigo.
    const dueNovo = new Date(await coluna<string>(PEDIDO_PT_ROTA, "due_at"));
    expect(dueNovo.toISOString()).toMatch(/T00:00:00\.000Z$/);
    expect(dueNovo.getTime()).toBeGreaterThan(Date.parse("2020-01-05T00:00:00.000Z"));
    const payload = await coluna<{ art12?: { dentro_do_prazo?: unknown } }>(
      PEDIDO_PT_ROTA,
      "request_payload",
    );
    expect(payload.art12?.dentro_do_prazo).toBeDefined();
  });

  it("PORTUGAL: cada desfecho sai UMA vez — alternar recusa e prorrogação não reenvia nem empurra o prazo", async () => {
    estado.orgId = ORG_PT;
    // Depende do caso acima: a prorrogação deste pedido já saiu.
    const enviadosAntes = enviados.length;

    const recusa = await chamarRota(PEDIDO_PT_ROTA, "refusal");
    expect(recusa.status).toBe(200);
    expect(enviados.length - enviadosAntes, "a primeira recusa não saiu").toBe(1);
    const dueDepoisDaRecusa = await coluna<string>(PEDIDO_PT_ROTA, "due_at");

    for (const kind of ["extension", "refusal"] as const) {
      const resposta = await chamarRota(PEDIDO_PT_ROTA, kind);
      expect(resposta.status).toBe(200);
      const corpo = (await resposta.json()) as { data: { duplicate: boolean } };
      expect(corpo.data.duplicate, `${kind} repetido saiu como novo`).toBe(true);
    }
    expect(enviados.length - enviadosAntes, "alternar os desfechos reenviou e-mail").toBe(1);
    expect(new Date(await coluna<string>(PEDIDO_PT_ROTA, "due_at")).toISOString()).toBe(
      new Date(dueDepoisDaRecusa).toISOString(),
    );
  });
});
