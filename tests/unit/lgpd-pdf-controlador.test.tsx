/**
 * O RELATÓRIO DE LGPD NOMEIA O CONTROLADOR — e nunca a marca.
 *
 * Este é o gate da decisão de produto escrita em `lib/lgpd/pdf-renderer.tsx`:
 * o documento do Art. 18 II responde a um direito legal do titular, e nomear
 * ali o revendedor — que é OPERADOR, não controlador — inverteria os papéis num
 * documento jurídico. "Completar o white-label" aqui PIORA o defeito, e é
 * exatamente o conserto que a próxima pessoa vai querer fazer.
 *
 * A asserção olha a ÁRVORE do componente, não o PDF renderizado, e isso é
 * deliberado: `renderToBuffer` devolve bytes válidos mesmo quando o @react-pdf
 * descarta silenciosamente o que não entende (medido no plano da fase: 1514
 * bytes com `var(--x)` contra 1538 com hex, sem erro). Uma prova do tipo "gerei
 * o PDF e ele abriu" passaria com o texto errado dentro.
 */
import { describe, expect, it } from "vitest";
import type { ReactElement, ReactNode } from "react";

import type { ExportPayload } from "@/lib/lgpd/export-collector";
import { LgpdExportPdf } from "@/lib/lgpd/pdf-renderer";

/** Todo texto da árvore, achatado — inclusive o que está dentro de `fixed`. */
function textos(no: ReactNode): string[] {
  if (no === null || no === undefined || typeof no === "boolean") return [];
  if (typeof no === "string") return [no];
  if (typeof no === "number") return [String(no)];
  if (Array.isArray(no)) return no.flatMap(textos);
  const elemento = no as ReactElement<{ children?: ReactNode }>;
  if (elemento.props && "children" in elemento.props) return textos(elemento.props.children);
  return [];
}

/**
 * Só o RODAPÉ. Olhar o documento inteiro não serve para este gate: a razão
 * social também aparece na seção de metadados, então um rodapé sabotado para
 * imprimir a marca continuaria "contendo" o nome certo em algum lugar da
 * página — e o teste passaria pelo motivo errado.
 */
function rodape(elemento: ReactElement): string {
  // Espaços colapsados: cada interpolação do JSX vira um filho de texto próprio,
  // então o `join` produz espaço duplo em volta de todo `{...}`. Prender o teste
  // a essa espaçagem seria prender o gate a um detalhe do parser.
  const tudo = textos(elemento).join(" ").replace(/\s+/g, " ");
  const inicio = tudo.indexOf("Controlador:");
  expect(inicio, "o rodapé sumiu — o gate não tem o que medir").toBeGreaterThanOrEqual(0);
  return tudo.slice(inicio);
}

function payload(patch: Partial<ExportPayload> = {}): ExportPayload {
  return {
    request_id: "3f2a9c10-0000-4000-8000-000000000001",
    organization_id: "8c1d4e20-0000-4000-8000-000000000002",
    organization_legal_name: "Bem Viver Serviços Médicos LTDA",
    organization_display_name: "Clínica Bem Viver",
    dpo_email: "encarregado@bemviver.com.br",
    generated_at: "2026-08-13T12:00:00.000Z",
    no_local_footprint: true,
    contact: null,
    consents: [],
    conversations: [],
    messages_count_total: 0,
    messages_recent: [],
    leads: [],
    orders: [],
    activities: [],
    appointments: [],
    tasks: [],
    webhook_captures: [],
    audit_log_extract: [],
    ...patch,
  };
}

describe("rodapé do relatório LGPD", () => {
  it("imprime a RAZÃO SOCIAL do controlador, no rodapé", () => {
    expect(rodape(LgpdExportPdf({ data: payload() }))).toContain(
      "Bem Viver Serviços Médicos LTDA",
    );
  });

  it("NÃO imprime marca nenhuma — nem a do produto, nem a do revendedor", () => {
    // Esta é a asserção que reprova a "melhoria" de trocar a razão social por
    // uma marca QUALQUER: o rodapé só pode conter o que veio de `legal_name`.
    // Checar apenas `/deskcomm/i` pegaria a nossa marca e deixaria passar a do
    // revendedor — que é justamente o conserto que alguém vai propor.
    const texto = rodape(
      LgpdExportPdf({
        data: payload({
          organization_legal_name: "Bem Viver Serviços Médicos LTDA",
          organization_display_name: "Clínica Bem Viver",
        }),
      }),
    );
    const nomeDoControlador = texto
      .slice("Controlador:".length, texto.indexOf("· Relatório LGPD"))
      .trim();

    expect(nomeDoControlador).toBe("Bem Viver Serviços Médicos LTDA");
    expect(texto).not.toMatch(/deskcomm/i);
    // O nome fantasia também não entra: quem responde pelos dados é a pessoa
    // jurídica, e é a razão social que a identifica.
    expect(nomeDoControlador).not.toContain("Clínica Bem Viver");
  });

  it("nomeia o Encarregado da organização", () => {
    const tudo = rodape(LgpdExportPdf({ data: payload() }));

    expect(tudo).toContain("Encarregado (DPO):");
    expect(tudo).toContain("encarregado@bemviver.com.br");
    // O texto anterior era "DPO: contato via canal oficial do controlador" — um
    // não-resposta num campo cuja função é dizer a quem o titular reclama.
    expect(tudo).not.toContain("contato via canal oficial");
  });

  it("sem DPO na organização e sem o do ambiente, DIZ que não foi informado", () => {
    const tudo = rodape(LgpdExportPdf({ data: payload({ dpo_email: null }) }));

    // `env.LGPD_DPO_EMAIL` está vazia na suíte, então este caso exercita a ponta
    // da cadeia. Um campo em branco pareceria defeito de renderização; a frase
    // diz de quem é a pendência.
    expect(tudo).toContain("não informado pelo controlador");
  });

  it("a organização aparece pelo NOME, e o uuid vira 'ID interno'", () => {
    const tudo = textos(LgpdExportPdf({ data: payload() })).join(" ");

    expect(tudo).toContain("ID interno:");
    // O uuid continua no documento (o suporte pede por ele), mas deixou de ser
    // a resposta à pergunta "de quem são estes dados?".
    expect(tudo).toContain("8c1d4e20-0000-4000-8000-000000000002");
    expect(tudo).toContain("Bem Viver Serviços Médicos LTDA");
  });

  it("controlador ilegível não vira nome inventado — sai o traço de campo ausente", () => {
    // `lerControlador` devolve string vazia quando a leitura falha. Preencher
    // com o nome do produto seria escrever a entidade errada num documento
    // jurídico; abortar o export estouraria o SLA legal de D+7.
    const tudo = rodape(LgpdExportPdf({ data: payload({ organization_legal_name: "" }) }));

    expect(tudo).toContain("Controlador: —");
    expect(tudo).not.toMatch(/deskcomm/i);
  });
});
