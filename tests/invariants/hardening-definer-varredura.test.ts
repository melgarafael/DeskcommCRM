import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * VARREDURA de `security definer` no schema public (issue #128).
 *
 * ## O defeito que fez este arquivo existir
 *
 * `baseline.sql` tem, por paridade com o Supabase:
 *
 *     ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
 *       GRANT ALL ON FUNCTIONS TO anon;      (e a irmã, TO authenticated)
 *
 * Ele vale para toda função criada DEPOIS dele — ou seja, para **todo apêndice
 * novo**, que por construção nasce no fim do arquivo — e concede um grant
 * DIRETO, que `revoke all ... from public` não remove. Copiar as duas linhas
 * padrão de uma função antiga, que é o que qualquer pessoa faz, produz função
 * exposta. O produto é self-host e o kit aplica SÓ o baseline: uma migration
 * com os revokes certos não protege ninguém se o apêndice não os repetir.
 *
 * ## Por que uma varredura, e não mais uma lista
 *
 * O gate anterior (`gov-hardening-anon-definer.test.ts`) prova o revoke numa
 * lista FIXA de 6 funções. Ele continua valendo — prova o `permission denied`
 * sob role anon real, que é evidência de comportamento, mais forte do que ler
 * catálogo. Mas lista fixa não cobre função nova: no dia em que este arquivo
 * foi escrito, **8 das 25** definer de public tinham EXECUTE para anon e os
 * seis gates obrigatórios estavam verdes. Entre elas
 * `fn_publish_ai_agent_version`, que ESCREVE e recebe o org por argumento sem
 * checar membership.
 *
 * ## As duas regras, e por que são duas
 *
 * `anon` e `authenticated` correm riscos diferentes, então uma regra só não
 * serve — e fundi-las esconderia qual das duas está de fato vigiada:
 *
 *   - **anon**: nenhuma definer de public executável. Sem exceção. É a anon key
 *     que vai para o browser; qualquer definer aqui é RPC pública do PostgREST.
 *   - **authenticated**: definer **volátil** (a que pode escrever) só continua
 *     executável se houver call site com a sessão do usuário. Sem isso, o grant
 *     é superfície morta que permite escrita cross-tenant — usuário logado no
 *     tenant A chamando a função com o org do tenant B.
 *
 * Definer **estável** (só lê) não entra na segunda regra de propósito: os
 * helpers de RLS (`fn_user_org_ids`, `fn_can_view_lead`, …) são avaliados
 * dentro das policies com o papel de quem consulta, então `authenticated`
 * PRECISA de EXECUTE neles. Proibi-los quebraria toda leitura logada.
 */

/** Uma exceção só existe com razão escrita — entrada sem razão é dívida muda. */
interface Excecao {
  readonly fn: string;
  readonly razao: string;
}

/**
 * Vazia, e é para continuar assim. Se você precisa expor uma definer à anon,
 * o caminho é uma função `security invoker` com policy — não uma exceção aqui.
 */
const ANON_PERMITIDO: readonly Excecao[] = [];

/**
 * Definer volátil que `authenticated` PRECISA chamar, com o call site nomeado.
 * Cada uma foi verificada em `app/`, `lib/` e `workers/`: só entra quem é
 * chamada com o client de sessão do usuário, nunca com o de service role.
 */
const AUTHENTICATED_PERMITIDO: readonly Excecao[] = [
  {
    fn: "emit_event(text,text,uuid,jsonb,jsonb,uuid)",
    razao:
      "Server Actions chamam com a sessão do usuário " +
      "(app/actions/settings/updateProfile.ts, updateTenant.ts).",
  },
  {
    fn: "fn_conversation_assign(uuid,uuid,uuid,text,uuid,boolean)",
    razao:
      "Rotas de claim/release/transfer chamam com a sessão do usuário " +
      "(app/api/v1/conversations/[id]/*). A função faz a própria checagem de " +
      "membership e papel.",
  },
  {
    fn: "fn_mesclar_contatos(uuid,uuid,uuid[])",
    razao:
      "A rota POST /api/v1/contacts/merge chama com a sessão do usuário, de " +
      "propósito: é `auth.uid()` que faz a função reconferir o papel (piso " +
      "`manager`, o mesmo das policies de merge_queue) e que assina a atividade " +
      "da timeline. Trocar pelo client de service role apagaria as duas coisas. " +
      "Mesmo desenho de fn_conversation_assign, acima.",
  },
  {
    fn: "fn_log_event(uuid,text,jsonb)",
    razao:
      "Chamada de dentro dos triggers de domínio; o grant a authenticated foi " +
      "declarado pela migration 0034 e não há call site de RPC para removê-lo " +
      "com segurança sem medir o disparo de cada trigger.",
  },
];

interface Definer {
  readonly assinatura: string;
  readonly anon: boolean;
  readonly authenticated: boolean;
  /** provolatile: 'v' volátil (pode escrever), 's' estável, 'i' imutável. */
  readonly volatilidade: string;
}

function inventario(): Definer[] {
  const out = sql(`
    select p.oid::regprocedure::text
           || '\t' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
           || '\t' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
           || '\t' || p.provolatile::text
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef
     order by 1;
  `);
  return out
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((linha) => {
      const [assinatura, anon, auth, vol] = linha.split("\t");
      return {
        assinatura: (assinatura ?? "").replace(/\s+/g, ""),
        anon: anon === "true",
        authenticated: auth === "true",
        volatilidade: vol ?? "",
      };
    });
}

describe("varredura: SECURITY DEFINER de public não fica exposta", () => {
  it("o inventário não vem vazio (guarda de vacuidade)", () => {
    // Sem isto, um `pg_proc` que deixasse de casar (schema renomeado, coluna
    // trocada de nome numa versão futura) faria as asserções abaixo passarem
    // por AUSÊNCIA de dado — instrumento cego devolvendo verde. O número é o
    // medido em 2026-08-05; a asserção é de ordem de grandeza, não de igualdade,
    // para não virar um contador que reprova a cada função nova.
    expect(inventario().length).toBeGreaterThanOrEqual(20);
  });

  it("nenhuma é executável por anon", () => {
    const permitidas = new Set(ANON_PERMITIDO.map((e) => e.fn));
    const expostas = inventario()
      .filter((f) => f.anon)
      .map((f) => f.assinatura)
      .filter((s) => !permitidas.has(s));
    expect(
      expostas,
      "SECURITY DEFINER executável pela anon key (que vai para o browser). O " +
        "`revoke all ... from public` NÃO cobre o grant direto do ALTER DEFAULT " +
        "PRIVILEGES: acrescente `revoke execute on function ... from anon` no " +
        "apêndice do baseline E na migration.",
    ).toEqual([]);
  });

  it("nenhuma definer VOLÁTIL é executável por authenticated sem razão escrita", () => {
    const permitidas = new Set(AUTHENTICATED_PERMITIDO.map((e) => e.fn));
    const expostas = inventario()
      .filter((f) => f.volatilidade === "v" && f.authenticated)
      .map((f) => f.assinatura)
      .filter((s) => !permitidas.has(s));
    expect(
      expostas,
      "SECURITY DEFINER que pode ESCREVER, executável por qualquer usuário " +
        "logado de qualquer tenant. Se o único call site usa o client de " +
        "service role, revogue de authenticated; se a sessão do usuário chama " +
        "de fato, declare em AUTHENTICATED_PERMITIDO com o call site nomeado.",
    ).toEqual([]);
  });

  it("as exceções declaradas ainda existem e ainda são exceção", () => {
    // Duas mortes possíveis desta lista, e cada uma engana de um jeito:
    // entrada de função que sumiu vira ruído que ninguém ousa apagar; entrada
    // de função que JÁ foi revogada mente dizendo "isto é aceito" sobre algo
    // que já está resolvido.
    const inv = inventario();
    const porAssinatura = new Map(inv.map((f) => [f.assinatura, f]));

    for (const { fn } of AUTHENTICATED_PERMITIDO) {
      const alvo = porAssinatura.get(fn);
      expect(alvo, `exceção para função inexistente: ${fn}`).toBeDefined();
      expect(
        alvo?.authenticated,
        `saiu da exceção: ${fn} já não tem EXECUTE para authenticated — remova de AUTHENTICATED_PERMITIDO`,
      ).toBe(true);
    }

    for (const { fn } of ANON_PERMITIDO) {
      expect(
        porAssinatura.get(fn)?.anon,
        `saiu da exceção: ${fn} já não tem EXECUTE para anon — remova de ANON_PERMITIDO`,
      ).toBe(true);
    }
  });

  it("service_role continua com EXECUTE nas de escrita (probe positivo)", () => {
    // Sem este caso, revogar de TODO MUNDO passaria nos três primeiros — o
    // jeito trivial de deixar a varredura verde é quebrar a ingestão.
    const escrita = [
      "public.fn_upsert_wa_contact(uuid, text, text, text, text, text)",
      "public.fn_upsert_wa_conversation(uuid, uuid, uuid)",
      "public.fn_mark_conversation_message(uuid, text, text, timestamptz)",
      "public.fn_publish_ai_agent_version(uuid, uuid, uuid)",
      "public.activate_kb_version(uuid, uuid)",
    ];
    const semExecute = escrita.filter(
      (assinatura) =>
        sql(
          `select has_function_privilege('service_role', '${assinatura}'::regprocedure, 'EXECUTE');`,
        ) !== "t",
    );
    expect(semExecute, "service_role perdeu EXECUTE — a ingestão para de funcionar").toEqual([]);
  });
});
