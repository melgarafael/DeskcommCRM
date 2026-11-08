import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { podeVerPessoal } from "@/app/api/v1/conversations/_handler";

/**
 * A FILA "PESSOAL" NO INBOX (spec 33).
 *
 * A spec 21 escondeu o pessoal da operação e, no mesmo gesto, o tornou
 * inalcançável: sem lista, sem busca, sem contagem, sem envio — nem manual, nem
 * de gerente. A doutrina revisada separa as duas coisas:
 *
 *   esconder da OPERAÇÃO  → continua valendo (IA, automação, campanha,
 *                            follow-up, funil, métricas, RAG, MCP, badges);
 *   tornar INALCANÇÁVEL   → nunca por decisão interna. Quem fecha o canal é o
 *                            titular (`is_blocked`).
 *
 * ─── SABOTAGEM (prova no CI) ───────────────────────────────────────────────
 * - Trocar o filtro por dono por `is_personal = true` cru: o caso "pessoal de
 *   OUTRO usuário não aparece" acusa (vaza a conversa de família do colega).
 * - Deixar `api_token`/`ai_agent` passar em `podeVerPessoal`: o MCP volta a ler
 *   e escrever pessoal (spec 21 §6.1, que este PR NÃO reabre).
 * - Tirar o `admin` da régua: o pessoal fica órfão quando o dono sai — a
 *   doutrina proíbe contato sem ninguém que possa responder.
 * - Esquecer a rota lendo `pessoais`: a cerca
 *   `rota-le-todo-filtro-do-schema` acusa junto (é o defeito silencioso que
 *   schema/hook/handler já produziram três vezes).
 * Linha para reverter: `app/api/v1/conversations/_handler.ts` (`podeVerPessoal`,
 * `idsDeContatosPessoaisVisiveis`), `app/api/v1/messages/_handler.ts`,
 * `components/inbox/InboxFilters.tsx`.
 */

const RAIZ = process.cwd();
const fonte = (...partes: string[]) => fs.readFileSync(path.join(RAIZ, ...partes), "utf8");
const semComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const LISTA = semComentarios(fonte("app", "api", "v1", "conversations", "_handler.ts"));
const ROTA = semComentarios(fonte("app", "api", "v1", "conversations", "route.ts"));
const CONTAS = semComentarios(fonte("app", "api", "v1", "conversations", "counts", "route.ts"));
const ENVIO = semComentarios(fonte("app", "api", "v1", "messages", "_handler.ts"));
const ABA = semComentarios(fonte("components", "inbox", "InboxFilters.tsx"));
const LAYOUT = semComentarios(fonte("components", "inbox", "InboxLayout.tsx"));
const HOOK = semComentarios(fonte("hooks", "inbox", "useConversationsRealtime.ts"));

const CONTATO_PESSOAL = { is_personal: true, personal_owner_user_id: "user-dono" };
const CONTATO_COMUM = { is_personal: false, personal_owner_user_id: null };

describe("podeVerPessoal — quem alcança o pessoal", () => {
  it("contato comum é de todo mundo (a régua só existe para o pessoal)", () => {
    expect(podeVerPessoal({ type: "user", id: "user-x", role: "agent" }, CONTATO_COMUM)).toBe(true);
    expect(podeVerPessoal({ type: "api_token", id: "tok" }, CONTATO_COMUM)).toBe(true);
  });

  it("o DONO vê o próprio pessoal", () => {
    expect(
      podeVerPessoal({ type: "user", id: "user-dono", role: "manager" }, CONTATO_PESSOAL),
    ).toBe(true);
  });

  it("outro usuário NÃO vê o pessoal do colega — nem sendo manager", () => {
    // O vazamento que a spec 21 existia para impedir: a conversa de família de
    // um gerente aparecendo para os outros. Ser gerente não dá esse direito.
    expect(
      podeVerPessoal({ type: "user", id: "user-outro", role: "manager" }, CONTATO_PESSOAL),
    ).toBe(false);
    expect(podeVerPessoal({ type: "user", id: "user-outro", role: "agent" }, CONTATO_PESSOAL)).toBe(
      false,
    );
  });

  it("`admin` vê todo pessoal — é o que impede contato órfão", () => {
    // Férias, desligamento, troca de dono: se ninguém pudesse abrir, o contato
    // ficaria inalcançável por decisão interna — o que a doutrina proíbe.
    expect(podeVerPessoal({ type: "user", id: "user-admin", role: "admin" }, CONTATO_PESSOAL)).toBe(
      true,
    );
    expect(
      podeVerPessoal(
        { type: "user", id: "user-admin", role: "admin" },
        { is_personal: true, personal_owner_user_id: null },
      ),
    ).toBe(true);
  });

  it("token de API e agente de IA NUNCA chegam ao pessoal (spec 21 §6.1 mantida)", () => {
    expect(podeVerPessoal({ type: "api_token", id: "user-dono" }, CONTATO_PESSOAL)).toBe(false);
    // `ai_agent` exige `role` no union do `Actor` — e o `id` dele é o do RUN, não
    // o de uma pessoa: nem com o mesmo id do dono ele passa.
    expect(
      podeVerPessoal({ type: "ai_agent", id: "user-dono", role: "agent" }, CONTATO_PESSOAL),
    ).toBe(false);
  });
});

describe("aba Pessoal — lista invertida e escopada", () => {
  it("a lista mostra o pessoal visível por `in`, não o conjunto da organização", () => {
    expect(LISTA).toMatch(/export async function idsDeContatosPessoaisVisiveis/);
    expect(LISTA).toMatch(/query\.in\("contact_id",\s*visiveis\)/);
    expect(LISTA).toMatch(/\.eq\("personal_owner_user_id",\s*quem\.userId\)/);
  });

  it("sem dono não há o que listar — falha fechada, não aberta", () => {
    // `undefined` no `.eq` viraria filtro ausente (todo o pessoal da org).
    expect(LISTA).toMatch(/if \(!quem\.userId\) return \[\];/);
  });

  it("conjunto vazio não vira `in ()` — a aba responde vazia, não 500", () => {
    expect(LISTA).toMatch(
      /if \(visiveis\.length === 0\) return \{ conversations: \[\], cursor: null, has_more: false \}/,
    );
  });

  it("a exclusão da spec 21 continua no caminho de TODAS as outras visões", () => {
    expect(LISTA).toMatch(/\.not\("contact_id",\s*"in"/);
  });

  it("a rota lê `pessoais` da URL (a cerca do schema cobra o resto)", () => {
    expect(ROTA).toMatch(/pessoais: url\.searchParams\.get\("pessoais"\) \?\? undefined/);
  });

  it("o ator de sessão carrega o papel — sem ele não há como reconhecer `admin`", () => {
    expect(ROTA).toMatch(/actor: \{ type: "user", id: user\.id, role: activeOrg\.role \}/);
  });
});

describe("contagem da aba — conta o que ela lista", () => {
  it("a contagem pessoal nasce das MESMAS ids da lista", () => {
    expect(CONTAS).toMatch(/idsDeContatosPessoaisVisiveis/);
    expect(CONTAS).toMatch(/pessoal: pessoal\.count \?\? 0/);
  });

  it("as outras seis contagens continuam sem pessoal (`countExact`)", () => {
    expect(CONTAS).toMatch(/idsDeContatosPessoais\(/);
    expect(CONTAS).toMatch(/\.not\("contact_id",\s*"in"/);
  });
});

describe("envio — humano dono sim, automação e token não", () => {
  it("a régua do envio olha a ORIGEM e a posse, não o papel", () => {
    expect(ENVIO).toMatch(/const humano = origemDaMensagem\(ctx\.actor\) === "user"/);
    expect(ENVIO).toMatch(/const dono = c\.contacts\.personal_owner_user_id \?\? null/);
    expect(ENVIO).toMatch(/dono === ctx\.actor\.id/);
  });

  it("o `admin` entra pelo rank, não por uma segunda lista de papéis", () => {
    expect(ENVIO).toMatch(/roleAtLeast\(ctx\.actor\.role, "admin"\)/);
  });

  it("quem não é autorizado continua levando 403 genérico, sem vazar o contato", () => {
    expect(ENVIO).toMatch(/"Contato marcado como pessoal\."/);
  });
});

describe("tela — aba só para quem pode marcar", () => {
  it("`agent` não vê a aba; `manager` e `admin` veem", () => {
    expect(ABA).toMatch(/const hidePessoal = !roleAtLeast\(role, "manager"\)/);
    expect(ABA).toMatch(/\{ value: "pessoal", label: "Pessoal" \}/);
  });

  it("a aba vira `pessoais: true` no filtro — e só quando ligada viaja na URL", () => {
    expect(LAYOUT).toMatch(/case "pessoal":/);
    expect(LAYOUT).toMatch(/return \{ pessoais: true \}/);
    expect(HOOK).toMatch(/if \(filters\.pessoais\) qs\.set\("pessoais", "true"\)/);
  });

  it("a aba NÃO filtra por status: marcar fecha a conversa, e a fila nasceria vazia", () => {
    const caso = LAYOUT.slice(LAYOUT.indexOf('case "pessoal":'), LAYOUT.indexOf('case "all":'));
    expect(caso).not.toMatch(/status/);
  });
});

describe("migration 9238 — o dono da marca", () => {
  // Descoberto por PADRÃO, não por nome fixo: renumerar migration é rotina
  // neste repo (colisão com PR aberto), e um teste amarrado ao nome vira
  // vermelho por motivo que não é defeito.
  const arquivoDaMigration = fs
    .readdirSync(path.join(RAIZ, "supabase", "migrations"))
    .find((n) => n.endsWith("_9238_fila_pessoal_com_dono.sql"));
  const MIGRATION = fonte("supabase", "migrations", arquivoDaMigration ?? "nao-existe.sql");
  const BASELINE = fs.readFileSync(path.join(RAIZ, "supabase", "baseline.sql"), "utf8");

  it("acrescenta a coluna de forma idempotente", () => {
    expect(MIGRATION).toMatch(/add column if not exists personal_owner_user_id uuid/);
    expect(MIGRATION).toMatch(/on delete set null/);
  });

  it("tem índice parcial — a aba filtra por `is_personal` + dono", () => {
    expect(MIGRATION).toMatch(/create index if not exists idx_contacts_org_personal_dono/);
    expect(MIGRATION).toMatch(/where \(is_personal = true\)/);
  });

  it("o baseline espelha a coluna (test:db sobe SÓ o baseline)", () => {
    expect(BASELINE).toMatch(/add column if not exists personal_owner_user_id uuid/);
    expect(BASELINE).toMatch(/idx_contacts_org_personal_dono/);
  });
});
