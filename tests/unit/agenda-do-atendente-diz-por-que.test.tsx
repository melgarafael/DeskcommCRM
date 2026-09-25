/**
 * A AGENDA DO ATENDENTE PRECISA DIZER POR QUE — issue 896, itens (a) e (b).
 *
 * ─── O defeito que esta cerca fecha ──────────────────────────────────────
 *
 * O atendente abre a agenda da dona. Duas telas mentem sobre quem está na
 * frente e sobre o que falta:
 *
 * (a) O rótulo. Com a lista da equipe vazia (o `403` do item 1 da issue, que a
 *     lista de pessoas da agenda tomava em todo papel abaixo de quem lê a
 *     equipe), o painel caía num fallback fixo `{ id: "", nome: "Você" }` e
 *     escrevia "com Você" e "Você ainda não publicou seus horários" sobre a
 *     jornada de OUTRA pessoa — a dona, que não estava naquela sessão. "Você",
 *     nessa tela, é quem está logado, e mais ninguém.
 *
 * (b) O dia de folga. Um dia DENTRO da jornada sem janela publicada dizia
 *     "Nenhum horário publicado neste dia": a mesma frase de quem nunca
 *     publicou jornada nenhuma. Os dois casos pedem coisas diferentes de quem
 *     lê — um espera o próximo dia útil, o outro precisa publicar horários — e
 *     a tela tratava os dois como o mesmo nada.
 *
 *     npx vitest run tests/unit/agenda-do-atendente-diz-por-que.test.tsx
 */
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PainelDeMarcacao } from "@/components/agenda/PainelDeMarcacao";
import type { Pessoa } from "@/components/agenda/tipos";
import {
  CAMPOS_DA_LISTA,
  PAPEL_MINIMO_DA_LISTA,
  motivoDaFalhaNaLista,
} from "@/lib/agenda/lista-de-pessoas";
import { resolverResponsavelDoPainel } from "@/lib/agenda/responsavel-do-painel";
import {
  MENSAGEM_UNICA_QUE_NAO_DISTINGUIA,
  mensagemDoDiaSemJanela,
} from "@/lib/agenda/o-que-falta-no-dia";

afterEach(cleanup);

/** Terça, 15 de setembro de 2026, meio-dia — hora de parede do processo. */
const AGORA = new Date("2026-09-15T12:00:00");
const DONA: Pessoa = { id: "dona", nome: "Ana", trilha: 1 };
const ATENDENTE = "atendente";

describe("(a) 'Você' é de quem está logado, não de quem não deu para listar", () => {
  it("sem a lista da equipe, a jornada da dona NÃO vira 'Você'", () => {
    // Estado do defeito: `pessoas: []` porque `GET /api/v1/team` deu 403 para o
    // atendente, e a agenda é a da dona (`donoId` dela).
    const pessoa = resolverResponsavelDoPainel({
      pessoas: [],
      donoId: DONA.id,
      usuarioId: ATENDENTE,
    });

    expect(pessoa.nome).not.toBe("Você");
    expect(pessoa.id).toBe(DONA.id);
  });

  it("a própria agenda continua dizendo 'Você'", () => {
    const pessoa = resolverResponsavelDoPainel({
      pessoas: [],
      donoId: ATENDENTE,
      usuarioId: ATENDENTE,
    });

    expect(pessoa.nome).toBe("Você");
  });

  it("com a lista em mãos, o nome é o do dono da agenda", () => {
    const pessoa = resolverResponsavelDoPainel({
      pessoas: [DONA, { id: ATENDENTE, nome: "Bruno", trilha: 2 }],
      donoId: DONA.id,
      usuarioId: ATENDENTE,
    });

    expect(pessoa.nome).toBe("Ana");
  });

  it("sem dono definido, a agenda é de quem está logado", () => {
    const pessoa = resolverResponsavelDoPainel({
      pessoas: [DONA, { id: ATENDENTE, nome: "Bruno", trilha: 2 }],
      donoId: null,
      usuarioId: ATENDENTE,
    });

    expect(pessoa.nome).toBe("Você");
  });

  it("o painel da dona não escreve 'Você' em lugar nenhum", () => {
    render(
      <PainelDeMarcacao
        ancora={AGORA}
        agora={AGORA}
        responsavel={resolverResponsavelDoPainel({
          pessoas: [],
          donoId: DONA.id,
          usuarioId: ATENDENTE,
        })}
        fuso="America/Sao_Paulo"
        horariosPorDia={{}}
        onConfirmar={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByTestId("painel-de-marcacao").textContent).not.toContain("Você");
  });
});

type Props = Partial<ComponentProps<typeof PainelDeMarcacao>>;

function montar(sobre: Props = {}) {
  render(
    <PainelDeMarcacao
      ancora={AGORA}
      agora={AGORA}
      responsavel={DONA}
      fuso="America/Sao_Paulo"
      // Nenhuma janela consultada: o painel abre na âncora (terça, 15) e a
      // grade só tem quarta.
      horariosPorDia={{}}
      permiteEncaixe
      {...sobre}
      onConfirmar={vi.fn(async () => undefined)}
    />,
  );
}

describe("(b) folga e jornada inexistente pedem coisas diferentes", () => {
  it("a folga DENTRO da jornada diz que o dia está fora dela", () => {
    const folga = mensagemDoDiaSemJanela(true);

    expect(folga).toContain("fora da jornada publicada");
    // A frase antiga dizia as duas coisas com as mesmas palavras; era ela que
    // fazia a folga parecer jornada que nunca foi configurada.
    expect(folga).not.toBe(MENSAGEM_UNICA_QUE_NAO_DISTINGUIA);
  });

  it("quem nunca publicou jornada ouve o outro caso, não o da folga", () => {
    const semJornada = mensagemDoDiaSemJanela(false);

    expect(semJornada).toContain("Nenhuma jornada publicada ainda");
    expect(semJornada).not.toContain("fora da jornada publicada");
    expect(semJornada).not.toBe(mensagemDoDiaSemJanela(true));
  });

  it("o painel diz o caso da folga sem repetir a frase que não distinguia", () => {
    montar({
      publicouHorarios: true,
      horarioInicial: { instante: "2026-09-15T13:00:00.000Z", rotulo: "10:00" },
    });

    const texto = screen.getByTestId("painel-de-marcacao").textContent ?? "";

    expect(texto).not.toContain(MENSAGEM_UNICA_QUE_NAO_DISTINGUIA);
  });

  it("sem jornada nenhuma, a tela não finge que é só o dia que está vazio", () => {
    montar({ publicouHorarios: false });

    // Com jornada, a porta do encaixe nem abre — e o que a tela diz é o outro
    // caso, o de quem precisa publicar horários.
    expect(screen.queryByTestId("encaixe")).toBeNull();
    const bloco = screen.getByTestId("sem-jornada-publicada").textContent ?? "";

    expect(bloco).toContain("A jornada de atendimento ainda não foi publicada");
    expect(screen.getByTestId("painel-de-marcacao").textContent).not.toContain(
      "fora da jornada publicada",
    );
  });

  it("a frase da folga sai LITERAL na tela — `t(variável)` escapava do guarda", () => {
    // Achado da triagem do #1107 (item 5): o guarda de espanhol
    // (`tests/unit/i18n-espanhol-cobre-a-tela.test.ts`) varre `t("literal")` e
    // era CEGO para `t(mensagemDoDiaSemJanela(publicouHorarios))` — a frase
    // ficava sem tradução com o guarda verde sobre a ausência. Na tela o texto
    // agora é literal, e é esta a amarra que impede o literal e a função de
    // divergirem em silêncio.
    //
    // O outro caso da função não tem literal no painel de propósito: só a folga
    // alcança o bloco do encaixe (`encaixeLigado` exige jornada publicada), e
    // "nunca publicou jornada" tem bloco próprio — este sim com o texto no
    // dicionário ("A jornada de atendimento ainda não foi publicada").
    const tela = fonte("components/agenda/PainelDeMarcacao.tsx");

    expect(tela).toContain(`t(${JSON.stringify(mensagemDoDiaSemJanela(true))})`);
  });
});

/**
 * A lista de pessoas da AGENDA — issue 896, item 1 (a mesma que fazia o rótulo
 * cair em "Você": sem lista, o painel não sabe de quem é a jornada).
 *
 * O Atendente tomava 403 em `GET /api/v1/team`, que é manager+ e devolve e-mail
 * e último acesso. O conserto NÃO foi baixar o papel dessa rota — seria entregar
 * PII a quem só precisa de nome — e sim uma lista mínima, com o menor papel que
 * resolve o trabalho do atendente. Estes testes leem o fonte de propósito: o
 * defeito volta tanto por afrouxar a rota antiga quanto por a agenda voltar a
 * pedir a lista a quem não pode lê-la.
 */
const RAIZ = process.cwd();

function fonte(rel: string): string {
  return readFileSync(`${RAIZ}/${rel}`, "utf8");
}

describe("(c) o Atendente lê a lista de pessoas da agenda", () => {
  it("o papel mínimo da lista é o do Atendente, não o de quem lê a equipe", () => {
    expect(PAPEL_MINIMO_DA_LISTA).toBe("agent");
  });

  it("a lista exposta é a mínima: sem e-mail, sem último acesso", () => {
    expect([...CAMPOS_DA_LISTA]).toEqual(["user_id", "role", "full_name"]);
  });

  it("a rota da lista usa o papel mínimo e seleciona só o que a barra usa", () => {
    const rota = fonte("app/api/v1/agenda/pessoas/route.ts");

    expect(rota).toContain("requireRole(PAPEL_MINIMO_DA_LISTA");
    expect(rota).toContain('.select("user_id, role")');
    expect(rota).not.toContain("selectedEmail");
    expect(rota).not.toContain('select("user_id, role, email');
  });

  it("a agenda pede a lista mínima, e não a rota da equipe", () => {
    const hook = fonte("hooks/agenda/usePessoasDaAgenda.ts");

    expect(hook).toContain("ROTA_DA_LISTA_DE_PESSOAS");
    expect(hook).not.toContain('apiClient.get<{ data: MembroDto[] }>("/api/v1/team")');
  });

  it("quando a lista não vem, a tela diz de QUE permissão se trata", () => {
    const aviso = motivoDaFalhaNaLista(403);

    expect(aviso).toContain("lista da equipe");
    expect(aviso).toContain("atendente");
    // A frase genérica do aviso de 403 é o que a issue chama de "sem motivo".
    expect(aviso).not.toBe("Você não tem permissão para esta ação.");
    expect(aviso).not.toContain("Você não tem permissão para esta ação");

    const hook = fonte("hooks/agenda/usePessoasDaAgenda.ts");
    expect(hook).toContain("motivoDaFalhaNaLista");
  });
});

/**
 * (d) A TELA DA AGENDA NÃO PEDE A LISTA À ROTA DA EQUIPE — E A PROSA NÃO DIZ QUE
 * PEDE.
 *
 * O comentário de 17/09 na issue #978 leu `app/app/agenda/_client.tsx:215` e
 * concluiu que abrir a Agenda como Atendente dispara toast falso de falta de
 * permissão, porque a tela chamaria `usePessoasDaAgenda()` e a lista viria de
 * `GET /api/v1/team` (`manager+`). A CHAMADA não existe mais desde o item 1 da
 * issue 896 — o hook lê `ROTA_DA_LISTA_DE_PESSOAS`, e o caso "(c)" acima já
 * vigia isso. O que sobrou foi a FRASE, e ela foi consertada junto com a opção
 * da migration 0343: um comentário que afirma um caminho extinto é o defeito de
 * novo, porque a próxima pessoa a medir o 403 vai medi-lo na prosa.
 *
 * Medido nesta rodada, no worktree da #978:
 *   grep -rn "api/v1/team" app/app/agenda/ | grep -c "apiClient\.get"   → 0
 *   grep -rn "vêm de \`/api/v1/team\`" app/                             → 0
 *   grep -rn "leitura de \`/api/v1/team\`" app/                         → 0
 */
describe("(d) a agenda não atribui a lista de pessoas à rota da equipe", () => {
  it("a tela e a página não chamam `/api/v1/team`", () => {
    for (const arquivo of ["app/app/agenda/_client.tsx", "app/app/agenda/page.tsx"]) {
      expect(fonte(arquivo), arquivo).not.toMatch(/apiClient\.[a-z]+[^\n]*\/api\/v1\/team/);
    }
  });

  it("as duas frases que diziam vir de `/api/v1/team` foram reescritas", () => {
    // As frases EXATAS que a medição de 17/09 leu. Não é vigilância de palavra:
    // é a garantia de que voltar a afirmar isso exige uma decisão consciente.
    expect(fonte("app/app/agenda/_client.tsx")).not.toContain(
      "AS PESSOAS SÃO REAIS: vêm de `/api/v1/team`",
    );
    expect(fonte("app/app/agenda/page.tsx")).not.toContain("leitura de `/api/v1/team`");
  });

  it("a tela aponta para a lista mínima, que é o caminho que existe", () => {
    expect(fonte("app/app/agenda/_client.tsx")).toContain("/api/v1/agenda/pessoas");
  });
});
