import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { ehIdentificadorTecnico, nomeDoContato, rotuloDoContato, SEM_NOME } from "@/lib/contacts/rotulo-do-contato";

/**
 * COMO SE CHAMA ESTA PESSOA NA TELA.
 *
 * Dois grupos, e o segundo é o que importa a longo prazo:
 *
 *  1. a REGRA — identificador técnico nunca vira nome, telefone é melhor que
 *     "Sem nome", e nome legítimo não é confundido com id;
 *  2. a UNICIDADE — nenhuma tela nova volta a escrever a própria cadeia. Sem
 *     este segundo grupo, a função central vira a sétima cópia em vez de
 *     substituir as seis.
 */

describe("ehIdentificadorTecnico", () => {
  it("reconhece os sufixos de endereçamento do WhatsApp", () => {
    expect(ehIdentificadorTecnico("Contato 543134@lid")).toBe(true);
    expect(ehIdentificadorTecnico("5531988887777@c.us")).toBe(true);
    expect(ehIdentificadorTecnico("120363@g.us")).toBe(true);
    expect(ehIdentificadorTecnico("558183647258@s.whatsapp.net")).toBe(true);
  });

  it("reconhece o rótulo que o código antigo inventava", () => {
    // Duas formas conviviam na produção — duas versões do mesmo bug.
    expect(ehIdentificadorTecnico("Contato 900928")).toBe(true);
    expect(ehIdentificadorTecnico("Contato 543134@lid")).toBe(true);
  });

  it("NÃO confunde nome de gente com identificador", () => {
    // Recusar um nome legítimo é pior que deixar passar um técnico: apaga a
    // identidade de uma pessoa real da tela de quem a atende.
    expect(ehIdentificadorTecnico("Contato Comercial da Loja")).toBe(false);
    expect(ehIdentificadorTecnico("Kaio Gomes")).toBe(false);
    expect(ehIdentificadorTecnico("Ana")).toBe(false);
    expect(ehIdentificadorTecnico("Loja 24h")).toBe(false);
    expect(ehIdentificadorTecnico("Contato 2 da obra"), "dígito no meio não é id").toBe(false);
  });
});

describe("rotuloDoContato", () => {
  it("prefere o nome que uma pessoa escolheu", () => {
    // `name` é o que "Editar contato" grava e o que a proposta de dado aprovada
    // escreve; `display_name` é o nome do perfil do WhatsApp, gravado pela
    // ingestão, e nenhuma tela o edita. Esta asserção esperava o contrário, e o
    // nome digitado pelo operador nunca aparecia (issue #906).
    expect(rotuloDoContato({ display_name: "🌸 Kaio", name: "Kaio Gomes", phone_number: "+5531988887777" })).toBe(
      "Kaio Gomes",
    );
  });

  it("sem nome escolhido, usa o que o canal informou", () => {
    expect(rotuloDoContato({ display_name: "🌸 Kaio", name: null, phone_number: "+5531988887777" })).toBe("🌸 Kaio");
  });

  it("pula o display_name TÉCNICO e usa o que vier depois", () => {
    // Era o caso vivo na produção: 3 contatos com o rótulo inventado gravado.
    // Sem esta regra, consertar o título do lead para ler do cadastro faria
    // `Contato 543134@lid` aparecer no card do kanban.
    expect(
      rotuloDoContato({ display_name: "Contato 543134@lid", name: null, phone_number: "+5531988887777" }),
    ).toBe("+5531988887777");
  });

  it("o TELEFONE vale mais que 'Sem nome' — e duas telas o ignoravam", () => {
    expect(rotuloDoContato({ display_name: null, name: null, phone_number: "+5531988887777" })).toBe(
      "+5531988887777",
    );
  });

  it("celular BR sem o nono aparece COM o 9", () => {
    expect(rotuloDoContato({ display_name: null, name: null, phone_number: "+553284793302" })).toBe(
      "+5532984793302",
    );
  });

  it("sem nada apresentável, UM literal — não quatro", () => {
    expect(rotuloDoContato({ display_name: null, name: null, phone_number: null })).toBe(SEM_NOME);
    expect(rotuloDoContato({ display_name: "   ", name: "", phone_number: "" })).toBe(SEM_NOME);
    expect(rotuloDoContato(null)).toBe(SEM_NOME);
    expect(rotuloDoContato(undefined)).toBe(SEM_NOME);
  });

  it("não devolve identificador técnico NEM QUANDO é a única coisa que existe", () => {
    // A saída aqui é admitir que não se sabe o nome. Mostrar o `@lid` seria
    // vocabulário de máquina na tela de quem atende — a doença que a spec 16
    // mediu em 30% dos turnos.
    expect(rotuloDoContato({ display_name: "Contato 543134@lid", name: null, phone_number: null })).toBe(
      SEM_NOME,
    );
  });
});

describe("nomeDoContato — o nome de gente, sem telefone nem literal", () => {
  // Para quem FALA com a pessoa (prompt do agente, lembrete ao cliente): cair no
  // telefone ali seria chamar o cliente de "+5531…". Cada chamador põe o próprio
  // fallback.
  it("prefere o nome escolhido ao do canal", () => {
    expect(nomeDoContato({ display_name: "🌸 Kaio", name: "Kaio Gomes" })).toBe("Kaio Gomes");
  });

  it("nome escolhido técnico cai para o do canal", () => {
    expect(nomeDoContato({ display_name: "Kaio", name: "Contato 543134@lid" })).toBe("Kaio");
  });

  it("sem nome de gente devolve null, nunca o telefone", () => {
    expect(nomeDoContato({ display_name: null, name: " ", phone_number: "+5531988887777" })).toBeNull();
    expect(nomeDoContato(null)).toBeNull();
  });
});

describe("a sétima cópia não nasce", () => {
  /**
   * A ASSINATURA DA CADEIA — `display_name` ENCOSTADO num coalescente (`||` ou
   * `??`), de qualquer um dos dois lados.
   *
   * Três versões desta regex já deixaram a guarda verde com o defeito vivo, e
   * cada linha abaixo é uma delas paga:
   *
   *  - **o coalescente.** A primeira exigia `||`. Os oito pontos que a issue #906
   *    consertou usavam `??` (`contact.display_name ?? contact.name`), então a
   *    varredura passou verde enquanto o defeito rodava em produção desde a
   *    v1.27.1.
   *  - **o lado.** Só `display_name` À ESQUERDA do coalescente. Depois de #906 a
   *    cadeia certa termina em `display_name` (`c.name ?? c.display_name`), e
   *    toda cópia nova nasceria do lado cego.
   *  - **o nome largado.** A segunda exigia o PAR `name` + `display_name`, para
   *    não reprovar leitura de canal. Com isso ela não via
   *    `contato.display_name ?? contato.phone_number` — a cópia que pula o nome
   *    que alguém escolheu, que é o próprio defeito da #906 com outra cara. O
   *    preço de fechar o buraco foi MEDIDO antes de ser recusado: onze linhas,
   *    e elas moram em `LEITURAS_LEGITIMAS`, cada uma com o motivo.
   *
   * ESCOPO, porque a guarda continua não sendo total. Ela não vê uma cópia que
   * não mencione `display_name` (`contact.name ?? contact.phone_number`), nem
   * uma que o separe do coalescente por uma chamada (`f(c.display_name) ?? x`),
   * nem linha que contenha `org`, `tenant` ou `session` (ver o filtro abaixo).
   * Quem segura esses casos é teste de COMPORTAMENTO, nos pontos que gravam ou
   * falam: `automacao-e-agenda-chamam-o-contato-pelo-nome-escolhido`,
   * `contexto-do-agente-chama-o-cliente-pelo-nome-escolhido` e
   * `radar-chama-o-contato-pelo-nome-escolhido`.
   */
  const CADEIA = /(display_name\b\s*(\?\.\s*trim\(\)\s*)?(\|\||\?\?))|((\|\||\?\?)\s*[\w$.?]*display_name\b)/;

  /**
   * As leituras de `display_name` com coalescente que NÃO são o nome de um
   * contato. Chave por arquivo E trecho, não por número de linha: número de
   * linha quebra na primeira edição acima dele, e só o arquivo deixaria passar
   * uma cópia nova escrita no mesmo arquivo de uma leitura legítima.
   *
   * A lista SÓ ENCOLHE: entrada cujo trecho não existe mais reprova (ver o
   * último caso), para não sobrar autorização em nome de código que sumiu.
   */
  const LEITURAS_LEGITIMAS: ReadonlyArray<{ arquivo: string; trecho: string; motivo: string }> = [
    {
      arquivo: "app/api/v1/channels/official/route.ts",
      trecho: "displayName: data?.display_name ?? null,",
      motivo: "nome do NÚMERO no canal oficial da Meta, não de contato",
    },
    {
      arquivo: "app/api/v1/contacts/_handler.ts",
      trecho: "display_name: input.display_name ?? null,",
      motivo: "grava a coluna que veio no corpo; não decide o nome exibido",
    },
    {
      arquivo: "app/api/v1/contacts/import/route.ts",
      trecho: "display_name: contato.display_name ?? null,",
      motivo: "grava a coluna lida do CSV; não decide o nome exibido",
    },
    {
      arquivo: "app/api/v1/cron/channel-health/route.ts",
      trecho: 'const apelido = s.display_name ?? s.phone_number ?? "sem nome";',
      motivo: "apelido do CANAL no aviso de saúde; `channel_sessions` não tem `name`",
    },
    {
      arquivo: "app/app/contacts/[id]/_client.tsx",
      trecho: '{contact.display_name ?? "—"}',
      motivo: "a ficha mostra a COLUNA `display_name` com rótulo próprio, logo abaixo de `name`",
    },
    {
      arquivo: "components/connections/CanalParceiroClient.tsx",
      trecho: 'estado?.display_name ?? t("Número conectado")',
      motivo: "nome do CANAL conectado",
    },
    {
      arquivo: "components/inbox/ConversationListItem.tsx",
      trecho: "canal?.phone_number ?? canal?.display_name ?? null",
      motivo: "número da EMPRESA por onde a conversa chegou, não o do cliente",
    },
    {
      arquivo: "lib/ai/classifier-models.ts",
      trecho: "display_name: m.display_name ?? m.model_id,",
      motivo: "nome de MODELO de IA",
    },
    {
      arquivo: "lib/channels/estado.ts",
      trecho: '(c.display_name ?? "").trim()',
      motivo: "`nomeDoCanal` — a função central do rótulo de canal",
    },
    {
      arquivo: "lib/lgpd/export-collector.ts",
      trecho: 'display_name: data.display_name ?? "",',
      motivo: "`organizations.display_name` do controlador no export de LGPD",
    },
    {
      arquivo: "lib/lgpd/export-collector.ts",
      trecho: "display_name: data.display_name ?? null,",
      motivo: "o export de LGPD entrega as DUAS colunas do titular cruas; não decide nome",
    },
  ];

  /**
   * `hooks` e `workers` ENTRAM. Ficavam de fora, e dois dos oito pontos que a
   * #906 consertou moravam exatamente lá (`hooks/notifications/
   * useInboundMessageAlerts.ts` e `workers/ai-response-worker.ts`): a guarda não
   * teria reprovado nenhum deles.
   */
  const DIRETORIOS = ["ls-files", "app", "lib", "components", "hooks", "workers"];

  function arquivosVarridos(): string[] {
    return execFileSync("git", DIRETORIOS, { encoding: "utf8" })
      .split("\n")
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => f !== "lib/contacts/rotulo-do-contato.ts");
  }

  /** Uma passada só serve aos dois casos: o que reincide e o que a lista autoriza em vão. */
  function varrer(): { reincidentes: string[]; autorizadas: Set<(typeof LEITURAS_LEGITIMAS)[number]> } {
    const reincidentes: string[] = [];
    const autorizadas = new Set<(typeof LEITURAS_LEGITIMAS)[number]>();
    for (const f of arquivosVarridos()) {
      const linhas = fs.readFileSync(path.join(process.cwd(), f), "utf8").split("\n");
      linhas.forEach((linha, i) => {
        // Fora as organizações: `organizations.display_name` é outro conceito e
        // tem cadeia própria e legítima.
        if (!CADEIA.test(linha) || /org|tenant|session/i.test(linha)) return;
        const legitima = LEITURAS_LEGITIMAS.find((l) => l.arquivo === f && linha.includes(l.trecho));
        if (legitima) autorizadas.add(legitima);
        else reincidentes.push(`${f}:${i + 1}: ${linha.trim().slice(0, 110)}`);
      });
    }
    return { reincidentes, autorizadas };
  }

  it("a regex RECONHECE a cadeia nas três formas que já passaram — e não casa com menção solta", () => {
    // Sem este caso, quem "simplificar" a regex desarma a varredura sem que nada
    // fique vermelho: uma regex que não casa com nada devolve lista vazia, que é
    // exatamente o que a guarda chama de sucesso.
    for (const defeito of [
      `const n = c.display_name || c.name || "Sem nome";`,
      `const n = c.display_name ?? c.name ?? "Sem nome";`,
      `const n = contato.display_name?.trim() || contato.name || "—";`,
      `const n = c.name ?? c.display_name ?? c.phone_number ?? "Lead da automação";`,
      // `display_name` por ÚLTIMO, sem coalescente à direita — o lado cego da primeira regex.
      `return alvo?.name ?? alvo?.display_name;`,
      // o nome escolhido LARGADO — o lado cego da regex do par.
      `const n = contato.display_name ?? contato.phone_number ?? "Sem nome";`,
    ]) {
      expect(CADEIA.test(defeito), defeito).toBe(true);
    }

    for (const mencao of [
      `.select("id, name, display_name")`,
      `column="display_name"`,
      `<dd className="mt-1">{contact.display_name}</dd>`,
      `const { display_name } = contato;`,
    ]) {
      expect(CADEIA.test(mencao), mencao).toBe(false);
    }
  });

  it("nenhum arquivo remonta a cadeia de fallback à mão", () => {
    // A função central só resolve o problema enquanto for a ÚNICA. Seis cópias
    // não divergiram por descuido: cada tela nova reescreveu a cadeia do jeito
    // que parecia certo naquele arquivo, e nasceram quatro finais diferentes.
    //
    // Leitura nova que NÃO é nome de contato (canal, modelo, gravação de campo)
    // entra em `LEITURAS_LEGITIMAS`, com o motivo. Nome de contato usa
    // `nomeDoContato` ou `rotuloDoContato`.
    const { reincidentes } = varrer();
    expect(reincidentes, `\n${reincidentes.join("\n")}\n`).toEqual([]);
  });

  it("toda entrada de LEITURAS_LEGITIMAS ainda casa com uma linha real — a lista só encolhe", () => {
    const { autorizadas } = varrer();
    const vencidas = LEITURAS_LEGITIMAS.filter((l) => !autorizadas.has(l)).map((l) => `${l.arquivo}: ${l.trecho}`);
    expect(vencidas, `\napague da lista:\n${vencidas.join("\n")}\n`).toEqual([]);
  });

  it("a varredura ENXERGA arquivos — controle positivo", () => {
    const arquivos = arquivosVarridos();
    expect(arquivos.length).toBeGreaterThan(100);
    // Os dois diretórios que a versão anterior não varria, e onde moravam dois
    // dos oito pontos da #906. Tirá-los de `DIRETORIOS` fica vermelho aqui.
    expect(arquivos).toContain("hooks/notifications/useInboundMessageAlerts.ts");
    expect(arquivos).toContain("workers/ai-response-worker.ts");
  });
});
