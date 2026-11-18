"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { chaveDosContatosRelacionados } from "@/hooks/leads/useContatosRelacionados";

/**
 * O ESCRITOR do vínculo `crm_lead_links` com `target_kind='contact'` (#3083,
 * fatia 1) — o que faltava para a lista "Pessoas relacionadas" deixar de ser só
 * leitura.
 *
 * `POST` e `DELETE` moram na MESMA rota do leitor, e o motivo é a invalidação:
 * a escrita tem que derrubar a MESMA entrada de cache que o dossiê já está
 * lendo. Uma rota nova (`/participantes`) obrigaria a tela a manter duas
 * fontes da mesma lista.
 *
 * O papel é texto livre (teto de 40, no servidor): mandar `null` LIMPA o papel
 * sem tirar a pessoa — é o mesmo POST, e o servidor faz upsert no índice único.
 */
export function useAdicionarParticipante(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (entrada: { contact_id: string; papel?: string | null }) =>
      apiClient.post<unknown>(`/api/v1/leads/${leadId}/contatos-relacionados`, entrada),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: chaveDosContatosRelacionados(leadId) });
    },
    onError: (err) => showApiError(err),
  });
}

/** O que a tela manda para ligar uma pessoa pelo número. */
export interface EntradaPeloTelefone {
  telefone: string;
  nome?: string | null;
  papel?: string | null;
}

/** Quem foi ligado, e se o contato já existia (a mensagem da tela muda). */
export interface ResultadoPeloTelefone {
  contact_id: string;
  jaExistia: boolean;
}

/**
 * LIGAR AO NEGÓCIO PELO TELEFONE (#3669, fatia 1) — duas rotas que já existem,
 * em ordem, e nenhuma regra nova.
 *
 *  1. `POST /api/v1/contacts` com o número: é a régua do cadastro que decide o
 *     formato (o telefone nacional da #3301 e o nono dígito do
 *     `canonicalPhoneBR`) e a duplicidade. Número de contato que já existe volta
 *     409 `contact_exists` com o `contact_id` RELIDO pelo servidor (#3084) — é
 *     esse o "acha". Reimplementar a busca aqui seria uma segunda régua de
 *     telefone para divergir da primeira.
 *  2. `POST …/contatos-relacionados`: o mesmo vínculo do "Adicionar
 *     participante", com o papel como rótulo ("Comprador", "Loja").
 *
 * Os dois degraus de papel são os das rotas (`agent`); a tela não decide nada.
 * Se o passo 2 falhar, o contato do passo 1 fica no cadastro — repetir o gesto
 * o acha pelo 409, então não há duplicata.
 *
 * Exportada fora do hook para o teste chamar com um `api` falso, sem rede.
 */
export async function ligarPeloTelefone(
  leadId: string,
  entrada: EntradaPeloTelefone,
  api: Pick<typeof apiClient, "post"> = apiClient,
): Promise<ResultadoPeloTelefone> {
  let contactId: string;
  let jaExistia = false;
  try {
    const criado = await api.post<{ data: { contact: { id: string } } }>("/api/v1/contacts", {
      phone_number: entrada.telefone,
      ...(entrada.nome ? { name: entrada.nome } : {}),
    });
    contactId = criado.data.contact.id;
  } catch (err) {
    const existente =
      err instanceof ApiError && err.status === 409 && err.code === "contact_exists"
        ? err.details?.contact_id
        : undefined;
    if (typeof existente !== "string") throw err;
    contactId = existente;
    jaExistia = true;
  }
  await api.post<unknown>(`/api/v1/leads/${leadId}/contatos-relacionados`, {
    contact_id: contactId,
    papel: entrada.papel ?? null,
  });
  return { contact_id: contactId, jaExistia };
}

export function useAdicionarPeloTelefone(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entrada: EntradaPeloTelefone) => ligarPeloTelefone(leadId, entrada),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: chaveDosContatosRelacionados(leadId) });
    },
    onError: (err) => showApiError(err),
  });
}

/** O alvo do DELETE viaja na query: DELETE com corpo não é portátil. */
export function useRemoverParticipante(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contactId: string) =>
      apiClient.delete<unknown>(
        `/api/v1/leads/${leadId}/contatos-relacionados?contact_id=${encodeURIComponent(contactId)}`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: chaveDosContatosRelacionados(leadId) });
    },
    onError: (err) => showApiError(err),
  });
}
