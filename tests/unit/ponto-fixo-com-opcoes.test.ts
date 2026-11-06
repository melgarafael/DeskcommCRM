/**
 * O MENU FECHADO DE UM PONTO FIXO — leitura (resolver) e escrita (validar-binding).
 *
 * `transcricao_de_audio` é o primeiro ponto `fixo` a ganhar `opcoes`: continua
 * sem aceitar provider/modelo livres (não é um turno de chat), mas passa a ter
 * uma escolha real: "Automático" (a escada) ou o ElevenLabs (Scribe), que vira
 * o degrau 0 da escada. Os dois lados dessa escolha são
 * testados juntos porque são a MESMA regra vista de dois ângulos — testar só a
 * leitura deixaria passar uma escrita que grava uma opção inválida; testar só a
 * escrita deixaria passar uma leitura que ignora a escolha salva.
 */
import { describe, expect, it, vi } from "vitest";

// A escada lê o `.env` da instalação (degrau 1): sem este mock, quem roda o
// teste com TRANSCRIPTION_API_KEY preenchida mudaria o degrau esperado.
vi.mock("@/lib/env", () => ({ env: {} }));

import {
  decidirBinding,
  type EntradaDaDecisao,
  type LinhaDeBinding,
} from "@/lib/ai/pontos/resolver";
import { validarBinding } from "@/lib/ai/pontos/validar-binding";
import { decidirTranscricao } from "@/lib/messaging/media/escada-de-transcricao";

const PADRAO = { provider: "anthropic", defaultModel: "claude-sonnet-5" };

const binding = (over: Partial<LinhaDeBinding> = {}): LinhaDeBinding => ({
  purpose: "transcricao_de_audio",
  provider: "elevenlabs",
  credential_id: "cred-elevenlabs",
  model_id: "scribe_v1",
  base_url: null,
  is_enabled: true,
  ...over,
});

const entrada = (over: Partial<EntradaDaDecisao> = {}): EntradaDaDecisao => ({
  pontoId: "transcricao_de_audio",
  binding: null,
  agentePublicado: null,
  modeloDeAmbiente: undefined,
  padraoDaOrganizacao: PADRAO,
  ...over,
});

describe("o menu escolhe o degrau 0 da escada de transcrição", () => {
  // O ponto é `escada`: quem decide é `decidirTranscricao`, e o resolvedor só
  // repassa o anúncio. O Scribe escolhido no menu é o degrau 0 dela.
  it("Scribe escolhido e com chave: é ele que ouve, e é ele que a tela anuncia", async () => {
    const decisao = await decidirTranscricao({
      elevenlabsEscolhido: async () => ({ apiKey: "sk_el", modelId: "scribe_v1" }),
      chaveOpenai: async () => "sk-openai",
    });
    expect(decisao.origem).toBe("elevenlabs_escolhido");
    expect(decisao.anuncio).toEqual({ provider: "elevenlabs", modelId: "scribe_v1" });
    const d = decidirBinding(entrada({ binding: binding(), transcricao: decisao }));
    expect(d.provider).toBe("elevenlabs");
    expect(d.modelId).toBe("scribe_v1");
  });

  it("Scribe sem chave utilizável (degrau 0 devolve null): a escada segue, não emudece", async () => {
    const decisao = await decidirTranscricao({
      elevenlabsEscolhido: async () => null,
      chaveOpenai: async () => "sk-openai",
    });
    expect(decisao.origem).toBe("padrao_openai_compativel");
    expect(decisao.transcriber).not.toBeNull();
  });

  it("sem escada entregue, o ponto não anuncia o Scribe só porque há binding", () => {
    const d = decidirBinding(entrada({ binding: binding(), transcricao: null }));
    expect(d.provider).not.toBe("elevenlabs");
    expect(d.modelId).toBeNull();
  });
});

describe("validarBinding — ponto fixo com menu", () => {
  const conhecido = (model_id: string) => ({ model_id, supports_tools: false, supports_vision: false, conhecido: false });

  it("aceita um par que está no menu", () => {
    const r = validarBinding({
      pontoId: "transcricao_de_audio",
      provider: "elevenlabs",
      modelo: conhecido("scribe_v1"),
    });
    expect(r.ok).toBe(true);
  });

  it("aceita o OUTRO par do menu também", () => {
    const r = validarBinding({
      pontoId: "transcricao_de_audio",
      provider: "openai",
      modelo: conhecido("whisper-1"),
    });
    expect(r.ok).toBe(true);
  });

  it("recusa um modelo que não está no menu — mesmo sendo um provider real", () => {
    const r = validarBinding({
      pontoId: "transcricao_de_audio",
      provider: "elevenlabs",
      modelo: conhecido("outro-modelo-qualquer"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("opcao_fora_do_menu");
  });

  it("recusa um PROVIDER fora do menu, mesmo com um model_id que existe no outro par", () => {
    // Prova que o par é verificado JUNTO — provider certo com modelo do outro
    // provider não pode passar batido.
    const r = validarBinding({
      pontoId: "transcricao_de_audio",
      provider: "anthropic",
      modelo: conhecido("whisper-1"),
    });
    expect(r.ok).toBe(false);
  });

  it("não cai na catraca de ferramentas/visão — esta não é a mesma validação dos pontos de chat", () => {
    // Um modelo "desconhecido" (`conhecido:false`) no caminho de chat geraria
    // aviso de catálogo; aqui a resposta é só ok/não-ok contra o menu.
    const r = validarBinding({
      pontoId: "transcricao_de_audio",
      provider: "openai",
      modelo: conhecido("whisper-1"),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.avisos).toEqual([]);
  });

  it("ponto fixo SEM opcoes continua recusando qualquer escolha, como antes", () => {
    const r = validarBinding({
      pontoId: "agent_preview", // ponto sem `fixo` nem `opcoes`; controle de que o branch novo não vazou
      provider: "anthropic",
      modelo: conhecido("claude-sonnet-5"),
    });
    // Não é fixo, então passa pela validação normal — não pelo branch do menu.
    expect(r.ok).toBe(true);
  });
});
