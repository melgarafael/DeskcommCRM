import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { calcularBump, FragmentoInvalido, parseFragmento } from "@/lib/release/fragmento";

/**
 * O gate do fragmento — e o que ele deliberadamente NÃO faz.
 *
 * Ele valida a FORMA de todo fragmento em `.changes/`, e não cobra a PRESENÇA
 * de um. Cobrar presença dentro de um check obrigatório quebraria três coisas
 * que este repo tem de verdade: os PRs do Dependabot (`.github/dependabot.yml`,
 * dois ecossistemas), os PRs de fork de quem contribui de fora, e — o mais
 * absurdo — o próprio PR de release, que por construção CONSOME os fragmentos e
 * deixa `.changes/` vazio. O gate existiria para produzir esse PR e o reprovaria.
 *
 * A presença é cobrada onde não trava robô: no item do Definition of Done
 * (`CLAUDE.md`) e na régua de `docs/doctrine/versionamento.md`.
 *
 * O que ESTE gate impede é o defeito que a revisão humana não pega: um
 * fragmento malformado chega ao `CHANGELOG.md`, que é TELA — e o dono da VPS lê
 * um aviso decapitado, ou não lê o aviso nenhum.
 */
const DIR = path.join(process.cwd(), ".changes");

function arquivos(): string[] {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => f.endsWith(".md")).sort();
}

/** kebab-case: o nome vira parte do diff, e maiúscula/espaço quebram em outro SO. */
const NOME_VALIDO = /^[a-z0-9][a-z0-9-]*\.md$/;

describe("os fragmentos de .changes/ estão em forma de chegar à tela", () => {
  it("o diretório existe — sem ele o corte de release não tem de onde ler", () => {
    expect(fs.existsSync(DIR), ".changes/ sumiu: veja docs/doctrine/versionamento.md").toBe(true);
  });

  it.each(arquivos())("%s é legível, válido e nomeado em kebab-case", (arquivo) => {
    expect(arquivo, `nome fora do padrão kebab-case: ${arquivo}`).toMatch(NOME_VALIDO);
    const texto = fs.readFileSync(path.join(DIR, arquivo), "utf8");
    expect(() => parseFragmento(arquivo, texto)).not.toThrow();
  });

  it("o conjunto produz um número, ou não há release a cortar", () => {
    const impactos = arquivos().map((a) => parseFragmento(a, fs.readFileSync(path.join(DIR, a), "utf8")).impacto);
    if (impactos.length === 0) {
      expect(() => calcularBump(impactos)).toThrow(FragmentoInvalido);
      return;
    }
    expect(["patch", "minor", "major"]).toContain(calcularBump(impactos));
  });

  // Caso SINTÉTICO: não depende de `.changes/` ter conteúdo. Sem ele, com o
  // diretório vazio esta suíte ficaria verde sem exercitar validação nenhuma —
  // um gate que só reprova quando alguém já acertou não é gate.
  it("um fragmento malformado É recusado (a validação está viva, com o diretório vazio ou não)", () => {
    expect(() => parseFragmento("ruim.md", "sem frontmatter nenhum")).toThrow(FragmentoInvalido);
    expect(() =>
      parseFragmento("ruim.md", "---\nimpacto: minor\nsecao: corrigido\ntitulo: x\n---\n\ncorpo"),
    ).toThrow(FragmentoInvalido);
  });

  it("título com aspa NO MEIO chega inteiro à tela", () => {
    // ⚠️ Defeito real, e ele passou por este gate: a limpeza de aspas tirava
    // cada ponta INDEPENDENTE, então
    //
    //     titulo: "Quero 2 iPhone 15" volta a encontrar o iPhone 15
    //
    // virava `Quero 2 iPhone 15" volta a encontrar o iPhone 15` — a aspa de
    // abertura sumia e a do meio ficava órfã. É ISSO que chega ao CHANGELOG que
    // o dono da VPS lê antes de atualizar.
    //
    // Num produto de atendimento, citar o que o cliente digita é o caso natural
    // do título, não a exceção.
    const comAspa = parseFragmento(
      "x.md",
      ['---', 'impacto: nada_mudou', 'secao: corrigido',
       'titulo: "Quero 2 iPhone 15" volta a encontrar o iPhone 15', '---', '', 'corpo.'].join("\n"),
    );
    expect(comAspa.titulo).toBe('"Quero 2 iPhone 15" volta a encontrar o iPhone 15');
  });

  it("aspas que ENVOLVEM o título inteiro continuam sendo removidas (controle)", () => {
    // Sem este caso, "nunca tirar aspa" satisfaria o anterior — e aí todo
    // título escrito no estilo YAML chegaria com as aspas na tela.
    const envolvido = parseFragmento(
      "x.md",
      ['---', 'impacto: nada_mudou', 'secao: corrigido',
       'titulo: "o título inteiro entre aspas"', '---', '', 'corpo.'].join("\n"),
    );
    expect(envolvido.titulo).toBe("o título inteiro entre aspas");
  });
});

// ═══ O fragmento da #4737 e a RLS (#4800) ═══════════════════════════════════
//
// A promessa do fragmento é o que o dono da VPS lê antes de atualizar. O da
// #4737 dizia "Desligada, nada muda: o atendente vê a equipe inteira como
// hoje" — e isso é FALSO: `crm_tasks_select` chama `fn_can_view_task`, que
// recorta por `settings.visibility_mode`. Com a chave da #4737 desligada e a
// visibilidade em "Os seus, mais os que ainda não têm dono" (o padrão) ou em
// "Só os seus", a RLS já esconde a tarefa do colega.
//
// ⚠️ Nenhum caso aqui cita um fragmento pelo NOME: o corte de release apaga
// `.changes/` por definição, e um teste amarrado a um arquivo nasce verde no PR
// que o criou e fica vermelho no PR de release (é o que
// `teste-nao-fixa-fragmento-de-release.test.ts` guarda). A regra é aplicada a
// TODOS os fragmentos que anunciam esta opção — com `.changes/` vazio, ela não
// tem o que julgar, e passa como as outras cercas genéricas.
const OPCAO_DAS_TAREFAS = /atendente vê só as próprias tarefas/i;

/** Os fragmentos que anunciam a opção da #4737 (hoje: um; no corte: nenhum). */
function fragmentosDaOpcaoDasTarefas(): Array<{ arquivo: string; corpo: string }> {
  return arquivos()
    .map((arquivo) => ({
      arquivo,
      corpo: parseFragmento(arquivo, fs.readFileSync(path.join(DIR, arquivo), "utf8")).corpo,
    }))
    .filter((f) => OPCAO_DAS_TAREFAS.test(f.corpo));
}

/** Os parágrafos que começam falando da opção DESLIGADA. */
function paragrafosDaChaveDesligada(corpo: string): string[] {
  return corpo.split(/\n\s*\n/).filter((paragrafo) => /^\s*desligad/i.test(paragrafo));
}

/**
 * O parágrafo que fala da opção DESLIGADA promete a equipe inteira sem dizer
 * que "O que cada atendente enxerga" já recorta?
 *
 * `true` = mente. É o detector que os casos abaixo usam; ele é provado contra
 * a frase ANTIGA, para não passar por acidente num texto que ninguém lê.
 */
function prometeEquipeInteiraSemCitarOVisibilidade(corpo: string): boolean {
  return paragrafosDaChaveDesligada(corpo).some(
    (paragrafo) => !/O que cada atendente enxerga|visibility_mode/.test(paragrafo),
  );
}

describe("o fragmento da #4737 não promete o que a RLS não entrega (#4800)", () => {
  it("a policy do baseline recorta por visibilidade e libera o CRIADOR — a premissa do texto", () => {
    const baseline = fs.readFileSync(path.join(process.cwd(), "supabase/baseline.sql"), "utf8");

    const daPolicy = baseline.slice(
      baseline.indexOf("create policy crm_tasks_select on public.crm_tasks"),
    );
    // A leitura da tarefa é decidida pelo PAR (responsável, criador) — não só
    // pelo responsável. É o que o fragmento passou a dizer.
    expect(daPolicy.slice(0, 700)).toMatch(
      /fn_can_view_task\(organization_id, assigned_to, created_by\)/,
    );

    const daFuncao = baseline.slice(
      baseline.indexOf("create or replace function public.fn_can_view_task"),
    );
    const corpoDaFuncao = daFuncao.slice(0, 1200);
    expect(corpoDaFuncao).toContain("when p_created_by = auth.uid() then true");
    expect(corpoDaFuncao).toContain("when 'own_and_unassigned' then p_assigned_to is null");
    // E o modo mais fechado: nada além do que é dele.
    expect(corpoDaFuncao).toContain("else false");
  });

  it("⭐ o detector pega a frase antiga — e ela não está em nenhum fragmento", () => {
    const antiga =
      "Desligada, nada muda: o atendente vê a equipe inteira como hoje, e filtrar pelo id de um colega continua funcionando.";
    // Controle: com o texto que o PR trazia, o detector acusa a mentira.
    expect(prometeEquipeInteiraSemCitarOVisibilidade(antiga)).toBe(true);

    for (const { arquivo, corpo } of fragmentosDaOpcaoDasTarefas()) {
      expect(prometeEquipeInteiraSemCitarOVisibilidade(corpo), arquivo).toBe(false);
      expect(corpo, arquivo).not.toMatch(/nada muda:\s*o atendente vê a equipe inteira/i);
    }
  });

  it("⭐ desligada, o fragmento diz o que a RLS entrega nos TRÊS modos de visibilidade", () => {
    for (const { arquivo, corpo } of fragmentosDaOpcaoDasTarefas()) {
      const paragrafos = paragrafosDaChaveDesligada(corpo);
      expect(paragrafos.length, `${arquivo}: não fala da opção desligada`).toBeGreaterThan(0);
      // O fragmento é prosa com quebra de linha de 80 colunas: comparar com o
      // texto corrido evita depender de onde a linha quebrou.
      const texto = paragrafos.join(" ").replace(/\s+/g, " ");
      // A ressalva que faltava: quem recorta é a visibilidade da organização.
      expect(texto, arquivo).toMatch(/O que cada atendente enxerga/);
      expect(texto, arquivo).toMatch(/Todos veem tudo/);
      expect(texto, arquivo).toMatch(/Os seus, mais os que ainda não têm dono/);
      expect(texto, arquivo).toMatch(/Só os seus/);
    }
  });
});
