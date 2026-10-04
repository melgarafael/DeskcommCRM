---
impacto: capacidade_nova
secao: adicionado
titulo: Leads de formulário podem ser repartidos em rodízio entre os corretores de um grupo
---
Quem recebe leads de um formulário (Meta Lead Ads, Elementor, RD Station, Respondi ou qualquer webhook de captação) agora pode cadastrar um grupo de atendentes e uma regra que liga a origem do lead ao grupo — por fonte de webhook, por campanha (`utm_campaign`) ou por funil. Cada lead novo que casa a regra ganha dono pelo próximo atendente ativo do grupo, na ordem, e o dono recebe o aviso "lead atribuído a você". Pausar um atendente no grupo (por exemplo, de férias) o pula sem tirá-lo da fila, e quem sai da organização deixa de receber.

É opt-in: quem não cadastra nenhuma regra não vê diferença nenhuma, e o rodízio nunca impede o lead de entrar. O que existe hoje é o banco — as tabelas `lead_routing_groups`, `lead_routing_group_members` e `lead_routing_rules` se preenchem pela API, e a tela de configuração fica para uma próxima versão. Complementa o rodízio de conversas por canal, que continua como está. Nenhuma ação do operador.

Contribuição de @hamiltonviana (refs #2041).
