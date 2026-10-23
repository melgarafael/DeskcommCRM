import { describe, expect, it } from "vitest";

import { formatarDescricao, semFormatacao, TETO_DA_ABERTURA } from "./formatar-descricao";

// Texto real do catálogo da Turbo Kids, como a Meta devolve (out/2026).
const HILUX =
  "Mini Caminhonete Elétrica Toyota Hilux 2 Assentos 12V LicenciadoO mini carrinho elétrico Hilux Toyota original é um dos melhores carros licenciados do mercado, possui bateria de 12V, 4 rodas, suspensão e design realista.Modelado com base na popular Hilux, esta versão licenciada de brinquedo infantil possui motores potentes, controle remoto, farol, buzina, Rádio FM, Entrada Usb e Bluetooth.O Toyota Hilux é um exemplo perfeito de como você faz uma caminhonete robusta licenciado, um carro que qualquer criança terá orgulho em ter.Especificações:*Idade recomendada: A partir de 3 anos*Peso máximo recomendado (kg): 25kg*Dimensões aproximadas do produto (cm) AxLxC: 74cm x 92cm x 140cm*Marca: Importway*Importante: Carregar a Bateria por 12 Horas antes do 1° UsoCaracterísticas:*Produto Licenciado pela Toyota*Buzina*Faróis com Luz de LEDVocê está adquirindo:*01 Mini Caminhonete Elétrica Toyota Hilux 2 Assentos 12V Licenciado*01 Controle Remoto\"Compra Garantida\" - Ao Comprar conosco a sua compra é 100% garantida, o seu dinheiro está seguro até a entrega.*Imagens meramente ilustrativas";

const FICHA_COLADA =
  "Balanço Playground Infantil Com Cesta De BasqueteO balanço é ideal para crianças.Dimensões da embalagemAltura: 31cmLargura: 40cmProduto: NovoMarca: ImportwayModelo: BW252";

describe("formatarDescricao", () => {
  const hilux = formatarDescricao("Mini Carro Elétrico Caminhonete Toyota Hilux", HILUX)!;

  it("título com emoji, abertura curta e seções com emoji e itens em •", () => {
    const linhas = hilux.split("\n");
    expect(linhas[0]).toBe("🚗 Mini Caminhonete Elétrica Toyota Hilux 2 Assentos 12V Licenciado");
    expect(hilux).toContain("\n\nO mini carrinho elétrico Hilux Toyota original");
    expect(hilux).toContain("\n\n📋 Especificações:\n• Idade recomendada: A partir de 3 anos\n");
    expect(hilux).toContain("\n\n✨ Características:\n• Produto Licenciado pela Toyota\n");
    expect(hilux).toContain("\n\n📦 Você está adquirindo:\n• 01 Mini Caminhonete");
    expect(hilux).toContain('\n\n✅ "Compra Garantida"');
    expect(hilux.endsWith("⚠️ Imagens meramente ilustrativas")).toBe(true);
  });

  it("a abertura perde os parágrafos extras, mas é só corte — nada reescrito", () => {
    expect(hilux).not.toContain("Modelado com base na popular Hilux");
    expect(hilux).not.toContain("exemplo perfeito");
    const abertura = hilux.slice(0, hilux.indexOf("📋")).split("\n\n")[1]!;
    expect(abertura.length).toBeLessThanOrEqual(TETO_DA_ABERTURA);
    expect(semFormatacao(HILUX)).toContain(semFormatacao(abertura));
  });

  it("as seções da ficha não perdem nem trocam uma letra", () => {
    const secoes = hilux.slice(hilux.indexOf("📋"));
    const original = HILUX.slice(HILUX.indexOf("Especificações:"));
    expect(semFormatacao(secoes)).toBe(semFormatacao(original));
  });

  it("ficha 'Campo: valor' grudada vira itens; grafia de marca fica inteira", () => {
    const f = formatarDescricao("Balanço Playground", FICHA_COLADA)!;
    // A ficha sem título de seção NÃO pode ser cortada junto com a abertura.
    expect(f).toContain("Dimensões da embalagem\n• Altura: 31cm\n• Largura: 40cm");
    expect(f).toContain("• Marca: Importway\n• Modelo: BW252");
    expect(formatarDescricao("x", "Brinquedo com som ImportWay e tela AxLxC")).not.toMatch(/Import\nWay|Ax\nLxC/);
    // Medida sem valor logo depois de um título grudado — o caso real do BW207PT.
    const bw207 = formatarDescricao(
      "Quadriciclo",
      "Quadriciclo 12VCom ele a diversão.Especificações:*Dimensões (cm) AxLxC:*Marca: Importway",
    )!;
    expect(bw207).toContain("• Dimensões (cm) AxLxC:\n• Marca: Importway");
  });

  it("é estável: a mesma entrada dá a mesma saída, e texto já formatado não muda", () => {
    expect(formatarDescricao("Mini Carro Elétrico Caminhonete Toyota Hilux", HILUX)).toBe(hilux);
    expect(formatarDescricao("x", "Linha um\n\nLinha dois")).toBe("Linha um\n\nLinha dois");
    expect(formatarDescricao("x", null)).toBeNull();
  });
});
