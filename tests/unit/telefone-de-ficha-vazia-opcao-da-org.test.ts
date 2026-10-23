/**
 * A OPÇÃO POR ORGANIZAÇÃO DO TELEFONE DE FICHA VAZIA (#2593, item 1 do CR).
 *
 * Três coisas provam que a opção existe DE VERDADE, e cada uma poderia falhar
 * sozinha em silêncio:
 *
 *   1. A RÉGUA de leitura é "só o booleano `true` liga" — e o jsonb ausente tem
 *      de continuar sendo o comportamento de sempre. Se qualquer outro valor
 *      ligasse, toda instalação que ATUALIZASSE passaria a gravar sem decisão
 *      humana, que é exatamente o que a issue pede para não acontecer.
 *   2. A opção tem SUPERFÍCIE: tela (Configurações › Distribuição de
 *      atendimento) e action. Chave sem tela é a feature que não existe
 *      (`docs/doctrine/restricao-de-canal.md`), e a action é o único caminho
 *      de escrita — ela MESCLA o jsonb, porque `settings` é compartilhado com
 *      `cliente_pela_agenda`, `routing` e o que mais estiver lá.
 *   3. A opção fala os QUATRO idiomas: espanhol no dicionário (o único que o
 *      guarda de i18n cobra) e os catálogos `en` / `zh-CN`, que ninguém cobra e
 *      por isso mesmo ficam para trás sem ninguém ver.
 *
 * O comportamento condicionado (ligado grava, desligado propõe) é medido no
 * caminho real, em `lib/contacts/proposta-de-dado.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { traduzir } from "@/lib/i18n/dicionario";
import { ACTIVITY_LABELS } from "@/lib/leads/activity-vocabulary";
import { clientePelaAgendaLigado, telefoneDeFichaVaziaLigado } from "@/lib/schemas/settings";

const RAIZ = join(__dirname, "..", "..");

describe("telefoneDeFichaVaziaLigado", () => {
  it.each([
    ["settings ausente", undefined],
    ["settings nulo", null],
    ["settings vazio", {}],
    ["crm nulo", { crm: null }],
    ["crm array", { crm: [] }],
    ["crm string", { crm: "ligado" }],
    ["chave ausente", { crm: { cliente_pela_agenda: true } }],
    ["false explícito", { crm: { telefone_de_ficha_vazia: false } }],
    ["string 'true'", { crm: { telefone_de_ficha_vazia: "true" } }],
    ["número 1", { crm: { telefone_de_ficha_vazia: 1 } }],
    ["settings array", [{ crm: { telefone_de_ficha_vazia: true } }]],
  ])("%s → DESLIGADO (o padrão de toda instalação)", (_nome, settings) => {
    expect(telefoneDeFichaVaziaLigado(settings)).toBe(false);
  });

  it("só o booleano true liga, e as outras chaves não interferem", () => {
    expect(telefoneDeFichaVaziaLigado({ crm: { telefone_de_ficha_vazia: true } })).toBe(true);
    expect(
      telefoneDeFichaVaziaLigado({
        visibility_mode: "all",
        agenda: { confirmation_delay_minutes: 10 },
        crm: { cliente_pela_agenda: true, telefone_de_ficha_vazia: true },
      }),
    ).toBe(true);
  });

  it("as duas chaves de crm são independentes", () => {
    const s = { crm: { cliente_pela_agenda: true, telefone_de_ficha_vazia: false } };
    expect(clientePelaAgendaLigado(s)).toBe(true);
    expect(telefoneDeFichaVaziaLigado(s)).toBe(false);
  });
});

describe("a opção tem tela e tem caminho de escrita", () => {
  const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");

  it("a tela de Configurações que já existe renderiza o interruptor", () => {
    const pagina = ler("app/app/settings/atendimento/page.tsx");
    // A chave lida pela MESMA função que o servidor aplica: a tela não pode
    // mostrar ligado o que o `proporDadoDoContato` lê como desligado.
    expect(pagina).toContain("telefoneDeFichaVaziaLigado");
    expect(pagina).toContain("<TelefoneDeFichaVazia");
    expect(pagina).toContain("podeAdministrarEmpresa(user, activeOrg)");
  });

  it("a action MESCLA o jsonb em vez de substituí-lo", () => {
    // `settings` é compartilhado: substituir apagaria `cliente_pela_agenda`,
    // `routing`, `visibility_mode`, `art15` e o que mais estivesse gravado.
    const action = ler("app/actions/settings/definirTelefoneDeFichaVazia.ts");
    expect(action).toContain("...settings,");
    expect(action).toContain("...crm,");
    expect(action).toContain('"crm.telefone_de_ficha_vazia_alterado"');
  });

  it("o ramo novo lê a opção antes de gravar", () => {
    const regra = ler("lib/contacts/proposta-de-dado.ts");
    expect(regra).toContain("lerTelefoneDeFichaVazia");
    // O rastro da timeline sai do MESMO ponto que a gravação.
    expect(regra).toContain("registrarTelefoneAplicadoNaTimeline");
  });
});

describe("a opção fala os quatro idiomas", () => {
  const TEXTOS = [
    "Telefone informado pelo cliente entra sozinho na ficha sem número",
    "Quando o cliente diz o telefone numa conversa e a ficha do contato está SEM número, o número é gravado na hora, em formato internacional (E.164), sem esperar alguém confirmar — e aparece na linha do tempo do contato quando ele tem um negócio aberto. Nunca troca o número de quem já tem um: isso continua exigindo uma pessoa, como o e-mail, o nome e a data de nascimento. Vem desligada.",
    "Ligado: o telefone de um cadastro sem número entra sozinho, e fica registrado na linha do tempo quando o contato tem um negócio aberto.",
    "Desligado: todo telefone informado vira proposta, como o resto do dado ouvido na conversa.",
    "Só um administrador da organização pode mudar esta opção.",
    "Opção salva.",
    ACTIVITY_LABELS.contact_field_auto_applied,
  ];

  const catalogos = {
    en: JSON.parse(readFileSync(join(RAIZ, "lib/i18n/traducoes/en.json"), "utf8")) as Record<
      string,
      string
    >,
    "zh-CN": JSON.parse(readFileSync(join(RAIZ, "lib/i18n/traducoes/zh-CN.json"), "utf8")) as Record<
      string,
      string
    >,
  };

  it("o espanhol está no dicionário (é o idioma que o guarda de i18n cobra)", () => {
    for (const texto of TEXTOS) {
      expect(traduzir(texto, "es"), `sem espanhol: ${texto.slice(0, 40)}…`).not.toBe(texto);
    }
  });

  it.each(Object.keys(catalogos))("o catálogo %s tem as mesmas chaves", (codigo) => {
    const catalogo = catalogos[codigo as keyof typeof catalogos];
    for (const texto of TEXTOS) {
      expect(catalogo[texto], `sem ${codigo}: ${texto.slice(0, 40)}…`).toBeTruthy();
    }
  });

  it("o rótulo da timeline sai da mesma fonte que os outros — e diz que foi sozinho", () => {
    // Sem "automaticamente" na frase, quem lê a linha do tempo vai procurar
    // quem digitou o número.
    expect(ACTIVITY_LABELS.contact_field_auto_applied).toContain("automaticamente");
  });
});
