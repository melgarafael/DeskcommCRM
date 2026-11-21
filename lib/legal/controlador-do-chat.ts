/**
 * O controlador dos dados que a janela pública do chat mostra ao visitante.
 *
 * A janela é aberta sem sessão: o visitante não é usuário da organização e não
 * tem como passar pela leitura com o cliente de sessão. Por isso quem chama usa o
 * cliente admin, e esta função filtra `id` à mão com o `organizationId` que a
 * rota obteve da conexão (fonte confiável), nunca do corpo da requisição.
 *
 * Não usa `resolverOperador()`: ele lê a sessão do usuário, e o visitante não tem
 * sessão. A URL de política passa pela mesma guarda de saída do documento legal
 * (`urlDePoliticaSegura`), porque a página é pública e o campo é gravado por um
 * admin de organização.
 *
 * Nunca lança: falha de leitura vira os dois `null` e um aviso. A janela do chat
 * continua abrindo, só sem o nome do controlador.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { urlDePoliticaSegura } from "@/lib/legal/operador";

export interface ControladorDoChat {
  razaoSocial: string | null;
  politicaUrl: string | null;
}

const SEM_CONTROLADOR: ControladorDoChat = { razaoSocial: null, politicaUrl: null };

export async function lerControladorDoChat(
  admin: SupabaseClient,
  organizationId: string,
): Promise<ControladorDoChat> {
  try {
    const { data, error } = await admin
      .from("organizations")
      .select("legal_name, privacy_policy_url")
      .eq("id", organizationId)
      .maybeSingle();

    if (error) {
      logger.warn("chat no site: não consegui ler o controlador dos dados", {
        leitor: "controlador-do-chat",
        organizationId,
      });
      return { ...SEM_CONTROLADOR };
    }

    // Organização inexistente: `maybeSingle` devolve null sem erro. Não é falha.
    if (!data) return { ...SEM_CONTROLADOR };

    const linha = data as { legal_name: unknown; privacy_policy_url: unknown };
    return {
      razaoSocial:
        typeof linha.legal_name === "string" ? linha.legal_name.trim() || null : null,
      politicaUrl: urlDePoliticaSegura(linha.privacy_policy_url),
    };
  } catch {
    // Não registra a mensagem da exceção: ela pode trazer detalhe de conexão.
    logger.warn("chat no site: leitura do controlador dos dados falhou", {
      leitor: "controlador-do-chat",
      organizationId,
    });
    return { ...SEM_CONTROLADOR };
  }
}
