import { beforeAll, describe, expect, it } from "vitest";

import { countAs, sql, writeCountAs } from "./gov-helpers";

// Prova da 9019 em arquivo novo: rls-isolation.test.ts permanece byte a byte
// como a main. Todos os identificadores pertencem somente a esta fixture.
const ORG_A = "c0647000-0000-4000-8000-000000000001";
const ORG_B = "c0647000-0000-4000-8000-000000000002";
const MANAGER_A = "c0647000-1111-4000-8000-000000000001";
const MANAGER_B = "c0647000-1111-4000-8000-000000000002";
const AGENT_A = "c0647000-1111-4000-8000-000000000003";
const PROD_A = "c0647000-2222-4000-8000-000000000001";
const PROD_B = "c0647000-2222-4000-8000-000000000002";
const AUDIO = "c0647000-3333-4000-8000-000000000001.ogg";

beforeAll(() => {
  sql(`
    insert into auth.users(id,email) values
      ('${MANAGER_A}','apresentacao-gestor-a@invariant.test'),
      ('${MANAGER_B}','apresentacao-gestor-b@invariant.test'),
      ('${AGENT_A}','apresentacao-atendente-a@invariant.test');
    insert into organizations(id,slug,legal_name,display_name) values
      ('${ORG_A}','apresentacao-0647-a','Apresentação sintética A','Apresentação A'),
      ('${ORG_B}','apresentacao-0647-b','Apresentação sintética B','Apresentação B');
    insert into user_organizations(user_id,organization_id,role,accepted_at) values
      ('${MANAGER_A}','${ORG_A}','manager',now()),
      ('${MANAGER_B}','${ORG_B}','manager',now()),
      ('${AGENT_A}','${ORG_A}','agent',now());
    insert into catalog_products(id,organization_id,codigo,nome,preco_cents) values
      ('${PROD_A}','${ORG_A}','APRES-A','Produto sintético A',100),
      ('${PROD_B}','${ORG_B}','APRES-B','Produto sintético B',200);
    insert into catalog_product_presentations(organization_id,catalog_product_id,text_content) values
      ('${ORG_A}','${PROD_A}','Texto sintético A'),
      ('${ORG_B}','${PROD_B}','Texto sintético B');
  `);
});

describe("apresentações do catálogo: isolamento e caminho de áudio", () => {
  it.each([[MANAGER_A, ORG_A, ORG_B], [MANAGER_B, ORG_B, ORG_A], [AGENT_A, ORG_A, ORG_B]])(
    "membro %s lê a própria apresentação e nenhuma do outro tenant", (user, propria, outra) => {
      expect(countAs(user, `select count(*) from catalog_product_presentations where organization_id='${propria}'`)).toBe(1);
      expect(countAs(user, `select count(*) from catalog_product_presentations where organization_id='${outra}'`)).toBe(0);
    },
  );

  it("agent lê, mas só manager da organização altera", () => {
    const atualizar = `update catalog_product_presentations set text_content='Texto atualizado' where organization_id='${ORG_A}' and catalog_product_id='${PROD_A}'`;
    expect(writeCountAs(AGENT_A, atualizar)).toBe(0);
    expect(writeCountAs(MANAGER_B, atualizar)).toBe(0);
    expect(writeCountAs(MANAGER_A, atualizar)).toBe(1);
  });

  it("o CHECK aceita arquivo .ogg da própria organização e produto", () => {
    const caminho = `${ORG_A}/${PROD_A}/${AUDIO}`;
    const out = sql(`
      update catalog_product_presentations
         set audio_storage_path='${caminho}',audio_mime='audio/ogg;codecs=opus',audio_size_bytes=36
       where organization_id='${ORG_A}' and catalog_product_id='${PROD_A}';
      select audio_storage_path from catalog_product_presentations where catalog_product_id='${PROD_A}';
    `);
    expect(out.split("\n").at(-1)).toBe(caminho);
  });

  it("o CHECK recusa caminho de outra organização, mesmo como postgres", () => {
    const out = sql(`do $teste$
      declare nome text;
      begin
        update catalog_product_presentations
           set audio_storage_path='${ORG_B}/${PROD_A}/${AUDIO}',audio_mime='audio/ogg;codecs=opus',audio_size_bytes=36
         where organization_id='${ORG_A}' and catalog_product_id='${PROD_A}';
        raise exception 'caminho de outra organização foi aceito';
      exception when check_violation then
        get stacked diagnostics nome = constraint_name;
        if nome <> 'catalog_product_presentations_audio_owned_check' then raise; end if;
      end $teste$;
      select 'recusado-pelo-check-de-ownership';`);
    expect(out.split("\n").at(-1)).toBe("recusado-pelo-check-de-ownership");
  });
});
