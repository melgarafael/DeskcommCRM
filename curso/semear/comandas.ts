/**
 * Semente do módulo "Comandas" (CRM › Ver tudo em CRM › Comandas, /app/comandas):
 * o balcão da Clínica Bem Viver com três comandas — uma finalizada (#41), uma
 * cancelada (#42) e uma aberta (#43) — e três atendimentos de pilates de ontem
 * que ninguém faturou, um deles com serviço sem preço.
 *
 * ⚠️ A comanda é MÓDULO DE TABELA (ADR-0002): as cinco tabelas só existem depois
 * de `fn_financeiro_provisionar()`, e a tela só abre com a linha `financeiro` em
 * `modulos_instalados`. A linha a base apaga antes de cada lição (estado de
 * fábrica); as TABELAS ficam — `create table if not exists`, sem dado de
 * ninguém, e nenhuma tela fora da comanda as lê sem a linha do módulo. Por isso
 * provisionamos só quando a API ainda não enxerga `sales`, e avisamos o
 * PostgREST para recarregar o schema (o que `fn_modulo_instalar` faz no fim).
 *
 * As contas e formas de pagamento são as da semente do Financeiro (Pix cai na
 * conta do banco): chamá-la aqui garante que existem, e é idempotente.
 */
import pg from "pg";

import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";
import { type Contexto, exigir, ha, semErro } from "../semear-demonstracao";
import { exigirBancoLocal } from "../seguranca";
import { semear as semearFinanceiro } from "./financeiro";

const id = (bloco: number, n: number) => `f1b0000${bloco}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const COMANDA = { finalizada: id(4, 1), cancelada: id(4, 2), aberta: id(4, 3) };
const TIPO = { pilates: id(6, 1), avaliacao: id(6, 2) };
const ATENDIMENTO = [1, 2, 3].map((n) => id(7, n));
const ENDERECO = "Rua das Acácias, 120 — 3º andar, sala 3";

/** A API não conhece a tabela: módulo nunca provisionado nesta bancada. */
const semTabela = (e: { code?: string; message: string } | null) =>
  e !== null && (e.code === "PGRST205" || e.code === "42P01");

async function garantirTabelasDaComanda(c: Contexto) {
  const { error } = await c.db.from("sales").select("id").limit(1);
  if (!semTabela(error)) return semErro({ error }, "ler comandas");
  const cli = new pg.Client({ connectionString: exigirBancoLocal(process.env.SUPABASE_DB_URL) });
  await cli.connect();
  try {
    // SUPABASE_DB_URL pode apontar para OUTRO Postgres local: a organização da bancada tem de estar lá
    const identidade = await cli.query("select id from public.organizations where id = $1", [c.org]);
    if (identidade.rowCount !== 1) throw new Error("Postgres direto não corresponde à organização da bancada Supabase");
    await cli.query("select public.fn_financeiro_provisionar()");
    await cli.query("notify pgrst, 'reload schema'");
  } finally {
    await cli.end();
  }
  for (let i = 0; i < 40; i++) {
    const r = await c.db.from("sales").select("id").limit(1);
    if (!semTabela(r.error)) return semErro(r, "ler comandas");
    await new Promise((ok) => setTimeout(ok, 250));
  }
  throw new Error("as tabelas da comanda não apareceram na API depois de provisionar o módulo");
}

export async function limpar(c: Contexto) {
  const { db, org } = c;
  // bancada que nunca provisionou o módulo não tem comanda para apagar
  const { error } = await db.from("sales").select("id").limit(1);
  if (!semTabela(error)) {
    semErro({ error }, "ler comandas");
    // item lançado num tipo desta semente prende o tipo (on delete restrict), venha de onde vier
    semErro(
      await db.from("sale_items").delete().eq("organization_id", org).in("event_type_id", Object.values(TIPO)),
      "limpar itens dos serviços de pilates",
    );
    // as comandas da semente e as que uma lição faturou a partir dos atendimentos dela
    semErro(
      await db.from("sales").delete().eq("organization_id", org).in("id", Object.values(COMANDA)),
      "limpar comandas",
    );
    semErro(
      await db.from("sales").delete().eq("organization_id", org).in("appointment_id", ATENDIMENTO),
      "limpar comandas dos atendimentos",
    );
  }
  semErro(
    await db.from("calendar_appointments").delete().eq("organization_id", org).in("id", ATENDIMENTO),
    "limpar atendimentos de pilates",
  );
  semErro(
    await db.from("calendar_event_types").delete().eq("organization_id", org).in("id", Object.values(TIPO)),
    "limpar serviços de pilates",
  );
}

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;
  await garantirTabelasDaComanda(c);
  await limpar(c);

  semErro(
    await db.from("modulos_instalados").upsert(
      {
        modulo: "financeiro", estado: "ativo", instalado_em: ha(30 * 24 * 60), instalado_por: pessoa.helena,
        reaplicado_em: ha(30 * 24 * 60), motivo_suspensao: null,
      },
      { onConflict: "modulo" },
    ),
    "módulo Comandas instalado",
  );
  await semearFinanceiro(c);
  const pix = exigir(
    await db.from("payment_methods").select("id").eq("organization_id", org).eq("name", "Pix").eq("is_active", true).limit(1).single(),
    "forma Pix",
  ) as { id: string };

  // ---------- os serviços: um com preço (vira sugestão no balcão) e um sem ----------
  semErro(
    await db.from("calendar_event_types").insert([
      {
        id: TIPO.pilates, organization_id: org, name: demo("Aula de pilates"), slug: "aula-de-pilates-em-grupo",
        category: "procedimento", duration_minutes: 50, default_owner_user_id: pessoa.ana, location_kind: "in_person",
        location_details: ENDERECO, default_price_cents: 12_000, is_active: true, requires_confirmation: false, position: 300,
      },
      {
        id: TIPO.avaliacao, organization_id: org, name: demo("Avaliação de pilates"), slug: "avaliacao-de-pilates",
        category: "consulta", duration_minutes: 30, default_owner_user_id: pessoa.ana, location_kind: "in_person",
        location_details: ENDERECO, default_price_cents: null, is_active: true, requires_confirmation: false, position: 301,
      },
    ]),
    "serviços de pilates",
  );

  // ---------- ontem: três atendimentos que aconteceram e ficaram sem comanda ----------
  // sem contato de propósito: calendar_appointments.contact_id é `on delete restrict`
  // e a base apaga os contatos antes de cada lição (ver agenda.ts)
  const atendimento = (n: number, tipo: string, titulo: string, minutos: number, status: string) => ({
    id: ATENDIMENTO[n - 1], organization_id: org, event_type_id: tipo, title: demo(titulo),
    starts_at: ha(minutos), ends_at: ha(minutos - 50), time_zone: "America/Sao_Paulo", status,
    owner_user_id: pessoa.ana, location_kind: "in_person", location_details: ENDERECO,
    created_by_kind: "user", created_by_user_id: pessoa.helena, source: "ui",
  });
  semErro(
    await db.from("calendar_appointments").insert([
      atendimento(1, TIPO.pilates, "Aula de pilates — Tereza Gomes", 27 * 60, "completed"),
      atendimento(2, TIPO.pilates, "Aula de pilates — Osvaldo Pires", 26 * 60, "completed"),
      atendimento(3, TIPO.avaliacao, "Avaliação de pilates — Camila Rocha", 25 * 60, "confirmed"),
    ]),
    "atendimentos de ontem",
  );

  // ---------- o balcão: finalizada, cancelada e aberta ----------
  semErro(
    await db.from("sales").insert([
      {
        id: COMANDA.finalizada, organization_id: org, number: 41, status: "finalized", total_cents: 28_000,
        currency: "BRL", payment_method_id: pix.id, finalized_at: ha(28 * 60), attendant_user_id: pessoa.ana,
        created_by_user_id: pessoa.ana, created_at: ha(29 * 60),
      },
      {
        id: COMANDA.cancelada, organization_id: org, number: 42, status: "cancelled", total_cents: 0, currency: "BRL",
        cancelled_at: ha(3 * 60), cancel_reason: "Lançada em duplicidade.", attendant_user_id: pessoa.ana,
        created_by_user_id: pessoa.ana, created_at: ha(4 * 60),
      },
      {
        id: COMANDA.aberta, organization_id: org, number: 43, status: "open", total_cents: 0, currency: "BRL",
        attendant_user_id: pessoa.ana, created_by_user_id: pessoa.ana, created_at: ha(40),
      },
    ]),
    "comandas",
  );
  const item = (n: number, venda: string, descricao: string, preco: number) => ({
    id: id(5, n), organization_id: org, sale_id: venda, event_type_id: null, description: demo(descricao),
    attendant_user_id: pessoa.ana, quantity: 1, unit_price_cents: preco, discount_cents: 0, total_cents: preco,
    commission_percent: 0,
  });
  semErro(
    await db.from("sale_items").insert([
      item(1, COMANDA.finalizada, "Consulta com a nutricionista", 28_000),
      item(2, COMANDA.cancelada, "Consulta com a nutricionista", 28_000),
      item(3, COMANDA.aberta, "Sessão de fisioterapia", 15_000),
    ]),
    "itens das comandas",
  );
}
