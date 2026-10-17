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

  describe("consulta de sugestão de campos ACF (D5)", () => {
    const TABELAS_ACF = ["wp_posts", "wp_postmeta"];

    it("aceita a consulta fixa de sugestão (SELECT, count, tabelas permitidas)", () => {
      const sql =
        "select pm.meta_key as meta_key, count(*) as frequencia from `wp_postmeta` pm join `wp_posts` p on p.ID = pm.post_id where p.post_type = ? and pm.meta_key not like '\\_%%' group by pm.meta_key order by frequencia desc limit 50";
      expect(() => validarConsultaDeReceita(sql, TABELAS_ACF)).not.toThrow();
    });

    it("rejeita sugestão com ponto-e-vírgula", () => {
      expect(() =>
        validarConsultaDeReceita(
          "select pm.meta_key from `wp_postmeta` pm; drop table wp_postmeta",
          TABELAS_ACF,
        ),
      ).toThrow(/consulta_nao_pode_ter_mais_de_um_comando/);
    });

    it("rejeita sugestão com INTO", () => {
      expect(() =>
        validarConsultaDeReceita("select pm.meta_key into @x from `wp_postmeta` pm", TABELAS_ACF),
      ).toThrow(/palavra_proibida/);
    });

    it("rejeita sugestão que cita tabela fora da lista", () => {
      expect(() =>
        validarConsultaDeReceita(
          "select pm.meta_key from wp_postmeta pm join wp_options o on o.option_id = pm.meta_id",
          TABELAS_ACF,
        ),
      ).toThrow(/tabela_nao_liberada:wp_options/);
    });
  });
});
