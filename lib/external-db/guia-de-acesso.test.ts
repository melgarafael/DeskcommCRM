import { describe, expect, it } from "vitest";

import { SQL_MYSQL_CRIAR_E_LIBERAR_VIEW, SQL_MYSQL_CRIAR_USUARIO } from "./guia-de-acesso";

describe("guia de acesso só de leitura (MySQL)", () => {
  it("o usuário nasce sem nenhum privilégio e com senha de enfeite para trocar", () => {
    expect(SQL_MYSQL_CRIAR_USUARIO).toContain("CREATE USER 'crm_leitura'");
    expect(SQL_MYSQL_CRIAR_USUARIO).toContain("TROQUE_POR_UMA_SENHA_FORTE");
    expect(SQL_MYSQL_CRIAR_USUARIO).not.toMatch(/GRANT/i);
  });

  it("libera SELECT só na view, nunca no banco inteiro nem com poderes a mais", () => {
    expect(SQL_MYSQL_CRIAR_E_LIBERAR_VIEW).toMatch(/GRANT SELECT ON \w+\.\w+ TO 'crm_leitura'@'%';/);
    expect(SQL_MYSQL_CRIAR_E_LIBERAR_VIEW).not.toMatch(/\.\*/);
    expect(SQL_MYSQL_CRIAR_E_LIBERAR_VIEW).not.toMatch(/ALL PRIVILEGES/i);
    expect(SQL_MYSQL_CRIAR_E_LIBERAR_VIEW).not.toMatch(/GRANT OPTION/i);
    expect(SQL_MYSQL_CRIAR_E_LIBERAR_VIEW).not.toMatch(/INSERT|UPDATE|DELETE/i);
  });
});
