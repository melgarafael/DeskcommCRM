import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * UM AGENTE PODE TER MAIS DE UM MATERIAL INDEXADO.
 *
 * ═══ O defeito, medido em produção antes deste teste existir ════════════════
 *
 * Cinco materiais subidos para o mesmo agente: UM indexou (14 trechos), quatro
 * ficaram em `pending` com `attempts=2`, repetindo
 *
 *     createKnowledgeVersion: insert failed — duplicate key value violates
 *     unique constraint "ai_kbv_version_unique"
 *
 * e a tela mostrava os cinco como `ready`, com `chunks_count = 0`. É o pior
 * formato de falha que este repo persegue: o painel diz pronto, a busca não
 * responde nada, e não há erro em lugar nenhum que o dono da instalação veja.
 *
 * ═══ A causa é DIVERGÊNCIA entre código e schema, não corrida ═══════════════
 *
 * A 0181 passou a contar o número da versão por `knowledge_source_id` — é o que
 * `lib/ai/rag/version.ts` faz. O índice único ficou em `(agent_id,
 * version_number)`. Toda fonte nova nasce em `version_number = 1`, então a
 * segunda fonte do mesmo agente colide com a primeira. Determinístico: não
 * adianta repetir, nunca passa.
 *
 * ═══ O que este arquivo mede ═══════════════════════════════════════════════
 *
 * Os dois lados, porque só o primeiro deixaria passar um índice que não existe:
 * duas FONTES do mesmo agente convivem com o mesmo número (era o defeito), e a
 * MESMA fonte segue proibida de repetir número (é o invariante que se preserva).
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db`");
}
const c: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", c, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

/** Conta as linhas que existem DEPOIS da tentativa — presença é o que decide. */
function tentarInserirVersao(id: string, fonte: string, numero: number): boolean {
  sql(`
    do $$ begin
      insert into public.ai_knowledge_versions
        (id, organization_id, agent_id, knowledge_source_id, version_number, status)
      values ('${id}', '${ORG}', '${AGENTE}', ${fonte}, ${numero}, 'building');
    exception when others then null; end $$;
    select 1;
  `);
  return sql(`select count(*) from public.ai_knowledge_versions where id = '${id}';`)
    .split("\n").pop() === "1";
}

const ORG = "b0b0b0b0-0000-4000-8000-00000000000a";
const AGENTE = "b0b0b0b0-2222-4000-8000-00000000000a";
const FONTE_A = "b0b0b0b0-3333-4000-8000-00000000000a";
const FONTE_B = "b0b0b0b0-3333-4000-8000-00000000000b";

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'acervo-inv', 'Acervo Invariant', 'Acervo') on conflict (id) do nothing;

    insert into public.ai_agents (id, organization_id, name, system_prompt)
      values ('${AGENTE}', '${ORG}', 'Agente do invariante', '') on conflict (id) do nothing;

    insert into public.ai_knowledge_sources
      (id, organization_id, agent_id, source_type, name, status, is_active)
    values
      ('${FONTE_A}', '${ORG}', '${AGENTE}', 'documento', 'Material A', 'ready', true),
      ('${FONTE_B}', '${ORG}', '${AGENTE}', 'documento', 'Material B', 'ready', true)
      on conflict (id) do nothing;
  `);
});

describe("ai_knowledge_versions — o número da versão conta por MATERIAL", () => {
  it("o primeiro material do agente indexa (controle positivo)", () => {
    const ok = tentarInserirVersao("b0b0b0b0-4444-4000-8000-00000000000a", `'${FONTE_A}'`, 1);
    expect(ok, "nem o primeiro material entrou — a sonda está cega").toBe(true);
  });

  it("o SEGUNDO material do mesmo agente também indexa — era exatamente isto que falhava", () => {
    const ok = tentarInserirVersao("b0b0b0b0-4444-4000-8000-00000000000b", `'${FONTE_B}'`, 1);
    expect(ok, "o segundo material do agente continua colidindo com o primeiro").toBe(true);
  });

  it("a MESMA fonte não repete número — o invariante que se preserva", () => {
    // Sem este caso, apagar o índice e não pôr nada no lugar passaria nos dois
    // acima. "Mais permissivo" não é o objetivo; o objetivo é permitir o que a
    // 0181 quis e continuar proibindo o resto.
    const ok = tentarInserirVersao("b0b0b0b0-4444-4000-8000-00000000000c", `'${FONTE_A}'`, 1);
    expect(ok, "a mesma fonte conseguiu repetir version_number").toBe(false);
  });

  it("versão LEGADA (fonte NULL) segue única por agente", () => {
    // As versões anteriores à 0181 têm `knowledge_source_id` NULL e continuam
    // válidas. Um índice puro por fonte as deixaria sem restrição nenhuma —
    // NULL não colide com NULL em Postgres.
    const primeira = tentarInserirVersao("b0b0b0b0-5555-4000-8000-00000000000a", "null", 90);
    expect(primeira, "a versão legada nem entrou — sonda cega").toBe(true);

    const repetida = tentarInserirVersao("b0b0b0b0-5555-4000-8000-00000000000b", "null", 90);
    expect(repetida, "duas versões legadas com o mesmo número no mesmo agente").toBe(false);
  });
});
