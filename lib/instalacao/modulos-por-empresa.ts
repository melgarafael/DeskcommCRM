/**
 * A LEITURA da camada POR EMPRESA do módulo opcional (#3868) — só servidor.
 *
 * A DECISÃO mora em `lib/instalacao/modulos.ts` (`modulosLigados(db, empresa)`),
 * que é o ponto único que todas as telas e rotas já consultam. Este arquivo é o
 * outro lado: o que a tela `/admin/sistema` → "Por empresa" precisa ler para
 * mostrar três estados (herda / ligado / desligado) sem inventar regra nova.
 *
 * A regra é a MESMA da leitura de runtime, escrita aqui como função pura para
 * poder ser provada sem banco (`resolverModulosDaEmpresa`):
 *
 *   efetivo = instalação ligada E (linha ausente OU linha = `ligado`)
 *
 * ou seja: linha ausente herda; `desligado` tira; e a instalação é TETO — com ela
 * desligada, a linha `ligado` da empresa não liga nada e a tela mostra o porquê
 * (`bloqueadoPelaInstalacao`), em vez de oferecer um interruptor que não faz nada.
 *
 * Nunca lança: erro de leitura vira `null`, e a tela diz que não leu — não afirma
 * estado que não viu.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ehOperante } from "@/lib/organizacao/operante";
import { logger } from "@/lib/logger";

import { MODULOS_POR_EMPRESA, type ModuloOpcional, type ModuloPorEmpresa } from "./modulos";

/** A lista vem de `modulos.ts`: a decisão de QUEM entra na camada por empresa mora
 * junto do gate, não na tela. Reexportada para a tela e a ação não importarem dois. */
export { MODULOS_POR_EMPRESA };
export type { ModuloPorEmpresa };

/** Os três estados da tela. `herda` não é uma linha: é a AUSÊNCIA dela. */
export const ESTADOS_DO_MODULO_NA_EMPRESA = ["herda", "ligado", "desligado"] as const;
export type EstadoDoModuloNaEmpresa = (typeof ESTADOS_DO_MODULO_NA_EMPRESA)[number];

export interface ModuloNaEmpresa {
  readonly modulo: ModuloPorEmpresa;
  /** O que a EMPRESA escolheu (ou `herda`, quando não há linha). */
  readonly estado: EstadoDoModuloNaEmpresa;
  /** O que vale AGORA para ela: instalação ∩ decisão da empresa. */
  readonly efetivo: boolean;
  /** `true` = a instalação tem o módulo desligado e a empresa NÃO pode ligá-lo (teto). */
  readonly bloqueadoPelaInstalacao: boolean;
}

export interface EmpresaDosModulos {
  readonly id: string;
  readonly nome: string;
  readonly ativa: boolean;
}

export interface LinhaDaEmpresa {
  readonly modulo: string;
  readonly estado: string;
}

/**
 * Pura: instalação + linhas da empresa → o que a tela mostra. A ordem é a de
 * `MODULOS_POR_EMPRESA`, para a lista não dançar entre recarregamentos.
 */
export function resolverModulosDaEmpresa(
  ligadosNaInstalacao: readonly ModuloOpcional[],
  linhas: readonly LinhaDaEmpresa[],
): ModuloNaEmpresa[] {
  return MODULOS_POR_EMPRESA.map((modulo) => {
    const naInstalacao = ligadosNaInstalacao.includes(modulo);
    const linha = linhas.find((l) => l.modulo === modulo);
    // Só `ligado` liga — a mesma régua de `modulosLigados`. Linha com valor
    // estranho (só possível por SQL manual, a CHECK recusa) conta como desligada.
    const estado: EstadoDoModuloNaEmpresa =
      linha === undefined ? "herda" : linha.estado === "ligado" ? "ligado" : "desligado";
    return {
      modulo,
      estado,
      efetivo: naInstalacao && estado !== "desligado",
      bloqueadoPelaInstalacao: !naInstalacao,
    };
  });
}

/** As empresas da instalação, para o seletor. `null` = a leitura falhou. */
export async function empresasDosModulos(db: SupabaseClient): Promise<EmpresaDosModulos[] | null> {
  try {
    const { data, error } = await db
      .from("organizations")
      .select("id, display_name, status")
      .order("display_name");
    if (error) {
      logger.warn("módulos por empresa: não deu para listar as empresas", {
        codigo: error.code,
        detalhe: error.message,
      });
      return null;
    }
    return ((data ?? []) as { id: string; display_name: string | null; status: string }[]).map((org) => ({
      id: org.id,
      // Nome da ORGANIZAÇÃO (cadeia própria), não rótulo de contato.
      nome: org.display_name?.trim() || org.id,
      ativa: ehOperante(org.status),
    }));
  } catch (erro) {
    logger.warn("módulos por empresa: listagem falhou", {
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return null;
  }
}

/**
 * O estado dos módulos de UMA empresa. `null` = a empresa não existe (ou a leitura
 * falhou) — e a tela não mostra interruptor sobre empresa que ninguém confirmou.
 */
export async function lerModulosDaEmpresa(
  db: SupabaseClient,
  organizationId: string,
  ligadosNaInstalacao: readonly ModuloOpcional[],
): Promise<ModuloNaEmpresa[] | null> {
  try {
    const [org, linhas] = await Promise.all([
      db.from("organizations").select("id").eq("id", organizationId).maybeSingle(),
      db.from("organization_modules").select("modulo, estado").eq("organization_id", organizationId),
    ]);
    if (org.error || !org.data) {
      if (org.error) {
        logger.warn("módulos por empresa: a empresa não foi lida", {
          organization_id: organizationId,
          codigo: org.error.code,
          detalhe: org.error.message,
        });
      }
      return null;
    }
    if (linhas.error) {
      logger.warn("módulos por empresa: não deu para ler as linhas da empresa", {
        organization_id: organizationId,
        codigo: linhas.error.code,
        detalhe: linhas.error.message,
      });
      return null;
    }
    return resolverModulosDaEmpresa(ligadosNaInstalacao, (linhas.data ?? []) as LinhaDaEmpresa[]);
  } catch (erro) {
    logger.warn("módulos por empresa: leitura falhou", {
      organization_id: organizationId,
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return null;
  }
}

/**
 * A empresa existe? Usado pela escrita ANTES de gravar: FK recusaria a linha, mas o
 * erro do Postgres viraria 500 na tela; a recusa nomeada volta como mensagem.
 */
export async function empresaExiste(db: SupabaseClient, organizationId: string): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("organizations")
      .select("id")
      .eq("id", organizationId)
      .maybeSingle();
    return !error && Boolean(data);
  } catch {
    return false;
  }
}
