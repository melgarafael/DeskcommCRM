import { describe,expect,it } from "vitest";
import { divergenciaExplicitaDoPedido as divergencia,type PropostaDeAgenda } from "./pedido";
const op:PropostaDeAgenda={acao:"criar",servico:"Consulta",inicio:"2026-10-16T17:40Z",fuso:"America/Sao_Paulo",dia:"2026-10-16",horario:"14:40",quando:"Sex 16/10 às 14:40",beneficiarios:["contato_atendido"]};
describe("piso mecânico só veta; não autoriza pela presença de HH:mm",()=>{
  it("pedido explícito e instante local divergente",()=>{
    expect(divergencia("Quero às 14h40 de hoje, 16/10. Pode agendar para mim.",{...op,horario:"11:40"})).toBe("horario");
    expect(divergencia("Pode agendar às 14:40 do dia 17/10?",op)).toBe("data");
    expect(divergencia("Quero dia 16/10/2027 às 14:40",op)).toBe("data");
  });
  it.each(["14h40","Quais horários?","Quero às 14h40 ou 16h.","Não quero às 14h40.","Se tiver 14h40, me avise.","Quero às 17:40 UTC.","Quero 2026-10-16T17:40:00Z.","Quero às 17:40:00Z."])("sem escolha inequívoca local não fabrica veto nem autorização: %s",texto=>{
    expect(divergencia(texto,op)).toBeNull();
  });
  it("escolha correspondente também devolve null, nunca um positivo de autorização",()=>{
    expect(divergencia("Quero às 14h40 de hoje, 16/10. Pode agendar para mim.",op)).toBeNull();
  });
});
