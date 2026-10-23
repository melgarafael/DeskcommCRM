import { limitarContextoCompartilhado, type ContextoCompartilhadoDoTurno } from '@/lib/ai/contexto-observado-do-turno';
export { limitarContextoCompartilhado, INSTRUCAO_CONTEXTO_COMPARTILHADO, type ContextoCompartilhadoDoTurno } from '@/lib/ai/contexto-observado-do-turno';
import type { ToolSet } from 'ai';
import { createHash } from 'node:crypto';
import { scrubMessage } from '@/lib/sentry/scrub';

const MAXIMO_POR_FONTE = 16000;
const MAXIMO_DE_FONTES = 24;
const sigiloso = /^(?:authorization|cookie|password|senha|secret|access_token|refresh_token|api_key|credential(?:_id)?|signed_url)$/i;

function conteudoCompartilhavel(resultado: unknown, referencias: Map<string, string>, projecoes: WeakMap<object, unknown>): unknown {
  // Não enviar credenciais, referências internas ou URLs assinadas a outro provedor.
  const json = JSON.stringify(resultado, (chave, valor: unknown) => {
    if (sigiloso.test(chave)) return undefined;
    if (valor !== null && typeof valor === 'object' && projecoes.has(valor)) return projecoes.get(valor);
    if (typeof valor === 'string') return valor
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, id => {
        const chave = id.toLowerCase();
        if (!referencias.has(chave)) referencias.set(chave, `referencia_${referencias.size + 1}`);
        return referencias.get(chave)!;
      })
      .replace(/https?:\/\/[^\s"<>]*(?:token=|signature=|X-Amz-Signature=)[^\s"<>]*/gi, '[url_privada]');
    return valor;
  });
  return json === undefined ? null : JSON.parse(scrubMessage(json)) as unknown;
}

export function criarContextoCompartilhadoDoTurno() {
  let sequencia = 0, omitidas = 0;
  const referencias = new Map<string, string>();
  const projecoes = new WeakMap<object, unknown>();
  const fontes: ContextoCompartilhadoDoTurno['fontes'] = [];
  const reservar = (origem: ContextoCompartilhadoDoTurno['fontes'][number]['origem'], nome: string) => {
    if (fontes.length === MAXIMO_DE_FONTES) { fontes.shift(); omitidas++; }
    const fonte: ContextoCompartilhadoDoTurno['fontes'][number] = {
      sequencia: ++sequencia, origem, nome: nome.slice(0, 120), estado: 'pending',
    };
    fontes.push(fonte);
    return fonte.sequencia;
  };
  const concluir = (seq: number, resultado: unknown) => {
    const fonte = fontes.find(f => f.sequencia === seq);
    if (!fonte || fonte.estado !== 'pending') return;
    try {
      const conteudo = conteudoCompartilhavel(resultado, referencias, projecoes);
      if (JSON.stringify(conteudo).length > MAXIMO_POR_FONTE) fonte.estado = 'excluded_by_limit';
      else { fonte.conteudo = conteudo; fonte.estado = 'present'; }
    } catch { fonte.estado = 'unavailable'; }
  };
  return {
    /** A origem define a projeção permitida; a ponte de qualquer ferramenta a respeita. */
    compartilharResultado<T extends object>(resultado: T, projecao: unknown): T {
      projecoes.set(resultado, projecao);
      return resultado;
    },
    iniciarFerramenta: (nome: string) => reservar('resultado_ferramenta', nome),
    concluir,
    falhar(seq: number) {
      const fonte = fontes.find(f => f.sequencia === seq);
      if (fonte) { fonte.estado = 'unavailable'; delete fonte.conteudo; }
    },
    registrarInstrucao(nome: string, texto: string) {
      if (texto.trim()) concluir(reservar('instrucao_do_agente', nome), texto);
    },
    atual(): ContextoCompartilhadoDoTurno | undefined {
      if (!fontes.length) return;
      return limitarContextoCompartilhado({ versao: 1, fontes, omitidas,
        fingerprint: createHash('sha256').update(JSON.stringify({ fontes, omitidas })).digest('hex') });
    },
  };
}

/** Leituras continuam paralelas; o envio aguarda as ferramentas já iniciadas no passo. */
export function observarFerramentasDoTurno(ferramentas: ToolSet, contexto: ReturnType<typeof criarContextoCompartilhadoDoTurno>): ToolSet {
  const observadas = { ...ferramentas };
  const pendentes = new Set<Promise<unknown>>();
  for (const [nome, ferramenta] of Object.entries(ferramentas)) {
    if (typeof ferramenta.execute !== 'function') continue;
    const executar = ferramenta.execute.bind(ferramenta);
    observadas[nome] = { ...ferramenta, execute: (async (...args: Parameters<typeof executar>) => {
      if (nome === 'send_message') {
        // A abertura de Caso e o envio podem vir juntos do modelo. Aguardar também
        // a captura da fonte evita revisar uma fotografia anterior ao efeito.
        // Uma falha não libera promessa: os gates relêem o estado e seguem ativos.
        // Colete também as chamadas irmãs despachadas logo depois neste passo.
        await Promise.resolve();
        await Promise.allSettled([...pendentes]);
        return executar(...args);
      }
      const seq = contexto.iniciarFerramenta(nome);
      const trabalho = (async () => {
        try {
          const resultado = await executar(...args);
          contexto.concluir(seq, { entrada: args[0], resultado });
          return resultado;
        } catch (erro) { contexto.falhar(seq); throw erro; }
      })();
      pendentes.add(trabalho);
      try { return await trabalho; }
      finally { pendentes.delete(trabalho); }
    }) as typeof ferramenta.execute };
  }
  return observadas;
}
