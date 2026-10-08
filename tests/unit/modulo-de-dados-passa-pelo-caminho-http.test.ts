import { describe, expect, it } from "vitest";

import { checkCompatibility, parseManifest } from "@/lib/extensions/manifest";
import { portasLegiveis } from "@/lib/extensions/portas-legiveis";

/**
 * O defeito que este arquivo existe para impedir JÁ ACONTECEU DUAS VEZES neste projeto.
 *
 * No perfil v2 (PR #1162), a lista de capacidades foi de uma para seis, o manifesto e o mapa do host
 * acompanharam — e dois pontos do caminho HTTP não: o schema ficou em `z.literal("tasks.open")` e a
 * rota devolvia `/app/tasks` literal. Resultado: a extensão instalava, aparecia, ativava, e o botão
 * não abria nada. Nenhum teste pegou, porque todos exercitavam manifesto e mapa, e os dois estavam
 * certos.
 *
 * O mesmo buraco se abriria agora: o banco passou a aceitar `profile: "data"` e a concessão
 * `dados.proprios`, mas quem valida ANTES do banco é o parser do serviço. Se ele recusa, nenhum
 * pacote de dados chega à função que compila — a porta não existiria, e os invariantes de banco
 * ficariam todos verdes mentindo.
 *
 * Por isso a prova é aqui, no caminho de quem chega pela rota.
 */

/** Um pacote de dados mínimo, como um módulo de nicho o publicaria. */
function pacoteDeDados() {
  return {
    format_version: 1,
    profile: "data",
    publisher: "clinica",
    name: "odontograma",
    version: "1.0.0",
    license: "MIT",
    host_api: { min: 2, max: 2 },
    permissions: ["dados.proprios"],
    dependencies: [],
    data: {
      mode: "declarado",
      objetos: [
        {
          slug: "marcacao",
          rotulo: { "pt-BR": "Marcação" },
          campos: [
            { slug: "dente", tipo: "inteiro", obrigatorio: true },
            { slug: "condicao", tipo: "texto", obrigatorio: true },
          ],
          refs: [{ slug: "paciente", entidade: "contato", obrigatorio: true, ao_apagar: "cascata" }],
        },
      ],
    },
    display: {
      title: { "pt-BR": "Odontograma" },
      summary: { "pt-BR": "Dente a dente" },
      category: "productivity",
      icon: "ListChecks",
    },
    configuration: {},
    contributions: {},
  };
}

const bytes = (valor: unknown) => new TextEncoder().encode(JSON.stringify(valor));

describe("o caminho HTTP aceita o pacote de dados que o banco aceita", () => {
  it("o parser do serviço faz parse de um pacote `data` em vez de recusá-lo", () => {
    const pacote = pacoteDeDados();
    expect(() => parseManifest(bytes(pacote))).not.toThrow();
    expect(parseManifest(bytes(pacote)).profile).toBe("data");
  });

  it("a conferência de compatibilidade não recusa o perfil `data` nem a concessão de dados próprios", () => {
    const resultado = checkCompatibility({
      format_version: 1,
      profile: "data",
      host_api: { min: 2, max: 2 },
      dependencies: [],
      permissions: ["dados.proprios"],
    } as Parameters<typeof checkCompatibility>[0]);
    expect(resultado).toMatchObject({ compatible: true });
  });

  it("perfil desconhecido continua recusado: a lista é fechada, não um passe livre", () => {
    const resultado = checkCompatibility({
      format_version: 1,
      profile: "codigo",
      host_api: { min: 2, max: 2 },
      dependencies: [],
      permissions: ["dados.proprios"],
    } as unknown as Parameters<typeof checkCompatibility>[0]);
    expect(resultado).toMatchObject({ compatible: false });
  });

  it("o perfil declarativo não ganha folga nenhuma: `data` fora de `{mode:none}` é recusado", () => {
    const declarativo = {
      ...pacoteDeDados(),
      profile: "declarative",
      permissions: ["navigation.tasks"],
      contributions: {
        crm_cards: [
          {
            id: "primeiro",
            title: { "pt-BR": "Começar" },
            description: { "pt-BR": "Passo inicial" },
            icon: "ListChecks",
            blocks: [{ heading: { "pt-BR": "Ação" }, body: { "pt-BR": "Crie sua tarefa" } }],
            action: { label: { "pt-BR": "Abrir tarefas" }, capability: "tasks.open" },
          },
        ],
      },
    };
    expect(() => parseManifest(bytes(declarativo))).toThrow();
  });
});

describe("a tela de consentimento diz que o módulo GUARDA informação", () => {
  // A lista de concessões é a única coisa que a pessoa tem para decidir. A frase de hoje — "Abre X;
  // não lê seus dados." — foi escrita para portas de NAVEGAÇÃO. Um módulo de dados não abre tela
  // nenhuma: ele guarda fichas próprias na instalação. Deixar a frase antiga cobrir esse caso
  // esconderia da tela exatamente o que o módulo faz, que é o furo que `portas-legiveis` existe para
  // fechar.
  it("a concessão de dados próprios aparece como guardar, não como abrir", () => {
    const frase = portasLegiveis(["dados.proprios"]);
    expect(frase).toMatch(/guarda/i);
    expect(frase).not.toMatch(/^Abre/);
  });

  it("com porta de navegação E dados, a frase diz as duas coisas", () => {
    const frase = portasLegiveis(["navigation.inbox", "dados.proprios"]);
    expect(frase).toMatch(/Conversas/);
    expect(frase).toMatch(/guarda/i);
  });

  it("só navegação continua com a frase de sempre, sem mencionar guardar", () => {
    const frase = portasLegiveis(["navigation.inbox"]);
    expect(frase).toBe("Abre Conversas; não lê seus dados.");
  });
});
