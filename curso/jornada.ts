/** Conteúdo público das jornadas. Referências são verificadas antes de gerar HTML. */
import { z } from "zod";

const id = z.string().regex(/^[a-z0-9-]+$/);
const texto = z.string().trim().min(1);
const Cena = z.object({ id, titulo: texto, cliente: texto, operacao: texto, valor: texto, captura: texto }).strict();
const Jornada = z.object({
  id, titulo: texto, empresa: texto, contexto: texto, resultado: texto,
  tipo: z.enum(["roteiro-demonstrativo", "execucao-observada"]), nota: texto,
  dependencias: texto,
  montagem: z.array(z.object({ modulo: id, licao: id, porque: texto }).strict()).min(1),
  cenas: z.array(Cena).min(1),
}).strict();
export const Nicho = z.object({ id, titulo: texto, resumo: texto, jornadas: z.array(Jornada).min(1) }).strict();
export type Nicho = z.infer<typeof Nicho>;

type ModuloReferenciado = { id: string; licoes: Array<{ id: string }> };
/** Aceita o manifesto bruto; só usa entradas próprias e caminhos locais de fotos. */
export function validarJornadas(nichos: unknown[], modulos: ModuloReferenciado[], capturas: Record<string, unknown>): void {
  const unicos = (ids: string[], contexto: string) => {
    if (new Set(ids).size !== ids.length) throw new Error(`${contexto}: ids repetidos`);
  };
  const dados = nichos.map((n) => Nicho.parse(n));
  unicos(dados.map((n) => n.id), "nichos");
  for (const n of dados) {
    unicos(n.jornadas.map((j) => j.id), n.id);
    for (const j of n.jornadas) {
      const contexto = `${n.id}/${j.id}`;
      unicos(j.cenas.map((c) => c.id), contexto);
      for (const ref of j.montagem) {
        if (!modulos.some((m) => m.id === ref.modulo && m.licoes.some((l) => l.id === ref.licao))) {
          throw new Error(`${contexto}: lição ausente ${ref.modulo}/${ref.licao}`);
        }
      }
      for (const c of j.cenas) {
        const cap = Object.hasOwn(capturas, c.captura) ? capturas[c.captura] : null;
        const foto = cap && typeof cap === "object" && "foto" in cap ? cap.foto : null;
        if (typeof foto !== "string" || !/^(?:fotos|capturas)\/[a-zA-Z0-9_./-]+\.(png|webp|jpe?g)$/.test(foto) || foto.split("/").includes("..")) {
          throw new Error(`${contexto}/${c.id}: foto ausente ou inválida (${c.captura})`);
        }
      }
    }
  }
}
