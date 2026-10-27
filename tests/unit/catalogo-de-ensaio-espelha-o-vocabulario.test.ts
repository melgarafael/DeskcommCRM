import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXTENSION_CAPABILITIES, EXTENSION_PERMISSIONS } from "@/lib/extensions/capacidades";
import { checkCompatibility, parseManifest } from "@/lib/extensions/manifest";

/**
 * O CATÁLOGO DE ENSAIO É OUTRO PROCESSO, E POR ISSO ELE DIVERGE CALADO.
 *
 * `experiments/extensoes/catalog/catalog.py` é a bancada que os três E2E de extensão usam para
 * publicar um pacote (`make-example`). Ele é isolado de propósito — SQLite próprio, sem o banco
 * do CRM —, então não importa o TypeScript: ele REPETE o vocabulário em Python.
 *
 * Repetição sem guarda envelhece. Quando a ADR-0003 ampliou o contrato, a bancada continuou
 * validando `permissions == ["navigation.tasks"]` e gerando `host_api {1,1}` — ou seja, ela
 * passou a publicar um pacote que o host RECUSA. O sintoma não apareceu em nenhum teste
 * unitário: apareceu 22 minutos depois, no E2E, como três specs vermelhas cujo erro dizia
 * "instalação falhou" — longe da causa.
 *
 * Este arquivo compara as duas listas. É barato, roda em milissegundos, e reprova no lugar
 * onde a pessoa está editando.
 */

const CATALOG_PY = join(__dirname, "..", "..", "experiments", "extensoes", "catalog", "catalog.py");
const fonte = readFileSync(CATALOG_PY, "utf8");

/** Lê uma lista literal de strings do Python — `NOME = [ "a", "b" ]`. */
function listaPython(nome: string): string[] {
  const bloco = new RegExp(`^${nome}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m").exec(fonte);
  if (!bloco) throw new Error(`${nome} não encontrada em catalog.py`);
  return [...bloco[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

describe("o catálogo de ensaio espelha o vocabulário do host", () => {
  it("as permissões são as mesmas, na mesma ordem", () => {
    expect(listaPython("PERMISSOES")).toEqual([...EXTENSION_PERMISSIONS]);
  });

  it("as capacidades são as mesmas, na mesma ordem", () => {
    expect(listaPython("CAPACIDADES")).toEqual([...EXTENSION_CAPABILITIES]);
  });

  it("o pacote make-example da bancada é aceito pelo host", () => {
    const diretorio = mkdtempSync(join(tmpdir(), "catalogo-contrato-host-"));
    const arquivo = join(diretorio, "exemplo.json");
    try {
      const saida = spawnSync("python3", [CATALOG_PY, "make-example", "--output", arquivo], {
        encoding: "utf8",
      });
      expect(saida.error, "python3 indisponível: o caso não mediu nada").toBeUndefined();
      expect(saida.status, `make-example falhou:\n${saida.stdout}\n${saida.stderr}`).toBe(0);
      // Mede os bytes produzidos pelo CLI real, sem depender de uma constante privada do host.
      const manifesto = parseManifest(readFileSync(arquivo));
      expect(checkCompatibility(manifesto)).toEqual({ compatible: true, reason: null });
      for (const api of [1, 4]) {
        const exclusiva = parseManifest(Buffer.from(JSON.stringify({
          ...manifesto, host_api: { min: api, max: api },
        })));
        expect(checkCompatibility(exclusiva)).toEqual({
          compatible: false, reason: "host_api_unsupported",
        });
      }
    } finally {
      rmSync(diretorio, { recursive: true, force: true });
    }
  });

  it("a bancada não guarda mais o valor fixo do contrato v1", () => {
    // A forma exata que travou o E2E: comparação com a lista literal de um elemento.
    expect(fonte).not.toContain('!= ["navigation.tasks"]');
    expect(fonte).not.toContain('!= "tasks.open"');
  });

  /**
   * Os casos acima medem a FORMA — as listas batem, o texto proibido sumiu. Nenhum deles
   * garante que a validação USE as listas: dá para manter as constantes em dia e validar
   * contra outra coisa, e os três ficam verdes.
   *
   * Isto foi medido, não imaginado: uma sabotagem que trocou só a condição de validação,
   * mantendo a constante intacta, derrubou 1 caso quando eu tinha previsto 2. A previsão
   * errada é o que revelou o ponto cego.
   *
   * Este caso mede o EFEITO: roda a bancada de verdade contra um pacote de porta nova.
   */
  it("aceita, de fato, um pacote que usa porta nova — prova de efeito, não de forma", () => {
    const pacote = {
      format_version: 1,
      profile: "declarative",
      publisher: "laboratorio-local",
      name: "porta-nova",
      version: "1.0.0",
      license: "MIT",
      host_api: { min: 1, max: 2 },
      permissions: ["navigation.inbox"],
      dependencies: [],
      data: { mode: "none" },
      display: {
        title: { "pt-BR": "Porta nova" },
        summary: { "pt-BR": "Pacote de controle do invariante." },
        category: "service",
        icon: "ListChecks",
      },
      configuration: { density: "comfortable", show_description: true },
      contributions: {
        crm_cards: [
          {
            id: "cartao",
            title: { "pt-BR": "Cartão" },
            description: { "pt-BR": "Descrição do cartão de controle." },
            icon: "ListChecks",
            blocks: [{ heading: { "pt-BR": "Título" }, body: { "pt-BR": "Corpo." } }],
            action: { label: { "pt-BR": "Abrir" }, capability: "inbox.open" },
          },
        ],
      },
    };
    const arquivo = join(tmpdir(), `pacote-porta-nova-${process.pid}.json`);
    writeFileSync(arquivo, JSON.stringify(pacote));
    try {
      // `catalog.py` não tem subcomando de validação isolada (quem valida é o `publish`, que
      // exige banco). Chamamos a função real do módulo — é o mesmo código que o `publish` usa.
      const script = [
        "import importlib.util, json, sys, pathlib",
        `spec = importlib.util.spec_from_file_location("catalogo", ${JSON.stringify(CATALOG_PY)})`,
        "mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)",
        `mod.validate_manifest(json.loads(pathlib.Path(${JSON.stringify(arquivo)}).read_text()))`,
      ].join("\n");
      const saida = spawnSync("python3", ["-c", script], { encoding: "utf8" });
      // Controle positivo: se o comando nem existir, `status` é diferente de 0 por outro
      // motivo, e um teste que só olhasse "status !== 0" leria isso como recusa legítima.
      expect(saida.error, "python3 indisponível: o caso não mediu nada").toBeUndefined();
      expect(
        saida.status,
        `bancada recusou porta nova:\n${saida.stdout}\n${saida.stderr}`,
      ).toBe(0);
    } finally {
      rmSync(arquivo, { force: true });
    }
  });
});
