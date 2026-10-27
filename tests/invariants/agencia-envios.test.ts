import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * OS ENVIOS DA AGÊNCIA (migration 9013, docs/agencia/SPEC-envios.md): o material
 * novo da aprovação (texto e arquivo) continua isolado por organização; a fila de
 * cópia para o Drive fica fora do alcance do PostgREST (guarda a sessão resumível);
 * aviso/ciente entram no vocabulário fechado; o bucket nasce privado e com 2 GB.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)");
const containerName: string = container;

function sql(script: string): string {
  return execFileSync("docker", ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], {
    input: script,
    encoding: "utf8",
  }).trim();
}
const ultimaLinha = (saida: string) => saida.split("\n").pop() ?? "";
const como = (usuario: string, consulta: string) =>
  ultimaLinha(
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${usuario}"}', false);
      ${consulta}
    `),
  );

const ORG_A = "90130013-0000-4000-8000-00000000000a";
const ORG_B = "90130013-0000-4000-8000-00000000000b";
const MEMBRO_A = "90130013-1111-4000-8000-00000000000a";
const MEMBRO_B = "90130013-1111-4000-8000-00000000000b";
const CLIENTE_A = "90130013-2222-4000-8000-00000000000a";
const ENVIO = "90130013-3333-4000-8000-00000000000a";
const AVISO = "90130013-3333-4000-8000-00000000000b";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${MEMBRO_A}', 'envios-9013-a@invariant.test'),
      ('${MEMBRO_B}', 'envios-9013-b@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'envios-9013-a', 'Envios A', 'Envios A'),
      ('${ORG_B}', 'envios-9013-b', 'Envios B', 'Envios B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MEMBRO_A}', '${ORG_A}', 'agent', now()),
      ('${MEMBRO_B}', '${ORG_B}', 'agent', now())
      on conflict do nothing;
    insert into public.agencia_clientes (id, nome, organization_id) values ('${CLIENTE_A}', 'Cliente 9013 A', '${ORG_A}') on conflict do nothing;
    insert into public.agencia_aprovacoes (id, organization_id, cliente_id, tipo, titulo, arquivo_caminho, arquivo_nome, arquivo_mime, arquivo_bytes)
      values ('${ENVIO}', '${ORG_A}', '${CLIENTE_A}', 'video', 'Reels 9013', '${CLIENTE_A}/${ENVIO}.mp4', 'reels.mp4', 'video/mp4', 1048576)
      on conflict do nothing;
    insert into public.agencia_aprovacoes (id, organization_id, cliente_id, tipo, titulo, texto)
      values ('${AVISO}', '${ORG_A}', '${CLIENTE_A}', 'aviso', 'Gravação remarcada', 'A gravação passou para quinta.')
      on conflict do nothing;
  `);
});

describe("o material novo continua isolado por organização", () => {
  it("o cliente lê o próprio envio e o aviso; o vizinho, nada", () => {
    expect(como(MEMBRO_A, `select count(*) from public.agencia_aprovacoes where cliente_id = '${CLIENTE_A}' and (arquivo_caminho is not null or texto is not null);`)).toBe("2");
    expect(como(MEMBRO_B, `select count(*) from public.agencia_aprovacoes where cliente_id = '${CLIENTE_A}';`)).toBe("0");
  });

  it("o cliente não grava o próprio 'ciente' pela REST — só o servidor", () => {
    // Sem policy de UPDATE: a RLS devolve zero linhas (ou o grant recusa). Nos dois casos, nada muda.
    try {
      como(MEMBRO_A, `update public.agencia_aprovacoes set situacao = 'ciente' where id = '${AVISO}'; select 1;`);
    } catch {
      // recusado pelo grant — também vale
    }
    expect(sql(`select situacao from public.agencia_aprovacoes where id = '${AVISO}';`)).toBe("pendente");
  });
});

describe("a fila de cópia para o Drive é da instalação", () => {
  it("anon e authenticated não leem agencia_envios_copias", () => {
    sql(`insert into public.agencia_envios_copias (aprovacao_id, sessao) values ('${ENVIO}', 'https://upload.example/sessao-secreta') on conflict do nothing;`);
    expect(() => como(MEMBRO_A, "select count(*) from public.agencia_envios_copias;")).toThrow(/permission denied/);
    expect(() => sql("set role anon; select count(*) from public.agencia_envios_copias;")).toThrow(/permission denied/);
  });

  it("situação fechada e cascata da aprovação", () => {
    expect(() => sql(`update public.agencia_envios_copias set situacao = 'quase' where aprovacao_id = '${ENVIO}';`)).toThrow(/agencia_envios_copias_situacao/);
    sql(`
      insert into public.agencia_aprovacoes (id, organization_id, cliente_id, tipo, titulo, texto)
        values ('90130013-3333-4000-8000-0000000000cc', '${ORG_A}', '${CLIENTE_A}', 'roteiro', 'Temporário', 'texto');
      insert into public.agencia_envios_copias (aprovacao_id) values ('90130013-3333-4000-8000-0000000000cc');
      delete from public.agencia_aprovacoes where id = '90130013-3333-4000-8000-0000000000cc';
    `);
    expect(sql("select count(*) from public.agencia_envios_copias where aprovacao_id = '90130013-3333-4000-8000-0000000000cc';")).toBe("0");
  });
});

describe("as regras que moram no banco", () => {
  it("aviso e ciente entram no vocabulário; o resto não", () => {
    sql(`update public.agencia_aprovacoes set situacao = 'ciente' where id = '${AVISO}';`);
    expect(() => sql(`update public.agencia_aprovacoes set tipo = 'recado' where id = '${AVISO}';`)).toThrow(/agencia_aprovacoes_tipo/);
    expect(() => sql(`update public.agencia_aprovacoes set situacao = 'lido' where id = '${AVISO}';`)).toThrow(/agencia_aprovacoes_situacao/);
  });

  it("arquivo exige tamanho de 1 byte a 2 GB e caminho sem '..'", () => {
    expect(() => sql(`update public.agencia_aprovacoes set arquivo_bytes = null where id = '${ENVIO}';`)).toThrow(/agencia_aprovacoes_arquivo/);
    expect(() => sql(`update public.agencia_aprovacoes set arquivo_bytes = 2147483649 where id = '${ENVIO}';`)).toThrow(/agencia_aprovacoes_arquivo/);
    expect(() => sql(`update public.agencia_aprovacoes set arquivo_caminho = '${CLIENTE_A}/../x.mp4' where id = '${ENVIO}';`)).toThrow(/agencia_aprovacoes_arquivo/);
  });

  it("o bucket nasce privado, com 2 GB e só os tipos aceitos", () => {
    expect(sql("select public::text || '|' || file_size_limit || '|' || array_length(allowed_mime_types, 1) from storage.buckets where id = 'agencia-envios';")).toBe("false|2147483648|7");
  });
});
