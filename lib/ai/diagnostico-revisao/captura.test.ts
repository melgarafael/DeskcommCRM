import {describe,it,expect,vi} from 'vitest';
import {capturarRevisao,sanitizarCaptura,capturaRevisaoHabilitada,MAX_BYTES,TEXT_FIELD_LIMIT,MAX_TEXT_SEGMENTS} from './captura';
import {createHash} from 'node:crypto';
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

it('representação do contexto preserva texto longo real sanitizado, com campos de até16000',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[{enabled:true}]});
  const original='Regra vigente\n'.repeat(1800)+'Fim do contexto: recibo revisão4, Google synced.';
  await capturarRevisao({query} as Queryable,{tenantId:'org',jobId:'job'},'reserva',
    {system:{role:'system',content:original},request_body:JSON.stringify({messages:[{role:'user',content:original}]})},{textosLongos:'segmentados'});
  const payload=JSON.parse(query.mock.calls[1]![1][3]);
  const text=payload.packet.system.content;
  expect(text).toMatchObject({diagnostic_representation:'text_segments_v1',complete:true,omitted_chars:0,source_chars:original.length});
  expect(text.segments.join('')).toBe(original);
  expect(text.sha256_sanitized).toBe(createHash('sha256').update(original).digest('hex'));
  expect(text.segments.every((s:string)=>s.length<=TEXT_FIELD_LIMIT)).toBe(true);
  expect(payload.packet.request_body.diagnostic_representation).toBe('json_string_v1');
  expect(payload.packet.request_body.value.messages[0].content.segments.join('')).toBe(original);
  expect(payload.diagnostic_coverage).toMatchObject({complete:true,text_field_limit:16000,max_text_segments:8});
});

it('redige antes de segmentar, inclusive credenciais/PII cruzando a fronteira',()=>{
  const original='a'.repeat(TEXT_FIELD_LIMIT-8)+' Bearer segredo-fronteira ana@example.test AIzaCHAVE_SECRETA_TESTE https://a.test?sig=segredo '+'fim '.repeat(2000);
  const encoded=sanitizarCaptura(original,undefined,{textosLongos:'segmentados'}) as {segments:string[]};
  const text=encoded.segments.join('');
  for(const secret of ['segredo-fronteira','ana@example.test','AIzaCHAVE_SECRETA_TESTE','a.test'])expect(text).not.toContain(secret);
  expect(text).toContain('fim');
});

it('segmentação tem teto próprio e não mascara a omissão, nem aumenta a quota total',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[{enabled:true}]});
  await capturarRevisao({query} as Queryable,{tenantId:'org',jobId:'job'},'reserva',
    {system:'x'.repeat(TEXT_FIELD_LIMIT*MAX_TEXT_SEGMENTS+1)},{textosLongos:'segmentados'});
  const payload=JSON.parse(query.mock.calls[1]![1][3]);
  expect(payload.packet.system).toMatchObject({complete:false,omitted_chars:TEXT_FIELD_LIMIT*MAX_TEXT_SEGMENTS+1,diagnostic_omission:'text_segments_limit'});
  expect(payload.packet.system.segments).toHaveLength(0);
  expect(payload.diagnostic_coverage).toMatchObject({complete:false,omitted_fields:1});
  const opaque=sanitizarCaptura('x'.repeat(TEXT_FIELD_LIMIT+1),undefined,{textosLongos:'segmentados'});
  expect(opaque).toMatchObject({complete:false,diagnostic_omission:'opaque_text_limit',segments:[]});
  query.mockClear();await capturarRevisao({query} as Queryable,{tenantId:'org',jobId:'job'},'reserva',
    {system:'x'.repeat(MAX_BYTES)},{textosLongos:'segmentados'});
  expect(query).toHaveBeenCalledTimes(1);
});

it('o corpo real não abre caminho para mídia/headers/segredos nos formatos dos provedores',()=>{
  const coverage={omitted_fields:0};
  const packet=sanitizarCaptura(JSON.stringify({headers:{Authorization:'Bearer PRIVADO'},input:[{type:'input_image',image_url:'RAW_IMAGE'},
    {type:'input_file',file_data:'RAW_FILE'},{inlineData:{data:'RAW_GEMINI',mimeType:'image/png'}},
    {type:'text',text:'Contexto factual preservado'}],api_key:'SECRET_KEY'}),coverage,{textosLongos:'segmentados'});
  const text=JSON.stringify(packet);
  for(const secret of ['PRIVADO','RAW_IMAGE','RAW_FILE','RAW_GEMINI','SECRET_KEY'])expect(text).not.toContain(secret);
  expect(text).toContain('Contexto factual preservado');expect(coverage.omitted_fields).toBeGreaterThan(0);
  expect(JSON.stringify(sanitizarCaptura(new Uint8Array([23,42]),coverage))).toContain('binary_excluded');
});

it('retenção fica desligada sem job/consentimento, em erro e após revogação',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[{enabled:true}]});const db={query} as Queryable;
  expect(await capturaRevisaoHabilitada(db,{tenantId:'org'})).toBe(false);expect(query).not.toHaveBeenCalled();
  query.mockResolvedValueOnce({rows:[{enabled:false}]});expect(await capturaRevisaoHabilitada(db,{tenantId:'org',jobId:'job'})).toBe(false);
  query.mockRejectedValueOnce(new Error('indisponível'));expect(await capturaRevisaoHabilitada(db,{tenantId:'org',jobId:'job'})).toBe(false);
  expect(await capturaRevisaoHabilitada(db,{tenantId:'org',jobId:'job'})).toBe(true);
  query.mockResolvedValue({rows:[{enabled:false}]});query.mockClear();
  const toJSON=vi.fn(()=>{throw new Error('revogado não serializa');});
  await capturarRevisao(db,{tenantId:'org',jobId:'job'},'reserva',{toJSON},{textosLongos:'segmentados'});
  expect(query).toHaveBeenCalledTimes(1);expect(toJSON).not.toHaveBeenCalled();
});
