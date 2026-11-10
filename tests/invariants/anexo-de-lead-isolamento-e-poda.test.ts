/**
 * ANEXOS DE NEGÓCIO (#3229) contra o Postgres de verdade: a RLS de
 * `crm_lead_attachments` e a poda de mídia (`fn_enfileirar_midia_vencida`,
 * passo 2b) que passou a enxergar o prefixo `{org}/leads/`.
 *
 * Casos, um por modo de falha:
 *   - isolamento entre DUAS organizações, por JWT de um membro: lê a própria
 *     (controle positivo), zero do vizinho, e não escreve na linha dele;
 *   - papel: o `viewer` lê, mas não anexa nem apaga na própria organização;
 *   - o arquivo de anexo VIVO não entra na fila (sem o `not exists` em
 *     `crm_lead_attachments`, a poda apagaria o voucher do cliente);
 *   - o órfão de negócio entra, com o bucket `internal-media`;
 *   - o negócio apagado leva a linha em cascata e o arquivo vira órfão — é o
 *     caminho por que o binário sai quando o negócio sai.
 *
 * A cascata de anonimização do app (que enfileira e apaga as linhas do
 * titular) é TypeScript e está provada em `tests/unit/lead-attachments.test.ts`.
 *
 * Banco próprio por arquivo de teste (issue #207).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { countAs, lastLine, sql, writeCountAs } from "./gov-helpers";

const ORG_A = "32290000-0000-4000-8000-00000000000a";
const ORG_B = "32290000-0000-4000-8000-00000000000b";
const USER_A = "32290000-1111-4000-8000-00000000000a";
const USER_B = "32290000-1111-4000-8000-00000000000b";
const VIEWER_A = "32290000-1111-4000-8000-0000000000a2";
const FUNIL_A = "32290000-2222-4000-8000-00000000000a";
const FUNIL_B = "32290000-2222-4000-8000-00000000000b";
const ETAPA_A = "32290000-3333-4000-8000-00000000000a";
const ETAPA_B = "32290000-3333-4000-8000-00000000000b";
const LEAD_A = "32290000-4444-4000-8000-00000000000a";
const LEAD_B = "32290000-4444-4000-8000-00000000000b";
const ANEXO_A = "32290000-5555-4000-8000-00000000000a";
const ANEXO_B = "32290000-5555-4000-8000-00000000000b";

const VIVO = `${ORG_A}/leads/${LEAD_A}/comprovante/${ANEXO_A}.pdf`;
const DO_VIZINHO = `${ORG_B}/leads/${LEAD_B}/comprovante/${ANEXO_B}.pdf`;
const ORFAO = `${ORG_A}/leads/${LEAD_A}/comprovante/32290000-6666-4000-8000-000000000001.pdf`;

const conta = (q: string) => Number(lastLine(sql(q)));
const naFila = (caminho: string) =>
  conta(`select count(*) from storage_redaction_queue where bucket = 'internal-media' and object_path = '${caminho}'`);

function objeto(nome: string, idadeDias: number): string {
  return `insert into storage.objects (bucket_id, name, metadata, created_at)
          values ('internal-media', '${nome}', '{"size": 4}'::jsonb, now() - interval '${idadeDias} days');`;
}

function organizacao(org: string, user: string, funil: string, etapa: string, lead: string, sufixo: string): string {
  return `
    insert into auth.users (id, email) values ('${user}', 'anexo-${sufixo}@invariant.test') on conflict do nothing;
    insert into organizations (id, slug, legal_name, display_name)
      values ('${org}', 'anexo-lead-${sufixo}', 'Anexo ${sufixo} LTDA', 'Anexo ${sufixo}') on conflict do nothing;
    insert into user_organizations (user_id, organization_id, role, accepted_at)
      values ('${user}', '${org}', 'agent', now()) on conflict do nothing;
    insert into crm_pipelines (id, organization_id, name, slug)
      values ('${funil}', '${org}', 'Funil ${sufixo}', 'funil-${sufixo}') on conflict do nothing;
    insert into crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${etapa}', '${org}', '${funil}', 'Novo', 'novo', 1000) on conflict do nothing;
    insert into crm_leads (id, organization_id, pipeline_id, stage_id, title)
      values ('${lead}', '${org}', '${funil}', '${etapa}', 'Negócio ${sufixo}') on conflict do nothing;`;
}

function anexo(id: string, org: string, lead: string, caminho: string): string {
  return `insert into crm_lead_attachments (id, organization_id, lead_id, field_key, file_name, file_size, mime_type, storage_path)
          values ('${id}', '${org}', '${lead}', 'comprovante', 'voucher.pdf', 4, 'application/pdf', '${caminho}');`;
}

beforeEach(() => {
  sql(`
    insert into storage.buckets (id, name, public) values ('internal-media', 'internal-media', false)
      on conflict (id) do nothing;
    delete from storage_redaction_queue where organization_id in ('${ORG_A}', '${ORG_B}');
    delete from storage.objects where name like '${ORG_A}/%' or name like '${ORG_B}/%';
    delete from crm_lead_attachments where organization_id in ('${ORG_A}', '${ORG_B}');
    ${organizacao(ORG_A, USER_A, FUNIL_A, ETAPA_A, LEAD_A, "a")}
    ${organizacao(ORG_B, USER_B, FUNIL_B, ETAPA_B, LEAD_B, "b")}
    insert into auth.users (id, email) values ('${VIEWER_A}', 'anexo-viewer-a@invariant.test') on conflict do nothing;
    insert into user_organizations (user_id, organization_id, role, accepted_at)
      values ('${VIEWER_A}', '${ORG_A}', 'viewer', now()) on conflict do nothing;
    ${anexo(ANEXO_A, ORG_A, LEAD_A, VIVO)}
    ${anexo(ANEXO_B, ORG_B, LEAD_B, DO_VIZINHO)}
  `);
});

describe("crm_lead_attachments — isolamento entre organizações", () => {
  it("o membro lê o anexo da própria organização e zero do vizinho", () => {
    expect(countAs(USER_A, "select count(*) from crm_lead_attachments;")).toBe(1);
    expect(countAs(USER_A, `select count(*) from crm_lead_attachments where organization_id = '${ORG_B}';`)).toBe(0);
    expect(countAs(USER_B, `select count(*) from crm_lead_attachments where organization_id = '${ORG_A}';`)).toBe(0);
  });

  it("o membro não grava, não altera e não apaga na linha do vizinho", () => {
    expect(
      writeCountAs(
        USER_A,
        `insert into crm_lead_attachments (organization_id, lead_id, field_key, file_name, storage_path)
           values ('${ORG_B}', '${LEAD_B}', 'comprovante', 'intruso.pdf', '${ORG_B}/leads/${LEAD_B}/x/y.pdf')`,
      ),
    ).toBe(0);
    expect(writeCountAs(USER_A, `update crm_lead_attachments set file_name = 'trocado' where id = '${ANEXO_B}'`)).toBe(0);
    expect(writeCountAs(USER_A, `delete from crm_lead_attachments where id = '${ANEXO_B}'`)).toBe(0);
    expect(lastLine(sql(`select file_name from crm_lead_attachments where id = '${ANEXO_B}';`))).toBe("voucher.pdf");
  });

  it("o viewer lê, mas não anexa nem apaga na própria organização", () => {
    expect(countAs(VIEWER_A, "select count(*) from crm_lead_attachments;")).toBe(1);
    expect(
      writeCountAs(
        VIEWER_A,
        `insert into crm_lead_attachments (organization_id, lead_id, field_key, file_name, storage_path)
           values ('${ORG_A}', '${LEAD_A}', 'comprovante', 'viewer.pdf', '${ORG_A}/leads/${LEAD_A}/x/v.pdf')`,
      ),
    ).toBe(0);
    expect(writeCountAs(VIEWER_A, `delete from crm_lead_attachments where id = '${ANEXO_A}'`)).toBe(0);
    // controle positivo do eixo: o agent da mesma organização apaga.
    expect(writeCountAs(USER_A, `delete from crm_lead_attachments where id = '${ANEXO_A}'`)).toBe(1);
  });

  it("anon não tem privilégio de leitura na tabela", () => {
    expect(lastLine(sql(`select has_table_privilege('anon', 'public.crm_lead_attachments', 'select');`))).toBe("f");
  });
});

describe("crm_lead_attachments — poda de mídia (passo 2b)", () => {
  it("o anexo vivo fica; o órfão do prefixo de negócio entra na fila do internal-media", () => {
    sql(`${objeto(VIVO, 5)}${objeto(ORFAO, 5)}`);
    sql(`select public.fn_enfileirar_midia_vencida(500);`);

    expect(naFila(ORFAO)).toBe(1); // controle positivo: a poda enxerga `{org}/leads/`
    expect(naFila(VIVO)).toBe(0);
  });

  it("o negócio apagado leva a linha em cascata e o arquivo vira órfão", () => {
    sql(`${objeto(VIVO, 5)}`);
    sql(`delete from crm_leads where id = '${LEAD_A}';`);
    expect(conta(`select count(*) from crm_lead_attachments where id = '${ANEXO_A}'`)).toBe(0);

    sql(`select public.fn_enfileirar_midia_vencida(500);`);
    expect(naFila(VIVO)).toBe(1);
  });
});
