import {describe,it,expect,vi} from 'vitest';
import {capturarRevisao,sanitizarCaptura,MAX_BYTES} from './captura';
import type {Queryable} from '@/lib/agent-engine/queue/queue';
describe('Captura privada',()=>{
  it('default-off não serializa nem grava pacote',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{enabled:false}]});
    const toJSON=vi.fn(()=>{throw new Error('não deve serializar');});
    await capturarRevisao({query} as Queryable,{tenantId:'org',jobId:'job'},'reserva',{toJSON});
    expect(query).toHaveBeenCalledTimes(1);expect(toJSON).not.toHaveBeenCalled();
  });
  it('nunca aceita headers, tokens, URL assinada nem PII reconhecida no texto/JSON aninhado',()=>{
    const value=sanitizarCaptura({headers:{Authorization:'Bearer segredo'},messages:[{role:'user',content:JSON.stringify({token:'segredo-semente',candidate:'ana@example.test Bearer segredo https://a.test?token=senha'})}]});
    const text=JSON.stringify(value);for(const secret of ['segredo','ana@example.test','a.test'])expect(text).not.toContain(secret);
  });
  it('guarda o envelope invocado e caminho, sem campos de credencial',async()=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[{enabled:true}]}).mockResolvedValue({rows:[]});
    await capturarRevisao({query} as Queryable,{tenantId:'org',jobId:'job'},'confirmador',{system:'regra',messages:[{role:'user',content:'candidata de fixture'}]});
    expect(query.mock.calls[1]![1]).toEqual(['org','job','confirmador',JSON.stringify({packet:{system:'regra',messages:[{role:'user',content:'candidata de fixture'}]},diagnostic_coverage:{sanitized:true,complete:true,omitted_fields:0,text_field_limit:16000}})]);
  });
  it('limite de bytes exclui inteiro, e erro de coleta não quebra atendimento',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{enabled:true}]});await capturarRevisao({query} as Queryable,{tenantId:'org',jobId:'job'},'jev',{text:'x'.repeat(MAX_BYTES)});expect(query).toHaveBeenCalledTimes(1);
    query.mockRejectedValue(new Error('conteúdo proibido'));await expect(capturarRevisao({query} as Queryable,{tenantId:'org',jobId:'job'},'reserva',{candidate:'fixture'})).resolves.toBeUndefined();
  });
});


it('campos grandes são omitidos inteiros com cobertura explícita, preservando o restante',async()=>{
  const query=vi.fn().mockResolvedValueOnce({rows:[{enabled:true}]}).mockResolvedValue({rows:[]});
  await capturarRevisao({query} as Queryable,{tenantId:'org',jobId:'job'},'reserva',{system:'x'.repeat(16001),messages:[{role:'user',content:'Candidata completa de teste'}]});
  const payload=JSON.parse(query.mock.calls[1]![1][3]);expect(payload.diagnostic_coverage).toMatchObject({complete:false,omitted_fields:1});expect(payload.packet.system).toContain('TEXTO EXCLUÍDO');expect(payload.packet.messages[0].content).toBe('Candidata completa de teste');
});

it('partes de mídia do SDK e data URLs não entram na captura',()=>{
  const text=JSON.stringify(sanitizarCaptura({messages:[{role:'user',content:[{type:'file',data:'RAW_AUDIO_SECRET',mediaType:'audio/wav'},{type:'image',image:'RAW_IMAGE_SECRET'},{type:'text',text:'data:audio/wav;base64,RAW_BASE64_SECRET'}]}]}));
  for(const secret of ['RAW_AUDIO_SECRET','RAW_IMAGE_SECRET','RAW_BASE64_SECRET'])expect(text).not.toContain(secret);expect(text).toContain('media_excluded');
});
