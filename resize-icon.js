const { Jimp } = require('jimp');
const pngToIco = require('png-to-ico').default;
const fs = require('fs');

async function resizeAndConvert() {
  try {
    const image = await Jimp.read('icon.png');
    image.resize({ w: 256, h: 256 });
    await image.write('icon_256.png');
    
    console.log('Imagem redimensionada para 256x256. Convertendo para .ico...');
    const buf = await pngToIco('icon_256.png');
    fs.writeFileSync('icon.ico', buf);
    
    console.log('Ícone gerado com sucesso em icon.ico!');
  } catch (error) {
    console.error('Erro ao converter ícone:', error);
  }
}

resizeAndConvert();
