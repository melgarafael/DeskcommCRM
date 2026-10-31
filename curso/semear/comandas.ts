/**
 * Semente do módulo "Comandas" (CRM › Ver tudo em CRM › Comandas).
 *
 * ─── O módulo ───────────────────────────────────────────────────────────────
 *
 * A comanda é MÓDULO DE TABELA (ADR-0002): as cinco tabelas (`sales`,
 * `sale_items`, `commission_rules`, `commissions`, `loyalty_ledger`) só existem
 * depois que quem administra o servidor instala "Comandas" em Admin › Módulos, e
 * a tela e as rotas só abrem com a linha `financeiro` ativa em
 * `modulos_instalados`. A instalação do produto (`fn_modulo_instalar`) é a soma
 * de duas peças, e esta semente usa as MESMAS duas:
 *   1. `fn_financeiro_provisionar()` — cria as tabelas (idempotente). Só roda
 *      quando a tabela ainda não existe, pela conexão direta da bancada, porque
 *      o PostgREST só enxerga tabela nova depois do `notify pgrst`.
 *   2. a linha ativa em `modulos_instalados` — a mesma que `admin-modulos.ts`
 *      grava. A base devolve essa tabela ao estado de fábrica antes de cada
 *      lição, então isto roda a cada lição.
 * O recibo em `extension_operations` fica de fora de propósito: ele aparece no
 * histórico das telas de Extensões, que outros módulos fotografam.
 *
 * As tabelas criadas pela provisionadora NÃO somem quando a base volta ao estado
 * de fábrica (só a linha some). Sem a linha, as telas e as rotas da comanda
 * continuam fechadas (404) e nada aparece para os outros módulos.
 *
 * ─── Os dados ───────────────────────────────────────────────────────────────
 *
 * - Formas de pagamento e contas: as do módulo "Financeiro" (Configurações ›
 *   Financeiro), pela semente dele — é de lá que a comanda tira "em que conta o
 *   dinheiro cai". Reaproveitar evita uma segunda lista de formas que apareceria
 *   nas fotos daquela tela. "Cartão de crédito" segue sem conta: é o aviso que a
 *   lição de fechar a conta mostra.
 * - Três serviços (tipos de agendamento) com nomes que nenhum outro módulo usa:
 *   dois com preço padrão e um sem preço.
 * - Cinco comandas: duas finalizadas, uma cancelada e duas abertas (uma delas com
 *   cliente, para o saldo e o campo de pontos de fidelidade aparecerem).
 * - Três atendimentos que já aconteceram e ficaram sem comanda. SEM contato, como
 *   os da Agenda: `calendar_appointments.contact_id` é `on delete restrict` e a
 *   base apaga os contatos antes de cada lição. O nome do paciente vai no título.
 *
 * Idempotente: apaga TODAS as comandas da organização (as tabelas só existem por
 * causa deste módulo, e as lições criam comandas novas pela tela) com os
 * lançamentos e pontos ligados a elas, e recria as próprias linhas pelos ids
 * fixos. Os serviços voltam por upsert; os atendimentos são apagados e recriados.
 */
import pg from "pg";

import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";
import { type Contexto, contatoId, exigir, ha, ontemAs, semErro } from "../semear-demonstracao";
import { exigirBancoLocal } from "../seguranca";
import { semear as semearFinanceiro } from "./financeiro";

const id = (bloco: number, n: number) =>
  `d110${String(bloco).padStart(2, "0")}00-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TIPO = { nutricao: id(1, 1), acupuntura: id(1, 2), retorno: id(1, 3) };
const COMANDA = (n: number) => id(2, n);
const ATENDIMENTO = (n: number) => id(3, n);
const ITEM = (n: number) => id(4, n);
const LANCAMENTO = (n: number) => id(5, n);
const PONTO = (n: number) => id(6, n);

/** Linhas da semente do módulo "Financeiro" (curso/semear/financeiro.ts). */
const FIN = (bloco: number, n: number) => `be7f0${bloco}00-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CONTA = { caixa: FIN(1, 1), banco: FIN(1, 2) };
const FORMA = { pix: FIN(2, 1), dinheiro: FIN(2, 2) };
const PLANO_CONSULTAS = FIN(3, 1);

const MIN = 60_000;
/** Há `dias` dias, às h:m de São Paulo (UTC-3, sem horário de verão). */
const diasAtrasAs = (dias: number, h: number, m: number) =>
  new Date(new Date(ontemAs(h, m)).getTime() - (dias - 1) * 24 * 60 * MIN).toISOString();
/** A data (AAAA-MM-DD) de um instante, no fuso de São Paulo. */
const dataSP = (iso: string) => new Date(new Date(iso).getTime() - 3 * 60 * MIN).toISOString().slice(0, 10);

/** Garante as tabelas do módulo. Só abre conexão direta quando elas ainda não existem. */
async function provisionarSePreciso(c: Contexto) {
  const sonda = await c.db.from("sales").select("id").limit(1);
  if (!sonda.error) return;
  if (sonda.error.code !== "PGRST205") throw new Error(`conferir a tabela da comanda: ${sonda.error.message}`);

  const cli = new pg.Client({ connectionString: exigirBancoLocal(process.env.SUPABASE_DB_URL) });
  await cli.connect();
  try {
    // A conexão direta precisa enxergar a MESMA organização do client Supabase.
    const r = await cli.query("select id from public.organizations where id = $1", [c.org]);
    if (r.rowCount !== 1) throw new Error("Postgres direto não corresponde à organização da bancada Supabase");
    await cli.query("select public.fn_financeiro_provisionar()");
    await cli.query("notify pgrst, 'reload schema'");
  } finally {
    await cli.end();
  }
  // O PostgREST recarrega o schema em segundo plano: espera a tabela aparecer.
  for (let i = 0; i < 40; i++) {
    const r = await c.db.from("sales").select("id").limit(1);
    if (!r.error) return;
    await new Promise((ok) => setTimeout(ok, 500));
  }
  throw new Error("as tabelas da comanda não apareceram na API depois da provisionadora");
}

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;

  // ---------- o módulo Comandas instalado ----------
  await provisionarSePreciso(c);
  semErro(
    await db.from("modulos_instalados").upsert(
      {
        modulo: "financeiro",
        estado: "ativo",
        instalado_em: ha(30 * 24 * 60),
        instalado_por: pessoa.helena,
        reaplicado_em: ha(30 * 24 * 60),
        motivo_suspensao: null,
      },
      { onConflict: "modulo" },
    ),
    "módulo Comandas instalado",
  );

  // ---------- contas e formas de pagamento: as do Financeiro ----------
  await semearFinanceiro(c);

  // ---------- limpa as comandas (as da semente e as que as lições criam) ----------
  const comandas = exigir(
    await db.from("sales").select("id").eq("organization_id", org),
    "comandas atuais",
  ) as Array<{ id: string }>;
  const ids = comandas.map((x) => x.id);
  if (ids.length) {
    // O contra-lançamento do estorno aponta para o original com `on delete
    // restrict`: ele sai primeiro.
    semErro(
      await db.from("financial_entries").delete().eq("organization_id", org).in("sale_id", ids).not("reverses_entry_id", "is", null),
      "limpar estornos das comandas",
    );
    semErro(
      await db.from("financial_entries").delete().eq("organization_id", org).in("sale_id", ids),
      "limpar lançamentos das comandas",
    );
    semErro(
      await db.from("loyalty_ledger").delete().eq("organization_id", org).in("sale_id", ids),
      "limpar pontos das comandas",
    );
    // Itens e comissões caem em cascata.
    semErro(await db.from("sales").delete().eq("organization_id", org).in("id", ids), "limpar comandas");
  }
  semErro(
    await db.from("loyalty_ledger").delete().eq("organization_id", org).in("id", [PONTO(1), PONTO(2)]),
    "limpar pontos da semente",
  );

  // ---------- os serviços que a comanda oferece ----------
  const ENDERECO = "Rua das Acácias, 120 — 3º andar";
  semErro(
    await db.from("calendar_event_types").upsert(
      [
        { id: TIPO.nutricao, name: demo("Consulta de nutrição"), slug: "consulta-de-nutricao", category: "consulta", duration_minutes: 50, default_price_cents: 22_000, default_owner_user_id: pessoa.helena, position: 300 },
        { id: TIPO.acupuntura, name: demo("Sessão de acupuntura"), slug: "sessao-de-acupuntura", category: "procedimento", duration_minutes: 40, default_price_cents: 13_000, default_owner_user_id: pessoa.ana, position: 301 },
        { id: TIPO.retorno, name: demo("Retorno de nutrição"), slug: "retorno-de-nutricao", category: "consulta", duration_minutes: 30, default_price_cents: null, default_owner_user_id: pessoa.helena, position: 302 },
      ].map((t) => ({
        ...t,
        organization_id: org,
        location_kind: "in_person",
        location_details: `${ENDERECO}, sala 1`,
        reminder_enabled: false,
        is_active: true,
      })),
      { onConflict: "id" },
    ),
    "serviços da comanda",
  );

  // ---------- atendimentos que já aconteceram e ficaram sem comanda ----------
  const ATENDIMENTOS = [
    { n: 1, tipo: TIPO.nutricao, titulo: "Consulta de nutrição — Fernanda Oliveira", comeca: diasAtrasAs(2, 10, 0), dur: 50, status: "completed", dono: pessoa.helena },
    { n: 2, tipo: TIPO.retorno, titulo: "Retorno de nutrição — Beatriz Nogueira", comeca: ontemAs(9, 0), dur: 30, status: "confirmed", dono: pessoa.helena },
    { n: 3, tipo: TIPO.acupuntura, titulo: "Sessão de acupuntura — Pedro Henrique Lima", comeca: ontemAs(15, 0), dur: 40, status: "confirmed", dono: pessoa.ana },
  ];
  semErro(
    await db.from("calendar_appointments").delete().eq("organization_id", org).in("id", ATENDIMENTOS.map((a) => ATENDIMENTO(a.n))),
    "limpar atendimentos sem comanda",
  );
  semErro(
    await db.from("calendar_appointments").insert(
      ATENDIMENTOS.map((a) => ({
        id: ATENDIMENTO(a.n),
        organization_id: org,
        event_type_id: a.tipo,
        title: demo(a.titulo),
        starts_at: a.comeca,
        ends_at: new Date(new Date(a.comeca).getTime() + a.dur * MIN).toISOString(),
        time_zone: "America/Sao_Paulo",
        status: a.status,
        owner_user_id: a.dono,
        location_kind: "in_person",
        location_details: `${ENDERECO}, sala 1`,
        created_by_kind: "user",
        created_by_user_id: pessoa.helena,
        source: "ui",
      })),
    ),
    "atendimentos sem comanda",
  );

  // ---------- as comandas ----------
  type Item = { n: number; tipo: string | null; descricao: string; preco: number };
  const COMANDAS: Array<{
    n: number;
    status: "open" | "finalized" | "cancelled";
    criada: string;
    fechada?: string;
    forma?: string;
    conta?: string;
    contato?: string;
    quem: string;
    itens: Item[];
  }> = [
    {
      n: 1, status: "finalized", criada: diasAtrasAs(3, 10, 0), fechada: diasAtrasAs(3, 11, 0), forma: FORMA.pix, conta: CONTA.banco, quem: pessoa.helena,
      itens: [{ n: 1, tipo: TIPO.nutricao, descricao: "Consulta de nutrição", preco: 22_000 }],
    },
    {
      n: 2, status: "finalized", criada: diasAtrasAs(2, 14, 0), fechada: diasAtrasAs(2, 14, 50), forma: FORMA.dinheiro, conta: CONTA.caixa, quem: pessoa.ana,
      itens: [{ n: 2, tipo: TIPO.acupuntura, descricao: "Sessão de acupuntura", preco: 13_000 }],
    },
    {
      n: 3, status: "cancelled", criada: ontemAs(11, 0), fechada: ontemAs(11, 5), quem: pessoa.ana,
      itens: [{ n: 3, tipo: TIPO.acupuntura, descricao: "Sessão de acupuntura", preco: 13_000 }],
    },
    {
      n: 4, status: "open", criada: ha(50), contato: contatoId(1), quem: pessoa.ana,
      itens: [
        { n: 4, tipo: TIPO.acupuntura, descricao: "Sessão de acupuntura", preco: 13_000 },
        { n: 5, tipo: null, descricao: "Kit de faixas elásticas", preco: 4_500 },
      ],
    },
    {
      n: 5, status: "open", criada: ha(20), quem: pessoa.helena,
      itens: [{ n: 6, tipo: TIPO.nutricao, descricao: "Consulta de nutrição", preco: 22_000 }],
    },
  ];

  semErro(
    await db.from("sales").insert(
      COMANDAS.map((k) => {
        const total = k.itens.reduce((s, i) => s + i.preco, 0);
        return {
          id: COMANDA(k.n),
          organization_id: org,
          number: k.n,
          status: k.status,
          contact_id: k.contato ?? null,
          attendant_user_id: k.quem,
          created_by_user_id: k.quem,
          currency: "BRL",
          // `total_cents` só é gravado na finalização; aberta e cancelada ficam em zero.
          total_cents: k.status === "finalized" ? total : 0,
          payment_method_id: k.forma ?? null,
          finalized_at: k.status === "finalized" ? k.fechada : null,
          cancelled_at: k.status === "cancelled" ? k.fechada : null,
          created_at: k.criada,
          updated_at: k.fechada ?? k.criada,
        };
      }),
    ),
    "comandas",
  );
  semErro(
    await db.from("sale_items").insert(
      COMANDAS.flatMap((k) =>
        k.itens.map((i) => ({
          id: ITEM(i.n),
          organization_id: org,
          sale_id: COMANDA(k.n),
          event_type_id: i.tipo,
          description: demo(i.descricao),
          quantity: 1,
          unit_price_cents: i.preco,
          discount_cents: 0,
          total_cents: i.preco,
          commission_percent: 0,
          created_at: k.criada,
        })),
      ),
    ),
    "itens das comandas",
  );

  // A entrada no caixa que a finalização grava (fn_finalizar_comanda, passo 3).
  semErro(
    await db.from("financial_entries").insert(
      COMANDAS.filter((k) => k.status === "finalized").map((k) => ({
        id: LANCAMENTO(k.n),
        organization_id: org,
        account_id: k.conta,
        account_plan_id: PLANO_CONSULTAS,
        sale_id: COMANDA(k.n),
        direction: "in",
        amount_cents: k.itens.reduce((s, i) => s + i.preco, 0),
        currency: "BRL",
        description: `Comanda #${k.n}`,
        entry_date: dataSP(k.fechada!),
        status: "paid",
        paid_at: k.fechada,
        origin: "sale",
        created_by_user_id: k.quem,
        created_at: k.fechada,
        updated_at: k.fechada,
      })),
    ),
    "lançamentos das comandas finalizadas",
  );

  // O saldo de pontos da Mariana (contato da comanda #4), de visitas anteriores.
  semErro(
    await db.from("loyalty_ledger").insert([
      { id: PONTO(1), organization_id: org, contact_id: contatoId(1), points: 5, reason: demo("Comanda finalizada"), created_by_user_id: pessoa.ana, created_at: ha(40 * 24 * 60) },
      { id: PONTO(2), organization_id: org, contact_id: contatoId(1), points: 3, reason: demo("Comanda finalizada"), created_by_user_id: pessoa.ana, created_at: ha(12 * 24 * 60) },
    ]),
    "pontos de fidelidade da Mariana",
  );
}
