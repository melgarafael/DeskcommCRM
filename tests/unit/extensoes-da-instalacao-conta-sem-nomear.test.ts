/**
 * A TELA DE EXTENSÕES DA INSTALAÇÃO CONTA, MAS NÃO NOMEIA.
 *
 * `/admin/extensoes` responde "em quantas empresas esta extensão está ligada".
 * Para isso ela lê `organization_extensions` — tabela de inquilino — SEM filtro
 * de organização, o que é a pergunta certa e é uma exceção declarada em
 * `admin-client-exige-filtro-de-tenant.test.ts`.
 *
 * ⚠️ ESTE ARQUIVO EXISTE PORQUE A EXCEÇÃO DE LÁ NÃO OLHA COLUNAS. Medido: com
 * `organization_id` acrescentado ao `select`, aquela cerca continua verde — a
 * dispensa é por arquivo+tabela. Então a condição que a acompanha ("vence se a
 * tela passar a mostrar QUAIS empresas") era prosa, e prosa não dispara.
 *
 * Aqui ela vira mecanismo: contagem é agregado e não identifica ninguém; lista
 * de empresas é leitura de dado de inquilino pelo dono da instalação, e isso
 * precisa de decisão própria sobre o que ele pode ver — não pode entrar por
 * descuido numa linha de `select`.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const TELA = "app/admin/(protected)/extensoes/page.tsx";

describe("a tela de extensões da instalação", () => {
  const fonte = readFileSync(TELA, "utf8");
  const semProsa = fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("lê `organization_extensions` sem trazer a coluna que identifica a empresa", () => {
    const select = semProsa.match(
      /from\("organization_extensions"\)\s*\.select\(\s*"([^"]*)"/,
    )?.[1];
    expect(select, `nenhum \`select\` sobre organization_extensions em ${TELA}`).toBeTruthy();
    expect(
      select!.split(",").map((c) => c.trim()),
      "a tela passou a trazer a coluna da organização. Contagem é agregado e não " +
        "identifica ninguém; mostrar QUAIS empresas é leitura de dado de inquilino e " +
        "precisa de decisão própria — ver o cabeçalho deste arquivo.",
    ).toEqual(["installation_id", "enabled"]);
  });

  it("não chama de instalada a extensão que o operador já removeu", () => {
    // Remoção é soft delete (`extension_installations.removed_at`), então a linha
    // continua lá. Uma tela que não filtra mostra a removida como instalada e conta
    // os vínculos dela — e o erro é invisível justamente para quem removeu.
    const inicio = semProsa.indexOf('from("extension_installations")');
    expect(inicio, `nenhuma leitura de extension_installations em ${TELA}`).toBeGreaterThan(-1);
    const proxima = semProsa.indexOf('.from("', inicio + 1);
    const consulta = semProsa.slice(inicio, proxima === -1 ? undefined : proxima);
    expect(
      consulta,
      "a consulta das instaladas não filtra `removed_at`. Ver o cabeçalho deste caso.",
    ).toContain('.is("removed_at", null)');
  });

  it("a varredura ENCONTRA o select — um regex quebrado passaria por vacuidade", () => {
    // Sem este caso, renomear a tabela ou trocar as aspas deixaria o caso acima
    // verde sobre um conjunto vazio, que é o modo silencioso de uma cerca morrer.
    expect(semProsa).toMatch(/from\("organization_extensions"\)/);
  });
});
