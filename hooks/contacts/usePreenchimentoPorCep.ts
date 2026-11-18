"use client";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { normalizarCep, type CepConsultado } from "@/lib/contacts/endereco-por-cep";

/**
 * O que a consulta de CEP está fazendo AGORA (#3494).
 *
 * `invalido` é o único estado que a tela mostra sem ter chamado o servidor: CEP
 * com menos de 8 dígitos ou com letra não vira requisição. E ele NÃO bloqueia o
 * cadastro — a mensagem é um aviso de preenchimento, do lado do campo.
 */
export type EstadoDaConsultaDeCep =
  "parado" | "buscando" | "preenchido" | "invalido" | "nao_encontrado" | "falhou";

/**
 * Consulta o CEP sob demanda, uma vez por saída do campo.
 *
 * Sem react-query DE PROPÓSITO: o resultado não é cache de tela (o CEP é digitado
 * uma vez e o endereço vai para o formulário), e a ficha e o cadastro montam este
 * campo fora de qualquer `QueryClientProvider` — um `useMutation` aqui obrigaria
 * os dois diálogos a ganhar provider só por causa de um lookup.
 *
 * Devolve `null` em qualquer desfecho que não seja uma resposta útil, e o estado
 * para a tela dizer o motivo. Nunca lança: falha de CEP não pode derrubar o
 * formulário que está sendo preenchido.
 *
 * Só a consulta vigente responde. A resposta leva até 8s, e nesse tempo a pessoa
 * pode ter trocado o CEP ou fechado o diálogo — o cadastro segue montado entre
 * aberturas, e o endereço do contato abandonado cairia no próximo.
 */
export function usePreenchimentoPorCep(): {
  estado: EstadoDaConsultaDeCep;
  buscar: (cepBruto: string) => Promise<CepConsultado | null>;
  cancelar: () => void;
} {
  const [estado, setEstado] = useState<EstadoDaConsultaDeCep>("parado");
  const consultaVigente = useRef(0);

  useEffect(
    () => () => {
      consultaVigente.current += 1;
    },
    [],
  );

  const cancelar = useCallback(() => {
    consultaVigente.current += 1;
    setEstado("parado");
  }, []);

  const buscar = useCallback(async (cepBruto: string): Promise<CepConsultado | null> => {
    consultaVigente.current += 1;
    const estaConsulta = consultaVigente.current;
    const cep = normalizarCep(cepBruto);
    if (!cep) {
      setEstado("invalido");
      return null;
    }

    setEstado("buscando");
    try {
      const resposta = await apiClient.get<{ data: CepConsultado }>(
        `/api/v1/contacts/cep?cep=${cep}`,
      );
      if (estaConsulta !== consultaVigente.current) return null;
      setEstado("preenchido");
      return resposta.data;
    } catch (err) {
      if (estaConsulta !== consultaVigente.current) return null;
      if (err instanceof ApiError) {
        if (err.code === "cep_nao_encontrado") {
          setEstado("nao_encontrado");
          return null;
        }
        if (err.status === 422) {
          setEstado("invalido");
          return null;
        }
      }
      setEstado("falhou");
      return null;
    }
  }, []);

  return { estado, buscar, cancelar };
}
