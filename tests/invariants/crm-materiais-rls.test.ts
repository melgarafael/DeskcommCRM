import { describe, expect, it } from "vitest";

import { DOCUMENT_MIMES } from "@/lib/messaging/media/upload-validation";
import { BUCKET_DOS_MATERIAIS, TAMANHO_MAXIMO_DO_MATERIAL } from "@/lib/materiais/materiais";

import { countAs, lastLine, sql } from "./gov-helpers";

/**
 * O MATERIAL DA EMPRESA NÃO ATRAVESSA ORGANIZAÇÕES (#4129, migration 9222).
 *
 * ═══ As duas portas, e por que as duas são medidas aqui ═══
 *
 * A LINHA (`crm_materiais`) é lida pelo PostgREST com a anon key + o JWT de
 * qualquer pessoa logada. A policy `tenant_isolation_crm_materiais_select` é a
 * única coisa entre o material de um cliente e o vizinho — e a cópia por
 * service role no turno NÃO tem RLS para barrar o arquivo. Por isso a leitura é
 * medida como `authenticated` com `request.jwt.claims`, o mesmo caminho da
 * produção, nas DUAS direções (A→B e B→A). Só uma direção passaria verde com uma
 * policy `for all` org-flat que deixasse o dono ler e o vizinho escrever.
 *
 * O ARQUIVO é medido no bucket: privado, com a MESMA allowlist do upload do
 * Inbox, e SEM nenhuma policy em `storage.objects` que o nomeie. Sem policy, o
 * cliente não alcança o objeto por caminho nenhum — o único jeito de o arquivo
 * voltar é a URL assinada curta que o SERVIDOR emite depois de ler a linha; e a
 * linha, como os casos acima provam, é da organização dona. O controle positivo
 * (dois objetos semeados e contados como `postgres`) impede o verde por vácuo.
 *
 * ⚠️ O stub de `storage.objects` do harness não liga RLS (o Supabase real liga).
 * Este arquivo LIGA a RLS no banco dele — cada arquivo de invariante recebe uma
 * cópia própria do molde — para medir o mundo do produto em vez do stub. Sem
 * isso, `authenticated` leria os dois objetos e o caso ficaria vermelho pelo
 * instrumento, não pelo produto.
 *
 * ═══ O que o banco também prende ═══
 *
 * `storage_path` tem de começar com `<organization_id>/` (CHECK) e a ligação
 * agente↔material não atravessa organização (gatilho). São a segunda camada:
 * a primeira é o TypeScript (`materialPertenceAOrganizacao`), porque a cópia é
 * service role e não teria RLS para recusar o arquivo alheio.
 */

const ORG_A = "c4a7e012-0000-4000-8000-00000000000a";
const ORG_B = "c4a7e012-0000-4000-8000-00000000000b";
const AGENTE_A = "c4a7e012-1111-4000-8000-00000000000a";
const AGENTE_B = "c4a7e012-1111-4000-8000-00000000000b";
const MATERIAL_A = "c4a7e012-2222-4000-8000-00000000000a";
const MATERIAL_B = "c4a7e012-2222-4000-8000-00000000000b";
const ARQUIVO_A = `${ORG_A}/11111111-2222-4333-8444-55555555555a.pdf`;
const ARQUIVO_B = `${ORG_B}/11111111-2222-4333-8444-55555555555b.pdf`;

/** Erro esperado de uma escrita recusada: RLS (42501) ou privilégio negado. */
function recusa(script: string): string {
  try {
    sql(script);
  } catch (err) {
    return (err as { stderr?: string }).stderr ?? "";
  }
  throw new Error("a escrita deveria ter sido recusada, e passou");
}

/**
 * Quantos objetos o membro lê — ou `'negado'`.
 *
 * As duas respostas são a MESMA coisa para a pergunta deste arquivo: o cliente
 * não alcança o arquivo. No Supabase real `storage.objects` responde 0 linhas
 * (RLS ligada, sem policy para o bucket); no harness o stub não concede SELECT a
 * `authenticated` e o Postgres recusa antes, com `permission denied`. Tratar a
 * recusa como falha faria o teste medir a ACL do STUB em vez do produto — e
 * tratar como zero sem registrar esconderia a diferença. Aqui as duas contam
 * como negação, e um número positivo continua reprovando.
 */
function objetosVisiveis(userId: string): number | "negado" {
  try {
    return countAs(
      userId,
      `select count(*) from storage.objects where bucket_id = '${BUCKET_DOS_MATERIAIS}';`,
    );
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    if (/permission denied|row-level security/i.test(stderr)) return "negado";
    throw err;
  }
}

sql(`
  do $t$ begin
    if not (select c.relrowsecurity
              from pg_class c
              join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'storage' and c.relname = 'objects') then
      -- O stub do harness nasce sem RLS; o Supabase real nasce com ela ligada.
      alter table storage.objects enable row level security;
    end if;
  end $t$;

  insert into auth.users (id, email) values
    ('${AGENTE_A}', 'materiais-agent-a@invariant.test'),
    ('${AGENTE_B}', 'materiais-agent-b@invariant.test')
    on conflict (id) do nothing;

  insert into public.organizations (id, slug, legal_name, display_name) values
    ('${ORG_A}', 'materiais-inv-a', 'Materiais Invariant A', 'Materiais A'),
    ('${ORG_B}', 'materiais-inv-b', 'Materiais Invariant B', 'Materiais B')
    on conflict (id) do nothing;

  insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
    ('${AGENTE_A}', '${ORG_A}', 'agent', now()),
    ('${AGENTE_B}', '${ORG_B}', 'agent', now())
    on conflict do nothing;

  insert into public.ai_agents (id, organization_id, name, system_prompt) values
    ('${AGENTE_A}', '${ORG_A}', 'Agente do invariante A', 'oi'),
    ('${AGENTE_B}', '${ORG_B}', 'Agente do invariante B', 'oi')
    on conflict (id) do nothing;

  insert into public.crm_materiais
    (id, organization_id, nome, storage_path, mime, tamanho, quando_enviar, legenda)
  values
    ('${MATERIAL_A}', '${ORG_A}', 'Catálogo A', '${ARQUIVO_A}', 'application/pdf', 1000, 'quando pedirem o catálogo', 'Segue o catálogo'),
    ('${MATERIAL_B}', '${ORG_B}', 'Catálogo B', '${ARQUIVO_B}', 'application/pdf', 1000, 'quando pedirem o catálogo', 'Segue o catálogo')
  on conflict (id) do nothing;

  insert into public.crm_materiais_do_agente (organization_id, agent_id, material_id) values
    ('${ORG_A}', '${AGENTE_A}', '${MATERIAL_A}'),
    ('${ORG_B}', '${AGENTE_B}', '${MATERIAL_B}')
  on conflict do nothing;

  insert into storage.objects (bucket_id, name) values
    ('${BUCKET_DOS_MATERIAIS}', '${ARQUIVO_A}'),
    ('${BUCKET_DOS_MATERIAIS}', '${ARQUIVO_B}')
  on conflict do nothing;
`);

describe("crm_materiais — a linha da organização, nas duas direções", () => {
  it("o membro da org A lê o próprio material e a própria ligação (controle positivo)", () => {
    expect(countAs(AGENTE_A, `select count(*) from public.crm_materiais where id = '${MATERIAL_A}';`)).toBe(1);
    expect(
      countAs(
        AGENTE_A,
        `select count(*) from public.crm_materiais_do_agente where material_id = '${MATERIAL_A}';`,
      ),
    ).toBe(1);
  });

  it("o membro da org A lê ZERO material da org B — e vice-versa", () => {
    expect(countAs(AGENTE_A, `select count(*) from public.crm_materiais where organization_id = '${ORG_B}';`)).toBe(0);
    expect(countAs(AGENTE_B, `select count(*) from public.crm_materiais where organization_id = '${ORG_A}';`)).toBe(0);
  });

  it("a ligação agente↔material também não atravessa", () => {
    expect(
      countAs(
        AGENTE_A,
        `select count(*) from public.crm_materiais_do_agente where organization_id = '${ORG_B}';`,
      ),
    ).toBe(0);
    expect(
      countAs(
        AGENTE_B,
        `select count(*) from public.crm_materiais_do_agente where organization_id = '${ORG_A}';`,
      ),
    ).toBe(0);
  });

  it("membro não ESCREVE: o cadastro é do servidor, não do PostgREST", () => {
    const erro = recusa(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${AGENTE_A}"}', false);
      insert into public.crm_materiais (organization_id, nome, storage_path, mime, tamanho)
        values ('${ORG_A}', 'Forjado', '${ORG_A}/forjado.pdf', 'application/pdf', 10);
    `);
    expect(erro).toMatch(/permission denied|row-level security/i);
  });
});

describe("storage — o arquivo só sai pela porta do servidor", () => {
  it(`o bucket ${BUCKET_DOS_MATERIAIS} existe PRIVADO, com o teto e a allowlist do upload`, () => {
    const linha = lastLine(
      sql(`select public::text || '|' || file_size_limit::text
             from storage.buckets where id = '${BUCKET_DOS_MATERIAIS}';`),
    );
    expect(linha).toBe(`false|${TAMANHO_MAXIMO_DO_MATERIAL}`);

    const tipos = new Set(
      lastLine(
        sql(`select coalesce(array_to_string(allowed_mime_types, ','), 'NULO')
               from storage.buckets where id = '${BUCKET_DOS_MATERIAIS}';`),
      ).split(","),
    );
    // O que o upload do Inbox aceita tem de poder ser cadastrado como material:
    // duas listas divergentes fariam a tela aceitar o que o bucket recusa.
    for (const mime of DOCUMENT_MIMES) expect(tipos.has(mime), `bucket sem ${mime}`).toBe(true);
    for (const imagem of ["image/jpeg", "image/png"]) expect(tipos.has(imagem)).toBe(true);
  });

  it("NENHUMA policy de storage.objects nomeia o bucket — só o service_role lê e grava", () => {
    const policies = lastLine(
      sql(`select coalesce(string_agg(policyname, ',' order by policyname), 'NENHUMA')
             from pg_policies
            where schemaname = 'storage' and tablename = 'objects'
              and (coalesce(qual, '') || coalesce(with_check, '')) like '%${BUCKET_DOS_MATERIAIS}%';`),
    );
    expect(policies).toBe("NENHUMA");
  });

  it("o membro de NENHUMA organização alcança os objetos direto (zero pelo cliente)", () => {
    // Nenhuma das duas respostas pode ser um número positivo: é isso que a
    // asserção mede. O `negado` está explicado em `objetosVisiveis`.
    expect([0, "negado"]).toContain(objetosVisiveis(AGENTE_A));
    expect([0, "negado"]).toContain(objetosVisiveis(AGENTE_B));
  });

  it("os dois arquivos existem (controle positivo do instrumento)", () => {
    const total = lastLine(
      sql(`select count(*) from storage.objects where bucket_id = '${BUCKET_DOS_MATERIAIS}'
             and name in ('${ARQUIVO_A}', '${ARQUIVO_B}');`),
    );
    expect(Number(total)).toBe(2);
  });
});

describe("o banco prende o que o TypeScript também confere", () => {
  it("storage_path de OUTRA organização é recusado pelo CHECK", () => {
    const erro = recusa(`
      insert into public.crm_materiais (organization_id, nome, storage_path, mime, tamanho)
        values ('${ORG_A}', 'Caminho alheio', '${ARQUIVO_B}', 'application/pdf', 10);
    `);
    expect(erro).toMatch(/crm_materiais_caminho_da_organizacao|check constraint/i);
    expect(
      lastLine(sql(`select count(*) from public.crm_materiais where nome = 'Caminho alheio';`)),
    ).toBe("0");
  });

  it("ligar o agente da org A a um material da org B é recusado pelo gatilho", () => {
    const erro = recusa(`
      insert into public.crm_materiais_do_agente (organization_id, agent_id, material_id)
        values ('${ORG_A}', '${AGENTE_A}', '${MATERIAL_B}');
    `);
    expect(erro).toMatch(/não é da organização/);
    expect(
      lastLine(
        sql(`select count(*) from public.crm_materiais_do_agente
              where organization_id = '${ORG_A}' and material_id = '${MATERIAL_B}';`),
      ),
    ).toBe("0");
  });

  it("nenhuma tabela nova ficou sem RLS", () => {
    const sem = lastLine(
      sql(`select coalesce(string_agg(c.relname, ',' order by c.relname), 'NENHUMA')
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r'
              and c.relname in ('crm_materiais', 'crm_materiais_do_agente')
              and c.relrowsecurity = false;`),
    );
    expect(sem).toBe("NENHUMA");
  });
});
