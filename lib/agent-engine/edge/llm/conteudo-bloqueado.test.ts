import { describe, expect, it } from 'vitest';
import { normalizarErro } from './run-model-call';
import { identificarConteudoBloqueado, LlmConteudoBloqueadoError } from './conteudo-bloqueado';
describe('bloqueio do provedor não é erro de JSON, promessa ou saldo', () => {
  it('reconhece a falha de validação com feedback recebido em HTTP 200', () => {
    const error = Object.assign(new Error('validation; dado que não deve aparecer'), { statusCode: 200, cause: { value: { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: { promptTokenCount: 12 }, secret: 'DADO-PRIVADO' } } });
    const result = identificarConteudoBloqueado(error);
    expect(result).toBeInstanceOf(LlmConteudoBloqueadoError);
    expect(result?.motivo).toBe('PROHIBITED_CONTENT');
    expect(result?.statusCode).toBe(200);
    expect(result?.message).not.toContain('DADO-PRIVADO');
    expect(result?.message).not.toContain('validation');
  });
  it('reconhece corpo JSON do erro SDK sem transferi-lo à mensagem', () => {
    expect(identificarConteudoBloqueado({ responseBody: JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' }, content: 'DADO-PRIVADO' }) })?.motivo).toBe('SAFETY');
  });
  it('não troca autorização, saldo, JSON comum ou código arbitrário por bloqueio', () => {
    expect(identificarConteudoBloqueado({ statusCode: 403, value: { promptFeedback: { blockReason: 'SAFETY' } } })).toBeNull();
    expect(identificarConteudoBloqueado(new Error('sem saldo'))).toBeNull();
    expect(identificarConteudoBloqueado({ value: { invalid: true } })).toBeNull();
    expect(identificarConteudoBloqueado({ value: { promptFeedback: { blockReason: 'DADO-PRIVADO' } } })).toBeNull();
  });
  it('termina em erro cíclico sem interpretar a mensagem como dado', () => {
    const cyclic: Record<string, unknown> = { message: 'PROHIBITED_CONTENT' }; cyclic.cause = cyclic;
    expect(identificarConteudoBloqueado(cyclic)).toBeNull();
  });
});

describe('diagnóstico consumido pelas Execuções', () => {
  it('salva o código do bloqueio e mantém a mensagem sem o corpo recebido', () => {
    const erro = Object.assign(new Error('AI_TypeValidationError; corpo privado'), {
      value: { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: {}, private: 'NÃO-EXIBIR' },
    });
    const result = normalizarErro(erro);
    expect(result.error_code).toBe('conteudo_bloqueado');
    expect(result.error_message).toContain('PROHIBITED_CONTENT');
    expect(result.error_message).not.toContain('NÃO-EXIBIR');
    expect(result.error_message).not.toContain('AI_TypeValidationError');
    expect(result.http_status).toBeNull();
  });
});
