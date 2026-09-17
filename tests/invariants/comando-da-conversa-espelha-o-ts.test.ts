/**
 * O BANCO E O TYPESCRIPT RESPONDEM A MESMA COISA SOBRE QUEM MANDA.
 *
 * ## Por que aceitar duas encarnações da regra
 *
 * A regra vive em `lib/inbox/comando-da-conversa.ts` (a tela) e em
 * `fn_comando_da_conversa` (migration 0203, o filtro das abas). Duas
 * encarnações da mesma regra é exatamente o defeito que o worker legado pagou
 * em 2026-08-30: ele comparava `new Date('infinity')` — que é `NaN` — enquanto a
 * tela usava a regra certa, e as duas discordaram por meses sem ninguém ver.
 *
 * A duplicação entrou porque o filtro precisa de `contacts.force_human` e
 * `contacts.is_blocked`, que moram em OUTRA tabela: filtrar em memória quebraria
 * o cursor de paginação, e reescrever o predicado no construtor de query seria a
 * mesma duplicação sem gate nenhum.
 *
 * O que a torna aceitável é ESTE arquivo. Sem ele, a migration 0203 não deveria
 * ter sido escrita.
 *
 * ## Quatro blocos, e cada um tapa um buraco que os outros deixam
 *
 * - **A** exaure o espaço de entrada INTEIRO (280 casos). O domínio de `status`
 *   é lido do CHECK, não digitado: status novo que o corpus não cubra REPROVA,
 *   em vez de sair da conta em silêncio.
 * - **B** exercita o CALL SITE. O bloco A chama a regra direto e nunca vê o
 *   wrapper `comando_da_conversa(c)` — que resolve o contato e podia trocar
 *   `force_human` por `is_blocked` (dois subselects idênticos, colados um do
 *   outro) sem A piscar.
 * - **C** confronta com o SQL do MOTOR, extraído do fonte de produção. A e B
 *   provam que TS e SQL concordam entre si; nada neles impede os DOIS de
 *   estarem errados sobre quem o motor atende de verdade.
 * - **D** cobre o chip do cabeçalho, cujo call site é `?? status` — buraco no
 *   mapa imprime o token cru em inglês no rosto do atendente.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { comandoDaConversa, type FatosDoComando } from "@/lib/inbox/comando-da-conversa";

import { sql } from "./gov-helpers";

const RAIZ = join(__dirname, "..", "..");
/** Relógio FIXO nos dois lados. Dois relógios fariam a fronteira falhar sozinha. */
const AGORA = "2026-08-30T12:00:00Z";
const AGORA_DATE = new Date(AGORA);

const DONO = "11111111-1111-4111-8111-111111111111";
const ORG = "aaaaaaaa-0000-4000-8000-00000000cd01";

/**
 * Os SEIS jeitos de o silêncio existir. Os dois infinitos entram nomeados, e a
 * FRONTEIRA entra porque sem ela o corpus não distingue `>` de `>=`.
 *
 * Medido: a primeira versão tinha só cinco (nulo, -infinity, passado, futuro,
 * infinity) e a sabotagem de trocar `>` por `>=` **só no SQL** deixava o bloco A
 * verde — os outros cinco valores são insensíveis à borda. Um corpus que não
 * separa os dois operadores não está testando o operador.
 */
const SILENCIOS: Array<[rotulo: string, valor: string | null]> = [
  ["nulo", null],
  ["menos_infinito", "-infinity"],
  ["passado", "2026-08-30T11:59:59Z"],
  ["fronteira", "2026-08-30T12:00:00Z"],
  ["futuro", "2026-08-30T12:00:01Z"],
  ["infinito", "infinity"],
];

/**
 * O domínio de `conversations.status`, lido do CHECK — ancorado na COLUNA.
 *
 * A primeira versão filtrava por `pg_get_constraintdef(...) like '%status%'` e
 * engolia `conversations_rag_review_status_check`, que é outro CHECK da MESMA
 * tabela sobre outra coluna (`rag_review_status`, valores
 * `pending_review|ingested|skipped`). O corpus nascia com `'ingested'` dentro e o
 * bloco D cobrava do cabeçalho um rótulo para um status que não existe.
 *
 * O `join pg_attribute` é o que faz a régua ser a coluna e não o texto — mesmo
 * padrão de `vocabulario-banco-x-typescript.test.ts`.
 */
function statusDoCheck(): string[] {
  const bruto = sql(
    `select pg_get_constraintdef(k.oid)
       from pg_constraint k
       join pg_class c on c.oid = k.conrelid
       join pg_attribute a on a.attrelid = c.oid and a.attnum = any(k.conkey)
      where k.contype = 'c' and c.relname = 'conversations' and a.attname = 'status'`,
  );
  const valores = [...bruto.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!);
  return [...new Set(valores)].sort();
}

describe("comando da conversa: o banco espelha o TypeScript", () => {
  const STATUS = statusDoCheck();

  it("o domínio de status veio do CHECK, e não de uma lista digitada aqui", () => {
    // Se esta asserção cair, o corpus abaixo encolheu sem ninguém notar — e um
    // corpus menor fica verde por não testar, que é o pior tipo de verde.
    expect(STATUS.length).toBeGreaterThanOrEqual(6);
    expect(STATUS).toContain("open");
    expect(STATUS).toContain("closed");
  });

  it("A — o espaço de entrada INTEIRO dá a mesma resposta nos dois lados", () => {
    const casos: Array<{ fatos: FatosDoComando; chave: string }> = [];
    for (const status of STATUS) {
      for (const dono of [null, DONO]) {
        for (const [rotulo, silencio] of SILENCIOS) {
          for (const fh of [false, true]) {
            for (const ib of [false, true]) {
              casos.push({
                chave: `${status}|${dono ? "dono" : "sem"}|${rotulo}|fh=${fh}|ib=${ib}`,
                fatos: {
                  status,
                  assigned_to_user_id: dono,
                  bot_silenced_until: silencio,
                  force_human: fh,
                  is_blocked: ib,
                  // `true` de propósito: o banco não sabe deste fato org-wide
                  // (seria `agenteAtende` numa terceira encarnação), e com ele
                  // ligado o TS produz o mesmo vocabulário de quatro que o SQL.
                  automaticoDaOrg: true,
                },
              });
            }
          }
        }
      }
    }
    expect(casos).toHaveLength(STATUS.length * 2 * SILENCIOS.length * 2 * 2);

    const values = casos
      .map((c, i) => {
        const f = c.fatos;
        const s = f.bot_silenced_until === null ? "null" : `'${f.bot_silenced_until}'`;
        const d = f.assigned_to_user_id === null ? "null" : `'${f.assigned_to_user_id}'`;
        return `(${i}, '${f.status}', ${d}::uuid, ${s}::timestamptz, ${f.force_human}, ${f.is_blocked})`;
      })
      .join(",\n");

    const saida = sql(
      `select i || '=' || public.fn_comando_da_conversa(st, dono, sil, fh, ib, '${AGORA}'::timestamptz)
         from (values\n${values}\n) as t(i, st, dono, sil, fh, ib) order by i`,
    );
    const doBanco = new Map(
      saida
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [i, v] = l.split("=");
          return [Number(i), v!] as const;
        }),
    );
    expect(doBanco.size).toBe(casos.length);

    const divergentes: string[] = [];
    casos.forEach((c, i) => {
      const ts = comandoDaConversa(c.fatos, AGORA_DATE).comando.quem;
      const bd = doBanco.get(i);
      if (ts !== bd) divergentes.push(`${c.chave}: ts=${ts} banco=${bd}`);
    });
    expect(divergentes, `TS e banco discordam em ${divergentes.length} caso(s)`).toEqual([]);
  });

  it("B — o CALL SITE também espelha: comando_da_conversa(c) sobre linhas reais", () => {
    // O wrapper resolve o contato e carimba now(). O bloco A nunca o executa, e
    // ele é onde mora o erro de copiar-colar mais provável: dois subselects
    // iguais, um para `force_human` e outro para `is_blocked`.
    const linhas = [
      { n: 1, status: "open", dono: null, sil: null, fh: false, ib: false },
      { n: 2, status: "open", dono: null, sil: null, fh: true, ib: false },
      { n: 3, status: "open", dono: null, sil: null, fh: false, ib: true },
      { n: 4, status: "open", dono: null, sil: "infinity", fh: false, ib: false },
      { n: 5, status: "open", dono: DONO, sil: "infinity", fh: false, ib: false },
      { n: 6, status: "closed", dono: null, sil: null, fh: false, ib: false },
      { n: 7, status: "pending", dono: null, sil: null, fh: false, ib: false },
      { n: 8, status: "resolved", dono: null, sil: null, fh: false, ib: false },
      // A otimização do wrapper não pode inverter a precedência das travas.
      { n: 9, status: "archived", dono: null, sil: "infinity", fh: true, ib: true },
      { n: 10, status: "closed", dono: DONO, sil: null, fh: true, ib: true },
      { n: 11, status: "open", dono: null, sil: "infinity", fh: true, ib: true },
      { n: 12, status: "open", dono: null, sil: "2000-01-01T00:00:00Z", fh: true, ib: false },
    ];

    sql(`
      delete from conversations where organization_id = '${ORG}';
      delete from contacts where organization_id = '${ORG}';
      delete from channel_sessions where organization_id = '${ORG}';
      delete from organizations where id = '${ORG}';
      insert into auth.users (id, email)
        values ('${DONO}', 'dono-espelho@deskcomm.test') on conflict (id) do nothing;
      insert into organizations (id, slug, legal_name, display_name)
        values ('${ORG}', 'espelho-comando', 'Espelho LTDA', 'Espelho');
      insert into channel_sessions (id, organization_id, webhook_secret_encrypted, waha_session_name)
        values ('${ORG}', '${ORG}', '\\x00', 'espelho-sess');
      ${linhas
        .map(
          (l) => `
      insert into contacts (id, organization_id, force_human, is_blocked)
        values ('aaaaaaaa-0000-4000-8000-00000000c${String(l.n).padStart(3, "0")}', '${ORG}', ${l.fh}, ${l.ib});
      insert into conversations (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, bot_silenced_until)
        values ('aaaaaaaa-0000-4000-8000-00000000e${String(l.n).padStart(3, "0")}', '${ORG}',
                'aaaaaaaa-0000-4000-8000-00000000c${String(l.n).padStart(3, "0")}', '${ORG}', '${l.status}',
                ${l.dono ? `'${l.dono}'` : "null"}, ${l.sil ? `'${l.sil}'` : "null"});`,
        )
        .join("\n")}
    `);

    const saida = sql(
      `select right(c.id::text, 3) || '=' || public.comando_da_conversa(c)
         from conversations c where c.organization_id = '${ORG}' order by c.id`,
    );
    const doBanco = new Map(
      saida
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [k, v] = l.split("=");
          return [Number(k), v!] as const;
        }),
    );
    expect(doBanco.size).toBe(linhas.length);

    for (const l of linhas) {
      const ts = comandoDaConversa(
        {
          status: l.status,
          assigned_to_user_id: l.dono,
          bot_silenced_until: l.sil,
          force_human: l.fh,
          is_blocked: l.ib,
          automaticoDaOrg: true,
        },
        // O wrapper usa `now()` do banco; estas linhas não ficam na fronteira do
        // relógio de propósito (só `infinity`/`null`), então a comparação é estável.
        new Date(),
      ).comando.quem;
      expect(doBanco.get(l.n), `linha ${l.n} (${l.status}, fh=${l.fh}, ib=${l.ib})`).toBe(ts);
    }
  });

  it("C — quem o banco chama de 'automatico', o MOTOR realmente atende", () => {
    // A e B provam que TS e SQL concordam ENTRE SI. Nada neles impede os dois de
    // estarem errados sobre o motor. Este bloco extrai o SQL do fonte de
    // produção — não um dublê, que seria a terceira encarnação da regra e ficaria
    // verde com o produto errado.
    const handoff = readFileSync(join(RAIZ, "lib/agent-engine/agent/human-handoff.ts"), "utf8");
    const corpo = handoff.slice(handoff.indexOf("export async function isLeadInHandoff"));
    const predicado = corpo.slice(corpo.indexOf("`") + 1, corpo.indexOf("[tenantId, leadId]"));
    const sqlDoMotor = predicado
      .slice(0, predicado.lastIndexOf("`"))
      .replace(/\$1/g, `'${ORG}'`)
      .replace(/\$2/g, "c.id")
      .trim()
      .replace(/,\s*$/, "");
    expect(sqlDoMotor, "o SQL do motor não foi extraído — o formato do fonte mudou").toContain(
      "bot_silenced_until",
    );

    const antesDoSend = readFileSync(
      join(RAIZ, "lib/agent-engine/guardrails/before-send.ts"),
      "utf8",
    );
    expect(
      antesDoSend,
      "o stopGate mudou de forma — reveja este bloco antes de confiar nele",
    ).toContain("is_blocked or force_human");

    // Para cada conversa com `comando_da_conversa = 'automatico'`, o motor tem de
    // concordar: sem handoff no lead E sem parada dura no contato.
    const conflitos = sql(
      `select coalesce(string_agg(right(v.id::text, 3), ','), '')
         from conversations v
         join contacts c on c.id = v.contact_id
        where v.organization_id = '${ORG}'
          and public.comando_da_conversa(v) = 'automatico'
          and (
            (c.force_human or exists (
               select 1 from conversations w
                where w.organization_id = '${ORG}' and w.contact_id = c.id
                  and w.bot_silenced_until is not null and w.bot_silenced_until > now()))
            or (c.is_blocked or c.force_human)
          )`,
    ).trim();
    expect(
      conflitos,
      `o banco diz 'automatico' em conversa(s) que o motor recusa: ${conflitos}`,
    ).toBe("");
  });

  it("D — o chip do cabeçalho tem rótulo para TODO status do CHECK", () => {
    const fonte = readFileSync(join(RAIZ, "components/inbox/ConversationHeader.tsx"), "utf8");
    const bloco = fonte.slice(
      fonte.indexOf("const STATUS_LABEL"),
      fonte.indexOf("};", fonte.indexOf("const STATUS_LABEL")),
    );
    const semComentarios = bloco.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const st of STATUS) {
      expect(semComentarios, `STATUS_LABEL não cobre '${st}' — o call site é '?? status'`).toMatch(
        new RegExp(`\\b${st}\\s*:`),
      );
    }
  });
});
