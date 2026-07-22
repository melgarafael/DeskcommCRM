import { describe, it, expect, vi } from 'vitest';

// env.ts valida process.env no import (a cadeia run-model-call → credentials →
// lib/crypto/aes_gcm → lib/env); o vitest roda em mode 'test' e não carrega
// .env.local de propósito (não reproduzível entre máquinas) — stub mínimo evita
// o throw. Nenhum teste aqui exercita a chamada de modelo de verdade (só as
// funções puras de parse), então o stub nunca é lido de fato.
vi.mock('@/lib/env', () => ({ env: {} }));

import { parseFollowupClassification, parseProposedAt } from './followup-flow-classify';

describe('parseFollowupClassification', () => {
  it('extracts a class that is literally in the allowed list', () => {
    expect(parseFollowupClassification('{"class": "hot"}', ['hot', 'cold'])).toBe('hot');
  });

  it('tolerates prose/code-fence around the JSON', () => {
    const text = 'Aqui está:\n```json\n{"class": "cold"}\n```\nEspero ter ajudado.';
    expect(parseFollowupClassification(text, ['hot', 'cold'])).toBe('cold');
  });

  it('rejects a class outside the allowed list — never guesses', () => {
    expect(parseFollowupClassification('{"class": "mystery"}', ['hot', 'cold'])).toBeNull();
  });

  it('returns null when there is no JSON at all', () => {
    expect(parseFollowupClassification('desculpe, não sei responder', ['hot', 'cold'])).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(parseFollowupClassification('{"class": "hot"', ['hot', 'cold'])).toBeNull();
  });
});

describe('parseProposedAt', () => {
  it('extracts a valid ISO instant', () => {
    expect(parseProposedAt('{"proposed_at": "2026-07-25T14:00:00.000Z"}')).toBe('2026-07-25T14:00:00.000Z');
  });

  it('rejects an unparseable instant', () => {
    expect(parseProposedAt('{"proposed_at": "amanhã de manhã"}')).toBeNull();
  });

  it('returns null when there is no JSON at all', () => {
    expect(parseProposedAt('talvez semana que vem')).toBeNull();
  });
});
