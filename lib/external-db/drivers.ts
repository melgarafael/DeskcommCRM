/**
 * REGISTRO DE DRIVERS: o único lugar que sabe qual motor fala com qual banco.
 *
 * Quem abre, testa ou fecha uma conexão de banco externo passa por aqui e nunca
 * importa o driver de um motor (`pg`, e amanhã `mysql2`) diretamente. A conexão
 * traz o seu motor (`dbType`); o registro escolhe o driver. Trocar ou acrescentar
 * um motor é acrescentar UMA entrada em `DRIVERS` — nenhum chamador muda.
 *
 * Só o PostgreSQL está instalado. Pedir um motor sem driver falha ALTO
 * (`DriverIndisponivelError`): cair no PostgreSQL por engano leria o banco errado
 * com o protocolo errado e esconderia o defeito.
 */
import { fecharPool as fecharPoolPostgres, fecharTodosOsPools as fecharTodosPostgres, obterPool, testarConexao as testarPostgres } from "./conexao";
import type { ResultadoDeTeste } from "./conexao";
import { criarDialetoPostgres, type Dialeto } from "./dialeto";
import type { ConexaoExterna, TipoBanco } from "./types";

export type { ResultadoDeTeste };

export interface DriverDeBanco {
  /** O dialeto de leitura da conexão, já com a regra de fontes liberadas aplicada. */
  abrirDialeto(conexao: ConexaoExterna): Dialeto;
  /** Testa a conexão com um cliente descartável (não polui o cache de pools). */
  testar(conexao: ConexaoExterna): Promise<ResultadoDeTeste>;
  /** Derruba o pool da conexão, se houver (editar credencial, desativar, apagar). */
  fecharPool(connectionId: string): Promise<void>;
  /** Encerra todos os pools do motor (testes e desligamento do processo). */
  fecharTodosOsPools(): Promise<void>;
}

export class DriverIndisponivelError extends Error {
  constructor(tipo: TipoBanco) {
    super(`driver do motor "${tipo}" não está instalado`);
    this.name = "DriverIndisponivelError";
  }
}

const postgres: DriverDeBanco = {
  abrirDialeto: (conexao) =>
    criarDialetoPostgres(obterPool(conexao), { modo: conexao.sourceMode, fontes: conexao.fontes }),
  testar: (conexao) => testarPostgres(conexao),
  fecharPool: (connectionId) => fecharPoolPostgres(connectionId),
  fecharTodosOsPools: () => fecharTodosPostgres(),
};

/** Os drivers instalados. O MySQL entra aqui na Fatia 4a. */
const DRIVERS: Partial<Record<TipoBanco, DriverDeBanco>> = { postgres };

function instalados(): DriverDeBanco[] {
  return Object.values(DRIVERS).filter((d): d is DriverDeBanco => d !== undefined);
}

export function driverDe(tipo: TipoBanco): DriverDeBanco {
  const driver = DRIVERS[tipo];
  if (!driver) throw new DriverIndisponivelError(tipo);
  return driver;
}

export function abrirDialeto(conexao: ConexaoExterna): Dialeto {
  return driverDe(conexao.dbType).abrirDialeto(conexao);
}

export function testarConexao(conexao: ConexaoExterna): Promise<ResultadoDeTeste> {
  return driverDe(conexao.dbType).testar(conexao);
}

/** Fecha o pool dessa conexão em TODOS os drivers: quem chama só tem o id, não sabe o motor. */
export async function fecharPool(connectionId: string): Promise<void> {
  await Promise.all(instalados().map((d) => d.fecharPool(connectionId)));
}

export async function fecharTodosOsPools(): Promise<void> {
  await Promise.all(instalados().map((d) => d.fecharTodosOsPools()));
}
