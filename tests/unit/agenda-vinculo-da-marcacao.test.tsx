/**
 * QUEM SERÁ ATENDIDO — o painel não herda o cliente da vez anterior, E NÃO
 * PERDE o que veio da conversa.
 *
 * ─── Por que este arquivo existe no lugar de uma cerca de texto ──────────
 *
 * A primeira tentativa de conserto (PR #799) limpava o cliente no fechamento
 * do painel e vinha com uma cerca que lia o CÓDIGO-FONTE do `_client.tsx`
 * atrás de `setContactId("")`. A cerca ficou verde e o produto quebrou: o
 * `e2e` reprovou em `agenda-google-meet.spec.ts:196` e
 * `agenda-presenca-recuperacao.spec.ts:312`, as duas com `contact_id: null`,
 * porque limpar no fechamento apaga também o contexto que a CONVERSA acabou
 * de dar — as duas specs fecham o painel só para navegar a grade, que é o que
 * uma pessoa faz.
 *
 * Uma cerca que exige a presença de uma linha cimenta a implementação e não
 * vigia nada: ela não sabe distinguir o cliente que sobrou do cliente que o
 * Inbox mandou. Por isso aqui não se lê texto — exerce-se o COMPORTAMENTO,
 * nos dois sentidos, na mesma peça que o `_client.tsx` usa.
 *
 * ─── A regra, em uma frase ──────────────────────────────────────────────
 *
 * O painel abre com o vínculo que a ROTA carrega; o que a pessoa escolhe
 * dentro dele vive só enquanto ele está aberto.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SEM_VINCULO, useVinculoDaMarcacao } from "@/lib/agenda/vinculo-da-marcacao";

const CLIENTE = { contact: "c-da-conversa", conversation: "conv-1" };
const OUTRO = { contact: "c-escolhido-a-mao", conversation: "" };

describe("o painel de marcação e o cliente que ele mostra", () => {
  it("CONTROLE: sem rota e sem escolha, nasce vazio — é o estado neutro", () => {
    const { result } = renderHook(() => useVinculoDaMarcacao());
    expect(result.current.vinculo).toEqual(SEM_VINCULO);
  });

  it("⛔ (a) SEM contexto na rota, abrir não traz o cliente da vez anterior", () => {
    const { result } = renderHook(() => useVinculoDaMarcacao());
    // A pessoa escolheu um cliente à mão numa abertura...
    act(() => result.current.escolher(OUTRO));
    expect(result.current.vinculo).toEqual(OUTRO);
    // ...fechou sem confirmar, e abriu de novo pelo "Novo agendamento".
    act(() => result.current.reiniciar());
    expect(result.current.vinculo).toEqual(SEM_VINCULO);
  });

  it("⛔ (b) VINDO DO INBOX, o cliente sobrevive a fechar o painel e reabrir", () => {
    // É o gesto que `agenda-google-meet.spec.ts` e
    // `agenda-presenca-recuperacao.spec.ts` fazem pela tela: abre pela
    // conversa, fecha para navegar a grade até a semana certa, reabre em
    // "Novo agendamento" e confirma. Se isto quebrar, o compromisso nasce sem
    // dono — `contact_id: null`.
    const { result } = renderHook(() => useVinculoDaMarcacao());
    let abriuSozinho = false;
    act(() => {
      abriuSozinho = result.current.registrarRota(CLIENTE);
    });
    expect(abriuSozinho).toBe(true);
    expect(result.current.vinculo).toEqual(CLIENTE);

    act(() => result.current.reiniciar()); // fechou
    expect(result.current.vinculo).toEqual(CLIENTE);
    act(() => result.current.reiniciar()); // reabriu
    expect(result.current.vinculo).toEqual(CLIENTE);
  });

  it("⛔ (c) o DEFEITO RELATADO: ir para a Agenda pelo menu apaga o cliente da conversa", () => {
    // A rota é a mesma (`/app/agenda`), só a query muda — o componente não
    // remonta e o estado sobrevivia. É exatamente aqui que o "Novo
    // agendamento" vinha com o cliente de outra pessoa já selecionado.
    const { result } = renderHook(() => useVinculoDaMarcacao());
    act(() => {
      result.current.registrarRota(CLIENTE);
    });
    let abriuSozinho = true;
    act(() => {
      abriuSozinho = result.current.registrarRota(SEM_VINCULO);
    });
    // A rota sem cliente NÃO é pedido para marcar: o painel não abre sozinho.
    expect(abriuSozinho).toBe(false);
    act(() => result.current.reiniciar());
    expect(result.current.vinculo).toEqual(SEM_VINCULO);
  });

  it("a rota perder o contexto não apaga o que está sendo preenchido", () => {
    // Com o painel ABERTO, `registrarRota` sem cliente só registra: apagar o
    // campo embaixo da mão de quem digita seria trocar um defeito por outro.
    const { result } = renderHook(() => useVinculoDaMarcacao());
    act(() => result.current.escolher(OUTRO));
    act(() => {
      result.current.registrarRota(SEM_VINCULO);
    });
    expect(result.current.vinculo).toEqual(OUTRO);
  });

  it("o que a rota traz VENCE o que sobrou — chegar pelo Inbox troca o cliente", () => {
    const { result } = renderHook(() => useVinculoDaMarcacao());
    act(() => result.current.escolher(OUTRO));
    act(() => {
      result.current.registrarRota(CLIENTE);
    });
    expect(result.current.vinculo).toEqual(CLIENTE);
  });
});
