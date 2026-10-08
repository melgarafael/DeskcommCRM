import { describe, expect, it } from "vitest";

import { AVISO_ESCRITA, AVISO_LEITURA_AMPLA, AVISO_ROLE, AVISO_SEM_CONFERIR, interpretarGrants } from "./grants";

const DB = "wp";

describe("interpretarGrants", () => {
  it("usuário só-leitura de uma view: sem aviso", () => {
    const linhas = ["GRANT USAGE ON *.* TO `leitor`@`%`", "GRANT SELECT ON `wp`.`v_imoveis` TO `leitor`@`%`"];
    expect(interpretarGrants(linhas, DB)).toBeNull();
  });

  it("SELECT só em colunas de uma tabela: sem aviso (não é o banco inteiro)", () => {
    expect(interpretarGrants(["GRANT SELECT (`id`, `nome`) ON `wp`.`clientes` TO `u`@`%`"], DB)).toBeNull();
  });

  it("escrita: INSERT/UPDATE/DELETE e demais privilégios fora de SELECT/USAGE avisam", () => {
    for (const privilegio of ["INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "INDEX", "FILE", "SUPER", "PROCESS", "EXECUTE", "TRIGGER", "EVENT", "LOCK TABLES", "CREATE ROUTINE", "ALTER ROUTINE"]) {
      const aviso = interpretarGrants([`GRANT SELECT, ${privilegio} ON \`wp\`.\`v\` TO \`u\`@\`%\``], DB);
      expect(aviso, privilegio).toContain(AVISO_ESCRITA);
    }
  });

  it("ALL PRIVILEGES no banco: avisa escrita E leitura ampla", () => {
    const aviso = interpretarGrants(["GRANT ALL PRIVILEGES ON `wp`.* TO `u`@`%`"], DB)!;
    expect(aviso).toContain(AVISO_ESCRITA);
    expect(aviso).toContain(AVISO_LEITURA_AMPLA);
  });

  it("WITH GRANT OPTION conta como escrita", () => {
    expect(interpretarGrants(["GRANT SELECT ON `wp`.`v` TO `u`@`%` WITH GRANT OPTION"], DB)).toContain(AVISO_ESCRITA);
  });

  it("SELECT em *.* ou no banco inteiro: leitura ampla (e só ela)", () => {
    expect(interpretarGrants(["GRANT SELECT ON *.* TO `u`@`%`"], DB)).toBe(AVISO_LEITURA_AMPLA);
    expect(interpretarGrants(["GRANT SELECT ON `wp`.* TO `u`@`%`"], DB)).toBe(AVISO_LEITURA_AMPLA);
  });

  it("SELECT em OUTRO banco não conta como leitura ampla deste", () => {
    expect(interpretarGrants(["GRANT SELECT ON `outro`.* TO `u`@`%`"], DB)).toBeNull();
  });

  it("banco com sublinhado vem com a barra escapada no GRANT e ainda assim casa", () => {
    expect(interpretarGrants(["GRANT SELECT ON `meu\\_banco`.* TO `u`@`%`"], "meu_banco")).toBe(AVISO_LEITURA_AMPLA);
  });

  it("linha de papel (role): não consegue conferir os papéis", () => {
    expect(interpretarGrants(["GRANT `leitor_role`@`%` TO `u`@`%`"], DB)).toBe(AVISO_ROLE);
  });

  it("linha que não reconhece: não consegue conferir", () => {
    expect(interpretarGrants(["algo que não é um GRANT"], DB)).toBe(AVISO_SEM_CONFERIR);
  });

  it("junta os avisos, escrita primeiro, e nunca passa de 500 caracteres", () => {
    const aviso = interpretarGrants(["GRANT ALL PRIVILEGES ON *.* TO `root`@`%`"], DB)!;
    expect(aviso.indexOf(AVISO_ESCRITA)).toBeLessThan(aviso.indexOf(AVISO_LEITURA_AMPLA));
    expect(aviso.length).toBeLessThanOrEqual(500);
  });

  it("lista vazia: não consegue conferir", () => {
    expect(interpretarGrants([], DB)).toBe(AVISO_SEM_CONFERIR);
  });
});
