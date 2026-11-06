import { describe, expect, it } from "vitest";

import { validarConsultaDeReceita } from "./validador";

const TABELAS = ["wp_posts", "wp_postmeta"];

describe("validarConsultaDeReceita — segunda trava", () => {
  it("aceita um SELECT legítimo com placeholders", () => {
    const sql =
      "select `wp_posts`.`ID` as id from `wp_posts` where `wp_posts`.`post_type` = ? and `wp_posts`.`post_status` = ? limit ?";
    expect(() => validarConsultaDeReceita(sql, TABELAS)).not.toThrow();
  });

  it("rejeita mais de um comando (ponto-e-vírgula)", () => {
    expect(() =>
      validarConsultaDeReceita("select 1 from wp_posts; drop table wp_posts", TABELAS),
    ).toThrow(/consulta_nao_pode_ter_mais_de_um_comando/);
  });

  it("rejeita que não começa com SELECT", () => {
    expect(() => validarConsultaDeReceita("insert into wp_posts (id) values (1)", TABELAS)).toThrow(
      /consulta_deve_comecar_com_select/,
    );
  });

  it("rejeita comentário de linha --", () => {
    expect(() =>
      validarConsultaDeReceita("select 1 from wp_posts -- dropar tudo", TABELAS),
    ).toThrow(/comentario_proibido/);
  });

  it("rejeita comentário de bloco /*", () => {
    expect(() =>
      validarConsultaDeReceita("select 1 from wp_posts /* dropar */", TABELAS),
    ).toThrow(/comentario_proibido/);
  });

  it("rejeita # (comentário MySQL)", () => {
    expect(() => validarConsultaDeReceita("select 1 from wp_posts # dropar", TABELAS)).toThrow(
      /comentario_proibido/,
    );
  });

  it("rejeita INTO", () => {
    expect(() =>
      validarConsultaDeReceita("select id into @x from wp_posts", TABELAS),
    ).toThrow(/palavra_proibida/);
  });

  it("rejeita FOR UPDATE", () => {
    expect(() =>
      validarConsultaDeReceita("select * from wp_posts for update", TABELAS),
    ).toThrow(/palavra_proibida/);
  });

  it("rejeita LOCK", () => {
    expect(() => validarConsultaDeReceita("select * from wp_posts lock in share mode", TABELAS)).toThrow(
      /palavra_proibida/,
    );
  });

  it("palavra proibida dentro de identificador entre crases NÃO bloqueia (bloco_clock, quinto)", () => {
    const sql =
      "select `wp_posts`.`bloco_clock` as c, `wp_posts`.`quinto` as q, `wp_posts`.`into` as i from `wp_posts` where `wp_posts`.`lock` = ?";
    expect(() => validarConsultaDeReceita(sql, TABELAS)).not.toThrow();
  });

  it("palavra proibida SEM crase continua bloqueada, mesmo ao lado de identificador com crase", () => {
    expect(() =>
      validarConsultaDeReceita("select `bloco_clock` from wp_posts into outfile '/tmp/x'", TABELAS),
    ).toThrow(/palavra_proibida:INTO/);
    expect(() => validarConsultaDeReceita("select `a` from wp_posts into`b`", TABELAS)).toThrow(
      /palavra_proibida:INTO/,
    );
    expect(() => validarConsultaDeReceita("select 1 from wp_posts into outfile '/tmp/x'", TABELAS)).toThrow(
      /palavra_proibida/,
    );
    expect(() => validarConsultaDeReceita("lock tables wp_posts read", TABELAS)).toThrow(
      /consulta_deve_comecar_com_select/,
    );
    expect(() =>
      validarConsultaDeReceita("select `ID` from `wp_posts` lock in share mode", TABELAS),
    ).toThrow(/palavra_proibida:LOCK/);
  });

  it("rejeita SLEEP(", () => {
    expect(() => validarConsultaDeReceita("select sleep(5) from wp_posts", TABELAS)).toThrow(
      /palavra_proibida/,
    );
  });

  it("rejeita BENCHMARK(", () => {
    expect(() => validarConsultaDeReceita("select benchmark(1000000,1) from wp_posts", TABELAS)).toThrow(
      /palavra_proibida/,
    );
  });

  it("rejeita LOAD_FILE", () => {
    expect(() => validarConsultaDeReceita("select load_file('/etc/passwd')", TABELAS)).toThrow(
      /palavra_proibida/,
    );
  });

  it("rejeita OUTFILE", () => {
    expect(() => validarConsultaDeReceita("select * from wp_posts into outfile '/tmp/x'", TABELAS)).toThrow(
      /palavra_proibida/,
    );
  });

  it("rejeita tabela fora da lista após FROM", () => {
    expect(() =>
      validarConsultaDeReceita("select * from wp_users where id = 1", TABELAS),
    ).toThrow(/tabela_nao_liberada:wp_users/);
  });

  it("rejeita tabela fora da lista após JOIN", () => {
    expect(() =>
      validarConsultaDeReceita(
        "select * from wp_posts join wp_users on wp_users.id = wp_posts.id",
        TABELAS,
      ),
    ).toThrow(/tabela_nao_liberada:wp_users/);
  });

  it("parâmetro colado no texto (concatenação) é detectado pelo validador se vier como tabela", () => {
    // O validador não vê valores (são placeholders), mas se o template colar um
    // nome de tabela no texto, a tabela não estará na lista permitida.
    expect(() =>
      validarConsultaDeReceita("select * from wp_posts_123 where id = ?", TABELAS),
    ).toThrow(/tabela_nao_liberada:wp_posts_123/);
  });

  it("enxerga tabela numa subconsulta do SELECT (group_concat) e rejeita se não estiver liberada", () => {
    const sql =
      "select p.ID, (select group_concat(t.name) from `wp_term_relationships` tr join `wp_term_taxonomy` tt on tt.term_taxonomy_id = tr.term_taxonomy_id join `wp_terms` t on t.term_id = tt.term_id where tr.object_id = p.ID) as bairro from `wp_posts` p limit 5";
    expect(() => validarConsultaDeReceita(sql, [...TABELAS, "wp_terms", "wp_term_taxonomy", "wp_term_relationships"])).not.toThrow();
    expect(() =>
      validarConsultaDeReceita(sql, TABELAS),
    ).toThrow(/tabela_nao_liberada:wp_term_relationships/);
  });

  it("enxerga tabela num EXISTS do WHERE e rejeita se não estiver liberada", () => {
    const sql =
      "select * from `wp_posts` p where exists (select 1 from `wp_term_relationships` tr where tr.object_id = p.ID) limit 5";
    expect(() =>
      validarConsultaDeReceita(sql, [...TABELAS, "wp_term_relationships"]),
    ).not.toThrow();
    expect(() => validarConsultaDeReceita(sql, TABELAS)).toThrow(
      /tabela_nao_liberada:wp_term_relationships/,
    );
  });
});
