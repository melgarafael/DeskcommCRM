import type { SheetMatrix } from "@/lib/planilha/ler-arquivo";
import type {
  CandidatoNaPlanilha,
  LinhaExcluida,
  MotivoDeExclusao,
} from "@/lib/prospecting/importacao-previa";
import { TEXTO_DO_MOTIVO } from "@/lib/prospecting/importacao-previa";
import { normalizeProspectPhone, safePublicLink } from "@/lib/prospecting/schema";
import { contextoDaLinha } from "@/lib/prospecting/contexto-da-equipe";

/**
 * A PLANILHA DE PROSPECÇÃO — a lista própria do operador como segunda porta de entrada
 * dos candidatos (a primeira é a busca no Google Maps).
 *
 * Este arquivo só LÊ e valida: devolve candidatos no mesmo formato `Prospect` que a busca
 * produz, para que a gravação, a triagem, a auditoria de site e a fila sejam o caminho que
 * já existe. Recusar é a função: linha sem nome ou sem telefone válido volta ao operador
 * com o número da linha e o motivo, nunca vira chute.
 */

/** Dez dias de fila no teto de 50 por dia; a tela de candidatos já lista até 5.000. */
export const PLANILHA_MAX_LINHAS = 500;

type Campo =
  | "name"
  | "phone"
  | "website"
  | "category"
  | "address"
  | "emails"
  | "socials"
  | "diagnostico"
  | "oferta"
  | "contexto";

/** Formas aceitas de cada coluna, sem acento e sem caixa (inclui espanhol). */
const COLUNAS: Record<Campo, readonly string[]> = {
  name: ["empresa", "nome", "nome fantasia", "razao social", "negocio", "nombre"],
  phone: ["telefone", "celular", "whatsapp", "fone", "phone", "telefono", "movil"],
  website: ["site", "website", "url", "pagina", "sitio web"],
  category: ["segmento", "categoria", "ramo", "nicho", "rubro"],
  address: ["endereco", "cidade", "local", "direccion"],
  emails: ["email", "e-mail", "correo"],
  socials: ["instagram", "facebook", "linkedin", "redes"],
  // O que a EQUIPE já sabe da empresa (opcionais; `lib/prospecting/contexto-da-equipe.ts`).
  // Em espanhol, "diagnóstico", "oferta" e "contexto" se escrevem igual.
  diagnostico: ["diagnostico", "diagnostico da equipe"],
  oferta: ["oferta", "oferta sugerida", "oferta sugerida pela equipe"],
  // "observação" fica de FORA de propósito: é o nome mais comum de coluna de nota
  // interna, e uma planilha antiga passaria a mandar essas notas para a IA dizer ao
  // cliente como fato. Quem usa esse nome vê a coluna em "colunas ignoradas".
  contexto: ["contexto", "contexto da equipe", "o que sabemos"],
};

/** Campos que aceitam mais de uma coluna (nos demais vale só a primeira). */
const MULTIPLAS: ReadonlySet<Campo> = new Set<Campo>(["address", "emails", "socials"]);

function normalizarCabecalho(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function campoDaColuna(cabecalho: string): Campo | null {
  const alvo = normalizarCabecalho(cabecalho);
  for (const [campo, formas] of Object.entries(COLUNAS) as [Campo, readonly string[]][]) {
    if (formas.includes(alvo)) return campo;
  }
  return null;
}

/**
 * O site como a pessoa digita na planilha: quase sempre sem protocolo ("www.padaria.com.br").
 * Sem protocolo ganha `https://`; o que não vira URL `http(s)` (um `javascript:`, um texto
 * solto) fica nulo em vez de ser gravado — o mesmo `safePublicLink` que guarda as redes.
 */
function siteDaCelula(bruto: string): string | null {
  if (!bruto) return null;
  const comProtocolo = /^[a-z][a-z0-9+.-]*:/i.test(bruto) ? bruto : `https://${bruto}`;
  const url = safePublicLink(comProtocolo);
  return url && url.length <= 500 ? url : null;
}

export type LeituraDaPlanilhaDeProspeccao =
  | {
      candidatos: CandidatoNaPlanilha[];
      erros: LinhaExcluida[];
      colunasIgnoradas: string[];
    }
  | { erro: string };

export function lerPlanilhaDeProspeccao(sheet: SheetMatrix): LeituraDaPlanilhaDeProspeccao {
  if (sheet.rows.length > PLANILHA_MAX_LINHAS) {
    // Importar "os primeiros 500" em silêncio deixaria o operador achar que a lista inteira entrou.
    return { erro: `Máximo de ${PLANILHA_MAX_LINHAS} linhas de dados.` };
  }

  const colunas = new Map<Campo, number[]>();
  const colunasIgnoradas: string[] = [];
  sheet.headers.forEach((titulo, i) => {
    const campo = campoDaColuna(titulo);
    if (campo && (MULTIPLAS.has(campo) || !colunas.has(campo))) {
      colunas.set(campo, [...(colunas.get(campo) ?? []), i]);
    } else if (titulo.trim() !== "") {
      colunasIgnoradas.push(titulo.trim());
    }
  });

  if (!colunas.has("name") || !colunas.has("phone")) {
    const encontradas = sheet.headers.map((h) => h.trim()).filter(Boolean);
    return {
      erro:
        "A planilha precisa de uma coluna com o nome da empresa e outra com o telefone. " +
        `Encontrei: ${encontradas.join(", ") || "nenhuma coluna"}. ` +
        `Nomes aceitos para a empresa: ${COLUNAS.name.join(", ")}. ` +
        `Nomes aceitos para o telefone: ${COLUNAS.phone.join(", ")}.`,
    };
  }

  const valores = (linha: string[], campo: Campo): string[] =>
    (colunas.get(campo) ?? []).map((i) => (linha[i] ?? "").trim()).filter(Boolean);
  const primeiro = (linha: string[], campo: Campo) => valores(linha, campo)[0] ?? "";

  const candidatos: CandidatoNaPlanilha[] = [];
  const erros: LinhaExcluida[] = [];
  const telefonesVistos = new Map<string, number>();

  sheet.rows.forEach((bruto, i) => {
    const linha = sheet.rowNumbers?.[i] ?? i + 2;
    if (bruto.every((c) => c.trim() === "")) return;

    const name = primeiro(bruto, "name").replace(/\s+/g, " ").slice(0, 200);
    if (name.length < 2) {
      erros.push({ linha, telefone: null, codigo: "sem_nome", motivo: TEXTO_DO_MOTIVO.sem_nome });
      return;
    }

    // Telefone EM BRANCO e telefone preenchido que não vira E.164 são dois problemas
    // diferentes: o primeiro é a linha incompleta, o segundo é o número digitado errado
    // (ou um "11 9999" sem o nono). O operador conserta um e o outro de formas distintas.
    const brutoTelefone = primeiro(bruto, "phone");
    const phone = normalizeProspectPhone(brutoTelefone);
    if (!phone) {
      const codigo: MotivoDeExclusao = brutoTelefone ? "telefone_invalido" : "sem_telefone";
      erros.push({ linha, telefone: null, codigo, motivo: TEXTO_DO_MOTIVO[codigo] });
      return;
    }
    const jaVisto = telefonesVistos.get(phone);
    if (jaVisto !== undefined) {
      erros.push({
        linha,
        telefone: phone,
        codigo: "repetido_na_planilha",
        motivo: TEXTO_DO_MOTIVO.repetido_na_planilha,
        detalhe: `linha ${jaVisto}`,
      });
      return;
    }
    telefonesVistos.set(phone, linha);

    const emails = [
      ...new Set(
        valores(bruto, "emails")
          .flatMap((v) => v.split(/[,;\s]+/))
          .filter((e) => e.includes("@"))
          .map((e) => e.slice(0, 500)),
      ),
    ].slice(0, 5);
    const socials = [
      ...new Set(
        valores(bruto, "socials")
          .flatMap((v) => v.split(/[,;\s]+/))
          .map((v) => safePublicLink(v))
          .filter((v): v is string => !!v && v.length < 500),
      ),
    ].slice(0, 15);

    const contexto = contextoDaLinha({
      diagnostico: primeiro(bruto, "diagnostico"),
      oferta: primeiro(bruto, "oferta"),
      contexto: primeiro(bruto, "contexto"),
    });

    candidatos.push({
      linha,
      prospect: {
        // Estável: reimportar o mesmo número bate no `unique` e no gatilho de supressão da LGPD.
        key: `planilha:${phone}`,
        name,
        phone,
        website: siteDaCelula(primeiro(bruto, "website")),
        category: primeiro(bruto, "category").slice(0, 500) || null,
        address: valores(bruto, "address").join(", ").slice(0, 500) || null,
        maps_url: null,
        rating: null,
        reviews: null,
        emails,
        socials,
        // Só com algum texto: sem as colunas (ou com elas vazias) o candidato nasce
        // SEM a chave, igual ao de antes.
        ...(contexto ? { contexto_da_equipe: contexto } : {}),
      },
    });
  });

  return { candidatos, erros, colunasIgnoradas };
}
