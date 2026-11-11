import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * ANONIMIZAR UM CONTATO ALCANÇA AS FICHAS FUNDIDAS NELE (migration 9243).
 *
 * A fusão guarda a ficha absorvida como lápide, com os dados originais. Aqui se
 * prova, pelos caminhos de produção (`fn_mesclar_contatos`,
 * `fn_lgpd_cascade_redact_contact`, `fn_lgpd_anonymize_contact`) e pelo bloco de
 * dados do `baseline.sql`, que ela segue a ficha que fica; e, na outra direção,
 * que ficha viva e organização vizinha não são tocadas.
 *
 * As lápides de `fundida()` são escritas à mão de propósito: a fusão atual achata
 * correntes e leva o telefone para a ficha que fica, e o que se quer medir aqui é
 * o estado que fusões antigas deixaram, em que a lápide é a única a guardar o
 * número.
 *
 * Comando:
 *     pnpm test:db tests/invariants/lgpd-alcanca-fichas-fundidas.test.ts
 */

const ORG = "92430000-0000-4000-8000-00000000000a";
const VIZINHA = "92430000-0000-4000-8000-00000000000b";
const MEMBRO = "92430000-1111-4000-8000-000000000001";
const LEITOR = "92430000-1111-4000-8000-000000000002";

let seq = 0;
function novoId(): string {
  seq += 1;
  return `92430000-2222-4000-8000-${String(seq).padStart(12, "0")}`;
}
let seqTelefone = 0;
/** Número que nenhum outro caso usa. */
function novoTelefone(): string {
  seqTelefone += 1;
  return `+55119${String(10000000 + seqTelefone)}`;
}

function criar(org: string, nome: string, telefone: string | null, lid?: string): string {
  const id = novoId();
  const t = telefone === null ? "null" : `'${telefone}'`;
  const meta = lid ? `'{"waha_lid":"${lid}"}'` : "'{}'";
  sql(`insert into public.contacts (id, organization_id, name, display_name, phone_number, source_metadata)
       values ('${id}', '${org}', '${nome}', '${nome}', ${t}, ${meta});`);
  return id;
}

function fundida(filha: string, mae: string): void {
  sql(`update public.contacts set is_merged_into = '${mae}', merged_at = now() where id = '${filha}';`);
}

function cascata(org: string, contato: string): void {
  sql(`select public.fn_lgpd_cascade_redact_contact('${org}', '${contato}', null);`);
}

const FUNIL = "92430000-3333-4000-8000-000000000001";
const ETAPA = "92430000-3333-4000-8000-000000000002";

/** Foto e anexo de negócio numa ficha; devolve os caminhos que têm de ir para a fila. */
function comFotoEAnexo(contato: string): { foto: string; anexo: string; lead: string } {
  const lead = novoId();
  const foto = `${ORG}/avatars/${contato}.jpg`;
  const anexo = `${ORG}/leads/${lead}/comprovante/${lead}.pdf`;
  sql(`
    update public.contacts set avatar_storage_path = '${foto}', avatar_updated_at = now() where id = '${contato}';
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id)
      values ('${lead}', '${ORG}', '${FUNIL}', '${ETAPA}', 'Negócio', '${contato}');
    insert into public.crm_lead_attachments (organization_id, lead_id, field_key, file_name, storage_path)
      values ('${ORG}', '${lead}', 'comprovante', 'x.pdf', '${anexo}');
  `);
  return { foto, anexo, lead };
}

function semPonteiroEComFila(contato: string, alvo: { foto: string; anexo: string; lead: string }): void {
  expect(sql(`select avatar_storage_path is null from public.contacts where id = '${contato}';`)).toBe("t");
  expect(sql(`select count(*) from public.crm_lead_attachments where lead_id = '${alvo.lead}';`)).toBe("0");
  expect(
    sql(`select status from public.storage_redaction_queue
          where bucket = 'whatsapp-media' and object_path = '${alvo.foto}';`),
    "a foto não entrou na fila",
  ).toBe("pending");
  expect(
    sql(`select status from public.storage_redaction_queue
          where bucket = 'internal-media' and object_path = '${alvo.anexo}';`),
    "o anexo não entrou na fila",
  ).toBe("pending");
}

interface Estado {
  anonimizada: boolean;
  nome: string | null;
  telefone: string | null;
  lid: string | null;
  quando: string | null;
}

function estado(id: string): Estado {
  const out = sql(`select row_to_json(x) from (
    select is_anonymized as anonimizada, name as nome, phone_number as telefone, wa_lid as lid, anonymized_at as quando
      from public.contacts where id = '${id}') x;`);
  return JSON.parse(out) as Estado;
}

function apagadaDeVerdade(id: string): void {
  const e = estado(id);
  expect(e.anonimizada, `ficha ${id} não foi anonimizada`).toBe(true);
  expect(e.nome).toMatch(/^Cliente Anonimizado/);
  expect(e.telefone).toBeNull();
  expect(e.lid).toBeNull();
}

function marcado(org: string, telefone: string | null, lid: string | null): string {
  const t = telefone === null ? "null" : `'${telefone}'`;
  const l = lid === null ? "null" : `'${lid}'`;
  return sql(`select public.fn_titular_apagado_a_pedido('${org}', ${t}, ${l});`);
}

function auditoriasDe(id: string): string {
  return sql(`select count(*) from public.api_audit_log
               where action = 'lgpd.redact_executed' and resource_id = '${id}';`);
}

/** O bloco de dados como o kit self-host o aplica, conferido contra a migration. */
const TAG = "$fichas_absorvidas$";
function blocoDeDados(arquivo: string): string {
  const texto = readFileSync(join(process.cwd(), "supabase", ...arquivo.split("/")), "utf8");
  const inicio = texto.indexOf(`do ${TAG}`);
  const fim = texto.lastIndexOf(TAG);
  expect(inicio, `bloco de dados ausente em ${arquivo}`).toBeGreaterThan(-1);
  return texto.slice(inicio, fim + TAG.length) + ";";
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${MEMBRO}', 'fichas-fundidas@invariant.test'),
      ('${LEITOR}', 'fichas-fundidas-leitor@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'fichas-fundidas-a', 'Fundidas A', 'Fundidas A'),
      ('${VIZINHA}', 'fichas-fundidas-b', 'Fundidas B', 'Fundidas B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${MEMBRO}', '${ORG}', 'admin', now()), ('${LEITOR}', '${ORG}', 'viewer', now()) on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${FUNIL}', '${ORG}', 'Funil', 'fichas-fundidas') on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${ETAPA}', '${ORG}', '${FUNIL}', 'Novo', 'novo', 1000) on conflict do nothing;
  `);
});

describe("a cascata alcança as fichas absorvidas", () => {
  it("fusão real seguida da cascata na ficha que fica: a absorvida sai anonimizada", () => {
    const fica = criar(ORG, "Fica Real", novoTelefone());
    const sai = criar(ORG, "Sai Real", novoTelefone(), "924300001@lid");
    sql(`select public.fn_mesclar_contatos('${ORG}', '${fica}', array['${sai}']::uuid[]);`);
    expect(estado(sai).nome, "CONTROLE: a fusão real deixa a lápide em claro").toBe("Sai Real");

    cascata(ORG, fica);

    apagadaDeVerdade(fica);
    apagadaDeVerdade(sai);
    expect(auditoriasDe(sai), "cada ficha alcançada deixa a própria linha de auditoria").toBe("1");
    expect(
      sql(`select metadata ->> 'ficha_de_origem' from public.api_audit_log
            where action = 'lgpd.redact_executed' and resource_id = '${sai}';`),
      "a linha da absorvida diz de qual ficha veio",
    ).toBe(fica);
  });

  it("a lápide que é a única a guardar o número deixa a marca dele", () => {
    const telefone = novoTelefone();
    const fica = criar(ORG, "Fica Antiga", novoTelefone());
    const sai = criar(ORG, "Sai Antiga", telefone, "924300002@lid");
    fundida(sai, fica);
    expect(marcado(ORG, telefone, null), "CONTROLE: antes não há marca").toBe("f");

    cascata(ORG, fica);

    expect(marcado(ORG, telefone, null)).toBe("t");
    expect(marcado(ORG, null, "924300002")).toBe("t");
    expect(marcado(VIZINHA, telefone, null), "a marca é da organização").toBe("f");
  });

  it("corrente: alcança a ficha absorvida pela absorvida", () => {
    const telefone = novoTelefone();
    const fica = criar(ORG, "Fica Corrente", novoTelefone());
    const meio = criar(ORG, "Meio Corrente", novoTelefone());
    const ponta = criar(ORG, "Ponta Corrente", telefone);
    fundida(meio, fica);
    fundida(ponta, meio);

    cascata(ORG, fica);

    apagadaDeVerdade(meio);
    apagadaDeVerdade(ponta);
    expect(marcado(ORG, telefone, null)).toBe("t");
  });

  it("ciclo nos ponteiros termina, e cada ficha é anonimizada uma vez", () => {
    const a = criar(ORG, "Ciclo A", novoTelefone());
    const b = criar(ORG, "Ciclo B", novoTelefone());
    fundida(a, b);
    fundida(b, a);

    cascata(ORG, a);

    apagadaDeVerdade(a);
    apagadaDeVerdade(b);
    expect(auditoriasDe(a)).toBe("1");
    expect(auditoriasDe(b)).toBe("1");
  });

  it("pelo botão da ficha, na sessão de quem clicou, o alcance é o mesmo", () => {
    const fica = criar(ORG, "Fica Botao", novoTelefone());
    const sai = criar(ORG, "Sai Botao", novoTelefone());
    fundida(sai, fica);
    const claims = JSON.stringify({ sub: MEMBRO, aal: "aal2", role: "authenticated" });

    sql(`
      begin;
      set local role authenticated;
      select set_config('request.jwt.claims', '${claims}', true);
      select public.fn_lgpd_anonymize_contact('${ORG}', '${fica}');
      commit;
    `);

    apagadaDeVerdade(sai);
    expect(
      sql(`select actor_user_id from public.api_audit_log
            where action = 'lgpd.redact_executed' and resource_id = '${sai}';`),
      "a linha da absorvida nomeia quem clicou",
    ).toBe(MEMBRO);
    expect(
      sql(`select metadata ->> 'ficha_de_origem' from public.api_audit_log
            where action = 'lgpd.redact_executed' and resource_id = '${sai}';`),
    ).toBe(fica);
  });

  it("a ficha absorvida com foto e anexo não deixa ponteiro, e os arquivos entram na fila", () => {
    const fica = criar(ORG, "Fica Foto", novoTelefone());
    const sai = criar(ORG, "Sai Foto", novoTelefone());
    fundida(sai, fica);
    const alvo = comFotoEAnexo(sai);

    const retorno = sql(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${fica}', null) -> 'counts' ->> 'fichas_absorvidas';`);

    expect(retorno).toBe("1");
    semPonteiroEComFila(sai, alvo);
  });

  it("a ficha que recebeu o pedido também sai sem foto e sem anexo", () => {
    const fica = criar(ORG, "Fica Propria Foto", novoTelefone());
    const alvo = comFotoEAnexo(fica);

    cascata(ORG, fica);

    semPonteiroEComFila(fica, alvo);
  });

  it("fusão e anonimização são gravadas pelo servidor, não pela sessão", () => {
    const alvo = criar(ORG, "Ficha A Sessao", novoTelefone());
    const colega = criar(ORG, "Ficha B Sessao", novoTelefone());
    const claims = JSON.stringify({ sub: LEITOR, aal: "aal2", role: "authenticated" });
    const comoMembro = (dml: string): string => {
      try {
        sql(`
          begin;
          set local role authenticated;
          select set_config('request.jwt.claims', '${claims}', true);
          ${dml};
          commit;
        `);
        return "";
      } catch (err) {
        return (err as { stderr?: string }).stderr ?? String(err);
      }
    };

    for (const dml of [
      `update public.contacts set is_merged_into = '${alvo}' where id = '${colega}'`,
      `update public.contacts set merged_at = now() where id = '${colega}'`,
      `update public.contacts set anonymized_at = now() where id = '${alvo}'`,
      `update public.contacts set is_anonymized = true, anonymized_at = now() where id = '${alvo}'`,
    ]) {
      expect(comoMembro(dml), dml).toContain("contacts_fusao_e_anonimizacao_so_pelo_servidor");
    }
    expect(comoMembro(`update public.contacts set display_name = 'Editado' where id = '${colega}'`), "CONTROLE: a edição comum segue").toBe("");

    expect(estado(alvo)).toMatchObject({ anonimizada: false, nome: "Ficha A Sessao" });

    cascata(ORG, alvo);

    expect(estado(colega)).toMatchObject({ anonimizada: false, nome: "Ficha B Sessao" });
    expect(auditoriasDe(colega)).toBe("0");
  });

  it("o alcance é da cascata: virar a coluna fora dela não atravessa a fusão", () => {
    const origem = criar(ORG, "Origem Virada", novoTelefone());
    const absorvida = criar(ORG, "Absorvida Virada", novoTelefone());
    fundida(absorvida, origem);

    sql(`update public.contacts set is_anonymized = true, anonymized_at = now() where id = '${origem}';`);

    expect(estado(absorvida)).toMatchObject({ anonimizada: false, nome: "Absorvida Virada" });
  });

  it("foto fora do caminho exato solta o ponteiro e não entra na fila", () => {
    const outra = criar(ORG, "Dona da Foto", novoTelefone());
    const fica = criar(ORG, "Fica Caminho", novoTelefone());
    const caminhos = [
      `${ORG}/avatars/${outra}.jpg`,
      `${ORG}/avatars/../${outra}.jpg`,
      `${ORG}/x/${fica}.jpg`,
      `${VIZINHA}/avatars/${outra}.jpg`,
    ];

    for (const caminho of caminhos) {
      const contato = criar(ORG, "Com Caminho Fora", novoTelefone());
      sql(`update public.contacts set avatar_storage_path = '${caminho}' where id = '${contato}';`);
      cascata(ORG, contato);
      expect(sql(`select avatar_storage_path is null from public.contacts where id = '${contato}';`)).toBe("t");
      expect(sql(`select count(*) from public.storage_redaction_queue where object_path = '${caminho}';`), caminho).toBe("0");
    }
  });

  it("linha da fila com o mesmo caminho sob outra organização passa a ser desta, pendente", () => {
    const contato = criar(ORG, "Fila Vizinha", novoTelefone());
    const alvo = comFotoEAnexo(contato);
    sql(`
      insert into public.storage_redaction_queue (organization_id, bucket, object_path, status, processed_at) values
        ('${VIZINHA}', 'whatsapp-media', '${alvo.foto}', 'deleted', now()),
        ('${VIZINHA}', 'internal-media', '${alvo.anexo}', 'deleted', now());
    `);

    cascata(ORG, contato);

    semPonteiroEComFila(contato, alvo);
    expect(
      sql(`select count(*) from public.storage_redaction_queue
            where object_path in ('${alvo.foto}', '${alvo.anexo}') and organization_id = '${ORG}';`),
    ).toBe("2");
  });

  it("linha terminal da fila volta a pendente, na foto e no anexo", () => {
    const fica = criar(ORG, "Fica Terminal", novoTelefone());
    const alvo = comFotoEAnexo(fica);
    sql(`
      insert into public.storage_redaction_queue (organization_id, bucket, object_path, status, attempts, processed_at, error_message) values
        ('${ORG}', 'whatsapp-media', '${alvo.foto}', 'deleted', 1, now(), null),
        ('${ORG}', 'internal-media', '${alvo.anexo}', 'failed', 3, now(), 'erro antigo');
    `);

    cascata(ORG, fica);

    semPonteiroEComFila(fica, alvo);
    expect(
      sql(`select attempts, processed_at is null, error_message is null from public.storage_redaction_queue
            where object_path = '${alvo.anexo}';`),
    ).toBe("0|t|t");
  });

  it("negócio só ligado pela crm_lead_links mantém os anexos, e a contagem diz quantos", () => {
    const fica = criar(ORG, "Fica Ligado", novoTelefone());
    const dono = criar(ORG, "Dono do Negocio", novoTelefone());
    const ligado = comFotoEAnexo(dono);
    const proprio = comFotoEAnexo(fica);
    sql(`insert into public.crm_lead_links (organization_id, lead_id, target_kind, target_id, link_kind) values
           ('${ORG}', '${ligado.lead}', 'contact', '${fica}', 'related'),
           ('${ORG}', '${ligado.lead}', 'contact', '${fica}', 'primary');`);

    const contagens = JSON.parse(
      sql(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${fica}', null) -> 'counts';`),
    ) as Record<string, number>;

    expect(contagens.crm_lead_attachments_mantidos).toBe(1);
    expect(contagens.crm_lead_attachments).toBe(1);
    expect(sql(`select count(*) from public.crm_lead_attachments where lead_id = '${ligado.lead}';`)).toBe("1");
    expect(sql(`select count(*) from public.storage_redaction_queue where object_path = '${ligado.anexo}';`)).toBe("0");
    expect(sql(`select count(*) from public.crm_lead_attachments where lead_id = '${proprio.lead}';`)).toBe("0");
    expect(
      sql(`select status from public.storage_redaction_queue where bucket = 'internal-media' and object_path = '${proprio.anexo}';`),
    ).toBe("pending");
  });

  it("ponteiro sem merged_at não é fusão: a cascata não alcança a ficha", () => {
    const fica = criar(ORG, "Fica Sem Data", novoTelefone());
    const semData = criar(ORG, "Sem Data", novoTelefone());
    const meio = criar(ORG, "Meio Com Data", novoTelefone());
    const abaixoSemData = criar(ORG, "Abaixo Sem Data", novoTelefone());
    fundida(meio, fica);
    sql(`update public.contacts set is_merged_into = '${fica}' where id = '${semData}';
         update public.contacts set is_merged_into = '${meio}' where id = '${abaixoSemData}';`);

    cascata(ORG, fica);

    apagadaDeVerdade(meio);
    expect(estado(semData)).toMatchObject({ anonimizada: false, nome: "Sem Data" });
    expect(estado(abaixoSemData)).toMatchObject({ anonimizada: false, nome: "Abaixo Sem Data" });
  });

  it("mídia de mensagem com caminho fora da organização não entra na fila", () => {
    const contato = criar(ORG, "Midia Fora", novoTelefone());
    const sessao = novoId();
    const conversa = novoId();
    const propria = `${ORG}/${conversa}/propria.jpg`;
    const fora = `${VIZINHA}/${conversa}/fora.jpg`;
    sql(`
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${sessao}', '${ORG}', 'sessao-${sessao}', '\\x00'::bytea);
      insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
        values ('${conversa}', '${ORG}', '${contato}', '${sessao}', 'open');
      insert into public.messages
        (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, body, media_storage_path)
        values ('${ORG}', '${conversa}', '${sessao}', '${contato}', 'image', 'inbound', 'received', 'crm', 'a', '${propria}'),
               ('${ORG}', '${conversa}', '${sessao}', '${contato}', 'image', 'inbound', 'received', 'crm', 'b', '${fora}');
    `);

    const midias = sql(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${contato}', null) -> 'media_paths';`);

    expect(JSON.parse(midias)).toEqual([propria]);
    expect(sql(`select count(*) from public.storage_redaction_queue where object_path = '${fora}';`)).toBe("0");
    expect(
      sql(`select status from public.storage_redaction_queue where bucket = 'whatsapp-media' and object_path = '${propria}';`),
    ).toBe("pending");
  });

  it("corrente longa não esgota a pilha, e a mais funda vira primeiro", () => {
    const TAMANHO = 200;
    const raiz = criar(ORG, "Raiz Longa", null);
    const ids = Array.from({ length: TAMANHO }, () => novoId());
    sql(
      `insert into public.contacts (id, organization_id, name) values ${ids.map((id) => `('${id}', '${ORG}', 'Elo')`).join(",")};
       update public.contacts set is_merged_into = '${raiz}', merged_at = now() where id = '${ids[0]}';
       ${ids.slice(1).map((id, i) => `update public.contacts set is_merged_into = '${ids[i]}', merged_at = now() where id = '${id}';`).join("\n")}`,
    );

    cascata(ORG, raiz);

    expect(
      sql(`select count(*) from public.contacts where id = any (array[${ids.map((id) => `'${id}'`).join(",")}]::uuid[]) and is_anonymized;`),
    ).toBe(String(TAMANHO));
  }, 240_000);

  it("a sessão não cria ficha com fusão ou anonimização, e cria a comum", () => {
    const alvo = criar(ORG, "Alvo Criacao", novoTelefone());
    const claims = JSON.stringify({ sub: LEITOR, aal: "aal2", role: "authenticated" });
    const inserir = (colunas: string, valores: string): string => {
      try {
        sql(`
          begin;
          set local role authenticated;
          select set_config('request.jwt.claims', '${claims}', true);
          insert into public.contacts (organization_id, name${colunas}) values ('${ORG}', 'Criada'${valores});
          commit;
        `);
        return "";
      } catch (err) {
        return (err as { stderr?: string }).stderr ?? String(err);
      }
    };
    for (const [colunas, valores] of [
      [", is_merged_into", `, '${alvo}'`],
      [", merged_at", ", now()"],
      [", anonymized_at", ", now()"],
      [", is_anonymized, anonymized_at", ", true, now()"],
    ] as const) {
      expect(inserir(colunas, valores), colunas).toContain("contacts_fusao_e_anonimizacao_so_pelo_servidor");
    }
    expect(inserir("", ""), "CONTROLE: a criação comum segue").toBe("");
  });

  it("a sessão só lê a fila, e nenhuma função de invocador escreve nela", () => {
    expect(
      sql(`select has_table_privilege('authenticated', 'public.storage_redaction_queue', 'select'),
                  has_table_privilege('authenticated', 'public.storage_redaction_queue', 'insert'),
                  has_table_privilege('authenticated', 'public.storage_redaction_queue', 'update'),
                  has_table_privilege('authenticated', 'public.storage_redaction_queue', 'delete'),
                  has_table_privilege('authenticated', 'public.storage_redaction_queue', 'truncate');`),
    ).toBe("t|f|f|f|f");
    expect(
      sql(`select coalesce(string_agg(p.proname, ',' order by p.proname), '')
             from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and not p.prosecdef
              and p.prosrc ~* '(insert into|update|delete from)\\s+(public\\.)?storage_redaction_queue';`),
    ).toBe("");
  });

  it("a mídia das mensagens da absorvida entra na fila", () => {
    const fica = criar(ORG, "Fica Midia", novoTelefone());
    const sai = criar(ORG, "Sai Midia", novoTelefone());
    fundida(sai, fica);
    const sessao = novoId();
    const conversa = novoId();
    const midia = `${ORG}/${conversa}/x.jpg`;
    sql(`
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${sessao}', '${ORG}', 'sessao-${sessao}', '\\x00'::bytea);
      insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
        values ('${conversa}', '${ORG}', '${sai}', '${sessao}', 'open');
      insert into public.messages
        (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, body, media_storage_path)
        values ('${ORG}', '${conversa}', '${sessao}', '${sai}', 'image', 'inbound', 'received', 'crm', 'foto', '${midia}');
    `);

    cascata(ORG, fica);

    expect(
      sql(`select status from public.storage_redaction_queue where bucket = 'whatsapp-media' and object_path = '${midia}';`),
    ).toBe("pending");
  });

  it("repetir a cascata não regrava nada na absorvida", () => {
    const fica = criar(ORG, "Fica Repete", novoTelefone());
    const sai = criar(ORG, "Sai Repete", novoTelefone());
    fundida(sai, fica);
    cascata(ORG, fica);
    const antes = estado(sai);

    cascata(ORG, fica);

    expect(estado(sai)).toEqual(antes);
    expect(auditoriasDe(sai)).toBe("1");
  });

  it("não alcança ficha viva, a vizinha com o mesmo número, nem ponteiro de outra organização", () => {
    const telefone = novoTelefone();
    const fica = criar(ORG, "Fica Vizinha", novoTelefone());
    const sai = criar(ORG, "Sai Vizinha", telefone);
    const viva = criar(ORG, "Viva Mesma Org", novoTelefone());
    const ficaVizinha = criar(VIZINHA, "Fica em B", novoTelefone());
    const saiVizinha = criar(VIZINHA, "Sai em B", telefone);
    const ponteiroCruzado = criar(VIZINHA, "Cruzado em B", novoTelefone());
    const cruzadoAbaixo = criar(VIZINHA, "Cruzado Abaixo em B", novoTelefone());
    fundida(sai, fica);
    fundida(saiVizinha, ficaVizinha);
    fundida(ponteiroCruzado, fica);
    fundida(cruzadoAbaixo, sai);

    cascata(ORG, fica);

    apagadaDeVerdade(sai);
    expect(estado(viva)).toMatchObject({ anonimizada: false, nome: "Viva Mesma Org" });
    expect(estado(ficaVizinha)).toMatchObject({ anonimizada: false, nome: "Fica em B" });
    expect(estado(saiVizinha)).toMatchObject({ anonimizada: false, nome: "Sai em B", telefone });
    expect(estado(ponteiroCruzado)).toMatchObject({ anonimizada: false, nome: "Cruzado em B" });
    expect(estado(cruzadoAbaixo)).toMatchObject({ anonimizada: false, nome: "Cruzado Abaixo em B" });
    expect(marcado(VIZINHA, telefone, null)).toBe("f");
  });

  it("a cascata segue fora do alcance do navegador", () => {
    const fn = "'public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid)'";
    expect(
      sql(`select has_function_privilege('anon', ${fn}, 'execute'),
                  has_function_privilege('authenticated', ${fn}, 'execute');`),
    ).toBe("f|f");
  });
});

describe("o bloco de dados alcança o que ficou para trás", () => {
  it("baseline e migration trazem o mesmo bloco", () => {
    expect(blocoDeDados("baseline.sql")).toBe(
      blocoDeDados("migrations/20261111031952_9243_anonimizar_alcanca_fichas_fundidas.sql"),
    );
  });

  it("baseline e migration trazem as mesmas funções e gatilhos", () => {
    const INICIO = "-- Põe um arquivo na fila de remoção.";
    const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
    const migration = readFileSync(
      join(process.cwd(), "supabase", "migrations", "20261111031952_9243_anonimizar_alcanca_fichas_fundidas.sql"),
      "utf8",
    );
    const noBaseline = baseline.slice(baseline.indexOf(INICIO), baseline.indexOf("-- ---- VARREDURA anon:"));
    const naMigration = migration.slice(migration.indexOf(INICIO), migration.indexOf(`do ${TAG}`));
    expect(noBaseline.length, "CONTROLE: o trecho foi achado").toBeGreaterThan(1000);
    expect(noBaseline.trim()).toBe(naMigration.trim());
  });

  it("anonimiza descendência de quem já está anonimizado, deixa a marca, e repetir não muda nada", () => {
    const telefone = novoTelefone();
    const telefoneMeio = novoTelefone();
    const fica = criar(ORG, "Fica Velha", novoTelefone());
    cascata(ORG, fica);
    // ponteiros gravados DEPOIS da virada: o estado de quem foi anonimizado antes desta versão
    const direta = criar(ORG, "Direta Velha", telefone);
    const meio = criar(ORG, "Meio Velho", telefoneMeio);
    const ponta = criar(ORG, "Ponta Velha", novoTelefone());
    fundida(direta, fica);
    fundida(meio, fica);
    fundida(ponta, meio);

    const jaAnonimizadaMeio = criar(ORG, "Ja Anonimizada", novoTelefone());
    cascata(ORG, jaAnonimizadaMeio);
    const abaixoDaAnonimizada = criar(ORG, "Abaixo Velha", novoTelefone());
    fundida(jaAnonimizadaMeio, fica);
    fundida(abaixoDaAnonimizada, jaAnonimizadaMeio);

    const comArquivos = criar(ORG, "Com Arquivos Velha", novoTelefone());
    const arquivos = comFotoEAnexo(comArquivos);
    fundida(comArquivos, fica);

    const viva = criar(ORG, "Viva Velha", novoTelefone());
    const lapideDeViva = criar(ORG, "Lapide de Viva", novoTelefone());
    fundida(lapideDeViva, viva);

    const ficaEmB = criar(VIZINHA, "Fica Velha B", novoTelefone());
    cascata(VIZINHA, ficaEmB);
    const cruzadaDaA = criar(ORG, "Cruzada Velha", novoTelefone());
    fundida(cruzadaDaA, ficaEmB);

    const caminhoDeOutra = `${VIZINHA}/avatars/${novoId()}.jpg`;
    const caminhoProprio = `${ORG}/avatars/${novoId()}.jpg`;
    const ponteiroSemData = criar(ORG, "Velha Sem Data", novoTelefone());
    sql(`update public.contacts set is_merged_into = '${fica}' where id = '${ponteiroSemData}';`);
    const caminhosFora = [
      caminhoDeOutra,
      `sem-organizacao/${novoId()}.jpg`,
      `${novoId()}/x.jpg`,
      `/${ORG}/${novoId()}.jpg`,
      `${ORG}/../${VIZINHA}/${novoId()}.jpg`,
      `${ORG}/./${novoId()}.jpg`,
      `${ORG}//${novoId()}.jpg`,
      `${ORG}/pasta\\${novoId()}.jpg`,
    ];
    sql(`
      insert into public.storage_redaction_queue (organization_id, bucket, object_path) values
        ${[caminhoProprio, ...caminhosFora].map((c) => `('${ORG}', 'whatsapp-media', '${c}')`).join(",\n")};
    `);

    expect(marcado(ORG, telefone, null), "CONTROLE: antes do bloco não há marca").toBe("f");
    expect(estado(direta).anonimizada, "CONTROLE: antes do bloco está em claro").toBe(false);

    const bloco = blocoDeDados("baseline.sql");
    sql(bloco);

    for (const f of [direta, meio, ponta, abaixoDaAnonimizada, comArquivos]) apagadaDeVerdade(f);
    semPonteiroEComFila(comArquivos, arquivos);
    expect(estado(ponteiroSemData)).toMatchObject({ anonimizada: false, nome: "Velha Sem Data" });
    for (const caminho of caminhosFora) {
      expect(sql(`select count(*) from public.storage_redaction_queue where object_path = '${caminho}';`), caminho).toBe("0");
    }
    expect(sql(`select count(*) from public.storage_redaction_queue where object_path = '${caminhoProprio}';`)).toBe("1");
    expect(marcado(ORG, telefone, null)).toBe("t");
    expect(marcado(ORG, telefoneMeio, null)).toBe("t");
    expect(estado(viva)).toMatchObject({ anonimizada: false, nome: "Viva Velha" });
    expect(estado(lapideDeViva)).toMatchObject({ anonimizada: false, nome: "Lapide de Viva" });
    expect(estado(cruzadaDaA), "ponteiro entre organizações não é seguido").toMatchObject({
      anonimizada: false,
      nome: "Cruzada Velha",
    });

    const marcas = sql(`select count(*) from public.lgpd_marcas_de_apagamento;`);
    const auditoria = sql(`select count(*) from public.api_audit_log where action = 'lgpd.redact_executed';`);
    const quando = estado(direta).quando;
    sql(bloco);
    expect(sql(`select count(*) from public.lgpd_marcas_de_apagamento;`)).toBe(marcas);
    expect(sql(`select count(*) from public.api_audit_log where action = 'lgpd.redact_executed';`)).toBe(auditoria);
    expect(estado(direta).quando).toBe(quando);
  });
});
