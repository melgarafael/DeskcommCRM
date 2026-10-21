/**
 * A PROVA EM TELA do cartão da passagem com dados coletados — português,
 * espanhol e inglês. O mantenedor pediu a prova de tela em pt/en/es na revisão
 * do PR #3052 (parte 2), e este arquivo é ela: o MESMO componente da tela
 * (`PassagemCard`), o MESMO view-model puro (`montarCartoesDaPassagem`) e o
 * MESMO provider de idioma — sem mensagem real, sem servidor, sem produção.
 *
 * O que cada idioma prova, e o que ele NÃO prova:
 *
 *   - pt-BR: o produto sem tradução — frase do motivo, rótulos e o convite.
 *   - es: a frase do motivo traduzida no RENDER (`t()` → dicionário), como
 *     qualquer outro cartão. O bloco de campos coletados é DADO gravado
 *     (briefing em português, lido sob `fn_can_view_conversation`) e aparece
 *     como foi gravado — traduzir dado seria mentir sobre o que foi coletado.
 *   - en: o catálogo `lib/i18n/traducoes/en.json` JÁ traz a frase, mas o
 *     idioma está registrado como `em_construcao` e o leitor do catálogo
 *     (fatia 4 do PROG-022) ainda não existe. Na tela o `t()` degrada para
 *     português — a regra do próprio dicionário ("falta de tradução degrada
 *     para português, nunca para a chave crua"). O teste prova as DUAS
 *     coisas sem inventar o que não existe: a degradação na tela E a entrada
 *     de inglês presente no catálogo que o leitor futuro vai ler.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { PassagemCard } from "@/components/inbox/PassagemCard";
import { montarBriefingDaPassagem } from "@/lib/escalacao/briefing-da-passagem";
import { montarCartoesDaPassagem } from "@/lib/escalacao/cartao-da-passagem";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

const FRASE_EM_PT =
  "Um fluxo automático coletou dados e passou a conversa para verificação humana";
const FRASE_EM_ES =
  "Un flujo automático recopiló datos y pasó la conversación a verificación humana";
const FRASE_EM_EN =
  "An automated flow collected data and handed the conversation over for human review";

/** A linha EXATAMENTE como a rota da conversa a devolve. */
function cartaoDaVerificacao() {
  const briefing = montarBriefingDaPassagem({
    checkpoint: null,
    camposColetados: { nome: "Ravi Kumar", data_exame: "12/03/2024" },
    motivo: { codigo: "verificacao_manual" },
  });
  const cartoes = montarCartoesDaPassagem(
    [
      {
        id: "p1",
        origem: "runtime_nativo",
        motivo_codigo: "verificacao_manual",
        title: briefing.title,
        body: briefing.body,
        notes: briefing.notes,
        content: briefing.content,
        tentativas: briefing.tentativas,
        cliente_avisado: null,
        aviso_motivo_codigo: null,
        caso_id: null,
        criado_em: "2026-10-18T12:00:00.000Z",
        reconhecido_em: null,
        reconhecido_por: null,
      },
    ],
    { usuarioId: "u1", donoId: null, donoNome: null },
  );
  return cartoes[0]!;
}

function emTela(locale: string) {
  render(
    <IdiomaProvider locale={locale}>
      <PassagemCard
        cartao={cartaoDaVerificacao()}
        contatoId="cont1"
        onAssumir={() => {}}
        assumindo={false}
      />
    </IdiomaProvider>,
  );
}

describe("o cartão da passagem com dados coletados, em tela (pt/en/es)", () => {
  it("pt-BR: motivo, título, bloco de campos coletados e o convite de assumir", () => {
    emTela("pt-BR");
    expect(screen.getByText(FRASE_EM_PT)).toBeInTheDocument();
    expect(screen.getByText("Por que a IA passou para você")).toBeInTheDocument();
    expect(screen.getByText("Resumo da IA (confira)")).toBeInTheDocument();
    // O bloco é dado gravado — com os campos REAIS da coleta, como gravados.
    expect(screen.getByText(/Dados coletados automaticamente/)).toBeInTheDocument();
    expect(screen.getByText(/nome: Ravi Kumar/)).toBeInTheDocument();
    expect(screen.getByText(/data_exame: 12\/03\/2024/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assumir e responder" })).toBeInTheDocument();
  });

  it("es: frase do motivo e rótulos em espanhol; o bloco de dados segue sendo dado", () => {
    emTela("es");
    expect(screen.getByText(FRASE_EM_ES)).toBeInTheDocument();
    expect(screen.getByText("Por qué la IA te pasó la conversación")).toBeInTheDocument();
    expect(screen.getByText("Resumen de la IA (revísalo)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Asumir y responder" })).toBeInTheDocument();
    // O briefing continua sendo dado gravado em português, lido sob
    // permissão de conversa; a tela não traduz dado — traduzir seria mentir
    // sobre o que foi coletado.
    expect(screen.getByText(/Dados coletados automaticamente/)).toBeInTheDocument();
  });

  it("en: a tela degrada para português (idioma em construção) e o catálogo já tem a frase", () => {
    emTela("en");
    // O runtime não lê `en.json` ainda (leitor do catálogo = fatia 4 do
    // PROG-022; registro em 'em_construcao'): `t()` devolve o PORTUGUÊS, não
    // a chave crua. É a regra de degradação do dicionário, provada na tela.
    expect(screen.getByText(FRASE_EM_PT)).toBeInTheDocument();
    expect(screen.queryByText(FRASE_EM_EN)).not.toBeInTheDocument();

    // E o texto em inglês já está no catálogo que o leitor futuro vai ler:
    // falta o leitor, não a tradução.
    const en = JSON.parse(
      readFileSync(join(__dirname, "../../lib/i18n/traducoes/en.json"), "utf-8"),
    ) as Record<string, string>;
    expect(en[FRASE_EM_PT]).toBe(FRASE_EM_EN);
  });
});
