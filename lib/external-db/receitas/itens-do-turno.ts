/**
 * OS ITENS QUE `crm_consultar_receita` DEVOLVEU NESTE TURNO (Spec 25, R5 / D6).
 *
 * Irmão de `ImagensDaReceitaNoTurno` (R4): a ferramenta que registra interesse
 * só aceita um item que o modelo acabou de VER numa consulta desta conversa. Sem
 * isso o modelo poderia mandar abrir lead para um id qualquer ("o imóvel 1").
 * Também guarda título e preço COMO A CONSULTA OS DEVOLVEU: a nota do lead usa o
 * snapshot, nunca o que o modelo digita.
 *
 * Vive só na memória de UM turno (uma instância por turno, criada em
 * `inbound-turn.ts`). Quem não passa um registro (follow-up, operador, MCP
 * externo, ensaio) não tem item nenhum: a ferramenta recusa.
 *
 * Carrega também o TETO de interesses por turno: o teto de envios
 * (`DEFAULT_MAX_SENDS_PER_TURN`) não conta aqui porque a ferramenta não envia, e
 * o teto de passos (`AGENT_MAX_STEPS`) conta qualquer ferramenta e é largo demais
 * para esta. Três é o mesmo número do teto de envios: um item por mensagem.
 */
import type { FamiliaReceita } from "./tipos";

export const TETO_DE_INTERESSES_POR_TURNO = 3;

export interface ItemDoTurno {
  titulo: string;
  /** O preço como a consulta devolveu (texto), ou `null`. */
  preco: string | null;
}

/** A referência única `<familia>:<id>` (ex.: `acf-imoveis:4821`). */
export function referenciaDoItem(familia: FamiliaReceita | string, itemId: string): string {
  return `${familia}:${itemId}`;
}

/** O marcador exato, com delimitadores, que vai na `description` do lead e é buscado pelo dedup. */
export function marcadorDaReferencia(referencia: string): string {
  return `[ref:${referencia}]`;
}

/** Texto vindo de outro sistema: uma linha só, sem controle, com teto. */
export function textoSeguro(valor: unknown, max: number): string {
  return String(valor ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export type Reserva = "nova" | "repetida" | "teto";

export class ItensDaReceitaNoTurno {
  private readonly itens = new Map<string, ItemDoTurno>();
  private readonly reservados = new Set<string>();
  private readonly respostas = new Map<string, unknown>();

  private static chave(instanciaId: string, itemId: string): string {
    return `${instanciaId}|${itemId}`;
  }

  /** Lê o resultado de `crm_consultar_receita` (executar) e guarda cada linha com `id`. */
  registrar(resultado: unknown): void {
    if (resultado === null || typeof resultado !== "object") return;
    const r = resultado as { erro?: unknown; error?: unknown; linhas?: unknown; instancia?: { id?: unknown } };
    if (r.erro || r.error || !Array.isArray(r.linhas)) return;
    const instanciaId = r.instancia?.id;
    if (typeof instanciaId !== "string" || instanciaId === "") return;
    for (const linha of r.linhas) {
      if (linha === null || typeof linha !== "object") continue;
      const l = linha as { id?: unknown; titulo?: unknown; preco?: unknown };
      if (l.id === undefined || l.id === null || String(l.id).trim() === "") continue;
      const preco = l.preco === undefined || l.preco === null ? "" : textoSeguro(l.preco, 40);
      this.itens.set(ItensDaReceitaNoTurno.chave(instanciaId, String(l.id).trim()), {
        titulo: textoSeguro(l.titulo, 150) || "item sem título",
        preco: preco === "" ? null : preco,
      });
    }
  }

  obter(instanciaId: string, itemId: string): ItemDoTurno | null {
    return this.itens.get(ItensDaReceitaNoTurno.chave(instanciaId, itemId.trim())) ?? null;
  }

  /** `repetida` = o mesmo item já foi tratado neste turno; `teto` = o turno já registrou o máximo. */
  reservar(instanciaId: string, itemId: string): Reserva {
    const k = ItensDaReceitaNoTurno.chave(instanciaId, itemId.trim());
    if (this.reservados.has(k)) return "repetida";
    if (this.reservados.size >= TETO_DE_INTERESSES_POR_TURNO) return "teto";
    this.reservados.add(k);
    return "nova";
  }

  /** Devolve a reserva quando nada foi gravado (a ferramenta recusou depois de reservar). */
  liberar(instanciaId: string, itemId: string): void {
    this.reservados.delete(ItensDaReceitaNoTurno.chave(instanciaId, itemId.trim()));
  }

  guardarResposta(instanciaId: string, itemId: string, resposta: unknown): void {
    this.respostas.set(ItensDaReceitaNoTurno.chave(instanciaId, itemId.trim()), resposta);
  }

  respostaDe(instanciaId: string, itemId: string): unknown {
    return this.respostas.get(ItensDaReceitaNoTurno.chave(instanciaId, itemId.trim()));
  }
}
