/**
 * As duas portas que sobraram depois do primeiro gate — e o que elas NÃO podem barrar.
 *
 * Achadas medindo turnos reais (W4), depois de o gate já estar de pé:
 *
 *   1. **Identificador opaco.** Um UUID de usuário chegou à tela do cliente.
 *      Detector de PALAVRA não pega isto, porque não há palavra — é FORMA. Foi o
 *      próprio autor do gate quem nomeou: *"a saída provavelmente não é mais
 *      lista, é regra de forma"*. Lista sempre fica atrás do que ainda não
 *      existe; forma cobre o que ninguém escreveu ainda.
 *
 *   2. **Código de erro opaco.** O termo veio do DADO que a tool devolveu, não
 *      do nome dela. Medido: os códigos canônicos com underscore
 *      (`lead_not_found`, `resume_requires_person`) JÁ caíam na regra de
 *      snake_case — só escapavam o SQLSTATE do Postgres e o código do PostgREST.
 *
 * O RISCO REAL DESTE GATE NÃO É DEIXAR PASSAR, É BARRAR DEMAIS — mas a razão não é
 * a que a primeira versão deste comentário deu. Ela dizia que no follow-up o veto é
 * "drop silencioso, mata a mensagem sem sintoma". **Medido, com controle positivo:**
 *
 *   - o gate é DESARMADO por default (`args.enforceInternalVocabulary ?? false`) e
 *     `followup-turn.ts` não o arma (0 ocorrências; `inbound-turn.ts` tem 2). Ele NÃO
 *     roda no caminho determinístico hoje — o risco lá é condicional a alguém armá-lo,
 *     e é isso que `gate-vazamento-interno.test.ts` congela;
 *   - qualquer veto da cadeia persiste trace E emite `send_vetoed` na timeline do
 *     contato (`emitVetoActivity`), porque "silêncio sem registro é abandono". Quem
 *     for investigar ACHA. "Silencioso" ali significa sem reescrita, não sem log.
 *
 * O custo real de barrar demais é outro, e é pior: no inbound o veto vira erro
 * instrutivo, e o fail-safe conta vetos e — ao persistir — LIBERA o envio desarmando
 * este gate. Ou seja, falso positivo teimoso não segura mensagem: ele DESLIGA o
 * guarda. Um gate mal calibrado não falha barrando; falha virando decoração.
 *
 * Por isso metade deste arquivo é
 * falso positivo — número de pedido, CNPJ, CPF, data e horário são o vocabulário
 * legítimo do cliente, e barrá-los é pior que o vazamento que o gate evita.
 */
import { describe, expect, it } from "vitest";

import { detectarVazamentoInterno } from "@/lib/agent-engine/guardrails/vazamento-interno";

describe("porta 1 — identificador opaco é forma, não palavra", () => {
  it.each([
    ["uuid minúsculo", "Seu atendimento é 3f2a1b6c-9d4e-4a7b-8c1d-2e5f6a7b8c9d."],
    ["uuid maiúsculo", "Registrado sob 550E8400-E29B-41D4-A716-446655440000."],
    ["uuid no meio da frase", "Anotei em 6ba7b810-9dad-11d1-80b4-00c04fd430c8, tudo certo."],
  ])("barra: %s", (_n, texto) => {
    expect(detectarVazamentoInterno(texto).achou).toBe(true);
  });
});

describe("porta 2 — código de erro opaco", () => {
  it.each([
    ["SQLSTATE com vizinhança de erro", "Falhou com o erro 23505 ao gravar."],
    ["SQLSTATE depois do código", "23505 é o erro que apareceu."],
    ["código PostgREST", "Retornou PGRST116, tente de novo."],
  ])("barra: %s", (_n, texto) => {
    expect(detectarVazamentoInterno(texto).achou).toBe(true);
  });

  it("código canônico com underscore já era barrado antes (não é regressão nova)", () => {
    // Registrado para a próxima pessoa não achar que estas portas o cobrem: quem
    // pega é a regra de snake_case, e foi medido antes de escrever a regra nova.
    expect(detectarVazamentoInterno("Não consegui: resume_requires_person.").categorias).toContain(
      "snake_case",
    );
  });
});

describe("o que o gate NÃO pode barrar — o vocabulário do cliente", () => {
  it.each([
    ["número de pedido com 5 dígitos", "Seu pedido 2026-00815 saiu para entrega."],
    ["CNPJ", "Confirmei o CNPJ 12.345.678/0001-90."],
    ["CPF", "O CPF 123.456.789-09 está no cadastro."],
    ["data e horário", "Combinado para 12/03/2026 às 14:30:00."],
    ["valor e prazo", "Aprovei 15% para as 200 caixas, entrega em 5 dias úteis."],
    ["telefone", "Ligo no 11 98765-4321 amanhã."],
    ["código de rastreio", "Rastreio BR123456789BR, chega quarta."],
    ["link do portal com uuid", "Seu portal do cliente está disponível: https://portal.ararquitetura.com/projeto/afc35b68-fe81-4861-a4d4-f1603cb47a4f"],
  ])("deixa passar: %s", (_n, texto) => {
    const r = detectarVazamentoInterno(texto);
    expect(r.achou, `barrado por ${r.categorias.join(",")}: ${r.termos.join(", ")}`).toBe(false);
  });

  it("cinco dígitos SOZINHOS não são erro (o discriminador é a vizinhança)", () => {
    // Sem esta guarda, a regra do SQLSTATE mataria "sua nota fiscal 23505" — e no
    // follow-up determinístico o veto é drop silencioso, então o cliente
    // simplesmente não receberia a mensagem.
    expect(detectarVazamentoInterno("Sua nota fiscal 23505 foi emitida.").achou).toBe(false);
  });
});
