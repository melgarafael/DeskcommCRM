---
titulo: "Retomada de negócio perdido como novo negócio, por funil"
impacto: capacidade_nova
secao: adicionado
---

**Retomada de negócio perdido como novo negócio, escolhida por funil.** O funil ganha `settings.reabertura` com dois modos: `mesmo_registro` (padrão, o comportamento de sempre) e `novo_negocio`. No segundo, mover um negócio encerrado para uma etapa aberta não o reabre — o arrasto, o lote, a IA, a automação e a tool MCP devolvem 409 `reabertura_cria_novo`, e a tela oferece "Retomar como novo negócio", que chama `POST /api/v1/leads/{id}/retomar`: nasce um lead novo com o mesmo contato, campos e tags copiados (o que se copia é configurável em `reabertura_campos`), `source = "retomada"` e `retomado_de_lead_id` apontando para o encerrado, que fica intacto, com o motivo dele. É por essa coluna que "quantas tentativas até fechar" passa a ser derivável. O clone entre funis também aceita origem encerrada nesse modo.

Liga-se em **Configurações › Funis**, na caixa "Negócio encerrado que volta abre um negócio novo". Retomar duas vezes a mesma origem devolve a retomada que já está aberta, e a etapa em que ela nasce aplica os campos obrigatórios do funil.

Não há ação para quem opera a VPS: a opção nasce desligada e nenhum dado existente é reescrito.

Contribuição de @webtecnica (#1712).
