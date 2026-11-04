import { expect, it, vi } from "vitest";
import { prepararFotosIneditas } from "./fotos-ineditas";
it("default off recusa antes de copiar arquivo ou reservar envio", async () => {
  const query=vi.fn(async()=>({rows:[{habilitado:false}]})); const copy=vi.fn();
  await expect(prepararFotosIneditas({query} as never,copy,{tenantId:"synthetic-org",conversationId:"synthetic-conversation",codigo:"P1",jobId:"synthetic-job",seq:1,restantes:3,body:"Detalhes"})).rejects.toMatchObject({code:"fotos_progressivas_desativadas"});
  expect(copy).not.toHaveBeenCalled(); expect(query).toHaveBeenCalledTimes(1);
});
it("quantidade inválida recusa antes de consultar produto ou copiar mídia", async () => {
  const query=vi.fn(async()=>({rows:[{habilitado:true}]})); const copy=vi.fn();
  await expect(prepararFotosIneditas({query} as never,copy,{tenantId:"synthetic-org",conversationId:"synthetic-conversation",codigo:"P1",jobId:"synthetic-job",seq:1,quantidade:4,restantes:5,body:"Detalhes"})).rejects.toMatchObject({code:"pedido_fotos_invalido"});
  expect(copy).not.toHaveBeenCalled(); expect(query).toHaveBeenCalledTimes(1);
});
