/**
 * QUAL CHAVE E QUAL VOZ O TURNO USA na resposta em áudio — lido no worker.
 *
 * A precedência, de cima para baixo:
 *
 *   1. **Chave**: a credencial da ORGANIZAÇÃO cadastrada em IA › Provedores ›
 *      Voz e áudio (`ai_provider_credentials`, `provider = 'google-tts'`), ativa
 *      e validada, cifrada AES-256-GCM com `AI_CRED_AES_KEY` — a mesma cifra e a
 *      mesma regra (ativa + validada) das chaves de IA. Sem ela,
 *      `GOOGLE_TTS_API_KEY` do ambiente, a reserva de compatibilidade da
 *      instalação. Sem as duas: `nao_configurada`.
 *   2. **Voz**: a escolhida no AGENTE (`ai_agents.config.voz_da_resposta_em_audio`);
 *      sem escolha, `GOOGLE_TTS_VOICE`; sem ela, `VOZ_PADRAO` (Standard). Qualquer
 *      uma fora de `./vozes.ts` é `voz_nao_permitida` — a resposta sai em texto.
 *
 * A consulta filtra `organization_id` E `provider` à mão: o pool do worker não
 * passa por RLS. Nunca lança — falha vira código, e o turno segue em texto.
 * Nada daqui loga a chave: o resultado carrega a chave só para o sintetizador.
 */
import { PROVEDOR_DA_VOZ } from '@/lib/ai/pontos/provedores';
import { byteaToBuffer, decryptKey } from '@/lib/crypto/aes_gcm';

import type { Queryable } from '../../queue/queue';
import { configDaVoz, type ConfigDaVoz } from './sintese';
import { ehVozAceita } from './vozes';

export type OrigemDaChaveDaVoz = 'organizacao' | 'instalacao';

export type VozResolvida =
  | { ok: true; config: ConfigDaVoz; origem: OrigemDaChaveDaVoz }
  | { ok: false; code: 'nao_configurada' | 'voz_nao_permitida' | 'credencial_ilegivel' };

interface LinhaCifrada {
  api_key_encrypted: unknown;
  api_key_iv: unknown;
  api_key_tag: unknown;
}

export async function resolverVozDoTurno(input: {
  db: Queryable;
  organizationId: string;
  /** `ai_agents.config.voz_da_resposta_em_audio`; `null` = o agente não escolheu. */
  vozDoAgente: string | null;
  ambiente: { GOOGLE_TTS_API_KEY?: string; GOOGLE_TTS_VOICE?: string };
}): Promise<VozResolvida> {
  let chaveDaOrganizacao: string | null = null;
  try {
    const { rows } = await input.db.query<LinhaCifrada>(
      `select api_key_encrypted, api_key_iv, api_key_tag
         from ai_provider_credentials
        where organization_id = $1 and provider = $2
          and is_active and validated_at is not null
        order by updated_at desc
        limit 1`,
      [input.organizationId, PROVEDOR_DA_VOZ],
    );
    const linha = rows[0];
    if (linha !== undefined) {
      try {
        chaveDaOrganizacao = decryptKey({
          ciphertext: byteaToBuffer(linha.api_key_encrypted),
          iv: byteaToBuffer(linha.api_key_iv),
          tag: byteaToBuffer(linha.api_key_tag),
        });
      } catch {
        // Linha existe e não decifra (AI_CRED_AES_KEY trocada): não cai em
        // silêncio na chave do ambiente — a organização configurou a dela.
        return { ok: false, code: 'credencial_ilegivel' };
      }
    }
  } catch {
    // Leitura falhou: a reserva da instalação responde, como se não houvesse linha.
    chaveDaOrganizacao = null;
  }

  const chaveDaInstalacao = (input.ambiente.GOOGLE_TTS_API_KEY ?? '').trim();
  const apiKey = chaveDaOrganizacao ?? (chaveDaInstalacao === '' ? null : chaveDaInstalacao);
  if (apiKey === null || apiKey.trim() === '') return { ok: false, code: 'nao_configurada' };

  // A voz do agente vence; sem ela, a do ambiente (ou a padrão), pela mesma
  // leitura de `configDaVoz` — que recusa nome fora de `./vozes.ts`.
  let voz: string;
  if (input.vozDoAgente !== null) {
    if (!ehVozAceita(input.vozDoAgente)) return { ok: false, code: 'voz_nao_permitida' };
    voz = input.vozDoAgente;
  } else {
    const doAmbiente = configDaVoz({ GOOGLE_TTS_API_KEY: apiKey, GOOGLE_TTS_VOICE: input.ambiente.GOOGLE_TTS_VOICE });
    if (!doAmbiente.ok) return { ok: false, code: 'voz_nao_permitida' };
    voz = doAmbiente.config.voz;
  }

  return {
    ok: true,
    config: { apiKey, voz },
    origem: chaveDaOrganizacao !== null ? 'organizacao' : 'instalacao',
  };
}
