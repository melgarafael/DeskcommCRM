import { normalizaTelefone, parseCsv } from "@/lib/contacts/csv";
import { precoParaCentavos } from "@/lib/schemas/produtos";

/**
 * A PLANILHA DE LEADS — da lista que a empresa já tem para dentro do funil.
 *
 * Extraído do PR #418 (@clinicacentrodosorrisosc-code). O que muda é ONDE a
 * leitura acontece e COM O QUE ela é feita.
 *
 * ─── Por que não veio o `xlsx` que o original usava ────────────────────────
 *
 * O #418 lê `.xlsx` no NAVEGADOR com `xlsx@0.18.5`. Essa é a última versão
 * publicada no npm da SheetJS, e ela carrega CVE-2023-30533 (prototype
 * pollution, alta) e CVE-2024-22363 (ReDoS) — a biblioteca saiu do npm e as
 * correções vivem só no CDN próprio deles. Num produto que se instala na VPS
 * de terceiros, entrar com uma dependência nessa situação é dívida que o
 * cliente paga.
 *
 * E não era preciso: `parseCsv` já existe aqui, é RFC 4180, sem dependência,
 * detecta o delimitador (o Excel em português exporta com `;`) e já tem
 * `decodificarCsv` para o arquivo em Latin-1 que o Excel gera. É o mesmo
 * caminho por onde os CONTATOS e o CATÁLOGO já entram — copiá-lo criaria a
 * segunda verdade sobre o que é uma planilha, e a segunda envelhece sozinha.
 *
 * ─── Por que a leitura é no SERVIDOR ───────────────────────────────────────
 *
 * O original montava as linhas no browser e disparava um `POST /api/v1/leads`
 * por linha, em lotes de 20 com `Promise.allSettled`. Três consequências: 500
 * requisições autenticadas para uma planilha de 500 nomes; nenhuma auditoria
 * do gesto "importei uma planilha", só 500 `lead.created` soltos; e o resultado
 * dependendo da aba ficar aberta — fechar o navegador no meio deixa metade
 * dentro e metade fora, sem ninguém saber qual metade.
 *
 * ─── A planilha vem suja, e recusar é a função ─────────────────────────────
 *
 * "R$ 1.200,00" e "1200", telefone com máscara, linha em branco no meio,
 * coluna com acento. Nada disso é erro de quem mandou — é o formato real. O
 * que NÃO se aceita em silêncio é o ambíguo: valor que não dá para ler vira
 * linha recusada com o motivo, nunca um chute.
 */

/** Como cada coluna pode vir escrita. A primeira forma é a que a gente sugere. */
const COLUNAS: Record<string, readonly string[]> = {
  titulo: ["nome", "titulo", "título", "lead", "negocio", "negócio", "oportunidade", "empresa", "assunto"],
  contato: ["nome do contato", "contato", "responsavel", "responsável", "pessoa"],
  telefone: ["telefone", "celular", "whatsapp", "fone", "phone"],
  email: ["email", "e-mail"],
  descricao: ["descricao", "descrição", "observacao", "observação", "observacoes", "observações", "notas", "detalhes"],
  valor: ["valor", "preco", "preço", "ticket", "value"],
  origem: ["origem", "fonte", "canal", "source"],
  etiquetas: ["tags", "etiquetas", "marcadores"],
};

function normalizarCabecalho(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function campoDaColuna(cabecalho: string): string | null {
  const alvo = normalizarCabecalho(cabecalho);
  for (const [campo, formas] of Object.entries(COLUNAS)) {
    if (formas.some((f) => normalizarCabecalho(f) === alvo)) return campo;
  }
  return null;
}

export interface LinhaDeLead {
  /** A linha como a pessoa a vê na planilha: 1 é o cabeçalho. */
  linha: number;
  title: string;
  description: string | null;
  value_cents: number | null;
  /** Já em E.164, ou nulo quando a célula não era um telefone. */
  telefone: string | null;
  nome_do_contato: string | null;
  email: string | null;
  tags: string[];
  source: string;
}

export interface ErroDaLinha {
  linha: number;
  motivo: string;
}

export interface ResultadoDaLeitura {
  leads: LinhaDeLead[];
  erros: ErroDaLinha[];
  /** Colunas que a planilha trouxe e este importador não conhece. */
  colunasIgnoradas: string[];
}

/** A origem gravada em `crm_leads.source` — vocabulário, não string solta. */
export const ORIGEM_DA_PLANILHA = "importacao_planilha";

export function lerPlanilhaDeLeads(conteudo: string): ResultadoDaLeitura | { erro: string } {
  const linhas = parseCsv(conteudo).filter((l) => l.some((c) => c.trim() !== ""));
  if (linhas.length === 0) return { erro: "A planilha está vazia." };

  const cabecalho = linhas[0]!;
  const mapa = new Map<number, string>();
  const colunasIgnoradas: string[] = [];
  cabecalho.forEach((titulo, i) => {
    const campo = campoDaColuna(titulo);
    if (campo && ![...mapa.values()].includes(campo)) mapa.set(i, campo);
    else if (titulo.trim() !== "") colunasIgnoradas.push(titulo.trim());
  });

  const campos = new Set(mapa.values());
  // Sem nada que NOMEIE o negócio não há card — e dizer isso antes de
  // processar 300 linhas evita um relatório com 300 erros iguais.
  if (!campos.has("titulo") && !campos.has("contato")) {
    return {
      erro:
        "A planilha precisa de uma coluna com o nome do negócio ou do contato. " +
        `Encontrei: ${cabecalho.filter((c) => c.trim()).join(", ") || "nenhuma coluna"}.`,
    };
  }

  const leads: LinhaDeLead[] = [];
  const erros: ErroDaLinha[] = [];

  for (let i = 1; i < linhas.length; i += 1) {
    const bruto = linhas[i]!;
    const numeroNaPlanilha = i + 1;
    const valor = (campo: string): string => {
      for (const [idx, c] of mapa) if (c === campo) return (bruto[idx] ?? "").trim();
      return "";
    };

    const nomeDoContato = valor("contato").replace(/\s+/g, " ");
    // Sem coluna de título, o nome do contato NOMEIA o card. O original punha
    // "Lead importado" nesse caso, e uma planilha de 300 nomes virava 300 cards
    // com o mesmo título — indistinguíveis no funil, que é onde eles vivem.
    const title = (valor("titulo").replace(/\s+/g, " ") || nomeDoContato).slice(0, 200);
    if (title.length < 2) {
      erros.push({ linha: numeroNaPlanilha, motivo: "sem nome do negócio nem do contato" });
      continue;
    }

    const valorTexto = valor("valor");
    const value_cents = valorTexto === "" ? null : precoParaCentavos(valorTexto);
    if (valorTexto !== "" && value_cents === null) {
      // O valor cru entra na mensagem: quem vai corrigir precisa achar a célula.
      erros.push({
        linha: numeroNaPlanilha,
        motivo: `valor não reconhecido ("${valorTexto}") — escreva assim: 1.200,00`,
      });
      continue;
    }

    const telefoneTexto = valor("telefone");
    const telefone = telefoneTexto === "" ? null : normalizaTelefone(telefoneTexto);
    if (telefoneTexto !== "" && telefone === null) {
      // Telefone ilegível NÃO derruba a linha: o negócio entra sem contato, e a
      // pessoa corrige um card em vez de reimportar a planilha inteira. Mas o
      // aviso fica, senão o número some sem ninguém saber.
      erros.push({
        linha: numeroNaPlanilha,
        motivo: `telefone não reconhecido ("${telefoneTexto}") — o negócio entrou sem contato`,
      });
    }

    const emailTexto = valor("email");

    leads.push({
      linha: numeroNaPlanilha,
      title,
      description: valor("descricao") || null,
      value_cents,
      telefone,
      nome_do_contato: nomeDoContato || null,
      email: emailTexto.includes("@") ? emailTexto : null,
      tags: valor("etiquetas")
        .split(/[,;|]/)
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 20),
      source: valor("origem") || ORIGEM_DA_PLANILHA,
    });
  }

  return { leads, erros, colunasIgnoradas };
}
