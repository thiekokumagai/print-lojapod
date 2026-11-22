const { app, Tray, Menu, nativeImage, dialog, BrowserWindow, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { io } = require('socket.io-client');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let tray = null;
let statusText = 'Desconectado';
let currentPrinter = 'Buscando...';
let availablePrinters = [];
let socket = null;
let activationWindow = null;
let isManualUpdateCheck = false;
let isCheckingForUpdates = false;

// Esconde o ícone na dock do macOS (se for rodar no mac)
if (app.dock) app.dock.hide();

// Configurar para abrir junto com o Windows automaticamente
app.setLoginItemSettings({
  openAtLogin: true,
  path: app.getPath('exe'),
});

const API_URL = process.env.API_URL || 'https://api.podipedir.com.br';

function getConfigPath() {
  return path.join(app.getPath('userData'), 'print_agent_config.json');
}

// Ao renomear o app (Loja Pod -> Podi Pedir) a pasta userData pode mudar.
// Copia a configuração/ativação da pasta antiga para não exigir nova ativação.
function migrateOldConfig() {
  try {
    const target = getConfigPath();
    if (fs.existsSync(target)) return;
    const appData = app.getPath('appData');
    for (const oldName of ['Loja Pod', 'print-agent']) {
      const oldPath = path.join(appData, oldName, 'print_agent_config.json');
      if (oldPath !== target && fs.existsSync(oldPath)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(oldPath, target);
        console.log('Configuração migrada de', oldPath);
        return;
      }
    }
  } catch (err) {
    console.error('Erro ao migrar config antiga:', err);
  }
}
migrateOldConfig();

function loadConfig() {
  try {
    const data = fs.readFileSync(getConfigPath(), 'utf8');
    return { paper_width: '80mm', ...JSON.parse(data) };
  } catch (err) {
    return { token: '', store_id: '', store_name: '', printer: 'auto', paper_width: '80mm' };
  }
}

function saveConfig(newConfig) {
  try {
    const current = loadConfig();
    const merged = { ...current, ...newConfig };
    fs.writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2));
    return merged;
  } catch (err) {
    console.error('Erro ao salvar config:', err);
  }
}

let config = loadConfig();
let PRINTER_INTERFACE = config.printer || 'auto';

function updateTray() {
  if (!tray) return;
  const storeName = config.store_name ? ` (${config.store_name})` : '';

  const contextMenu = Menu.buildFromTemplate([
    { label: `Impressora - Podi Pedir (v${app.getVersion()})`, enabled: false },
    { type: 'separator' },
    { label: `Status: ${statusText}${storeName}`, enabled: false },
    { label: `Impressora: ${currentPrinter}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Alterar Token / Trocar Loja',
      click: () => {
        openActivationWindow();
      },
    },
    {
      label: 'Selecionar Impressora',
      submenu: availablePrinters.map((printerName) => ({
        label: printerName,
        type: 'radio',
        checked: currentPrinter === printerName,
        click: () => {
          PRINTER_INTERFACE = `printer:${printerName}`;
          currentPrinter = printerName;
          saveConfig({ printer: PRINTER_INTERFACE });
          updateTray();
        },
      })),
    },
    {
      label: 'Largura da Bobina',
      submenu: [
        {
          label: '80 mm (Padrão)',
          type: 'radio',
          checked: (config.paper_width || '80mm') === '80mm',
          click: () => {
            config.paper_width = '80mm';
            saveConfig({ paper_width: '80mm' });
            updateTray();
          },
        },
        {
          label: '58 mm (Maquininha / POS)',
          type: 'radio',
          checked: config.paper_width === '58mm',
          click: () => {
            config.paper_width = '58mm';
            saveConfig({ paper_width: '58mm' });
            updateTray();
          },
        },
      ],
    },
    { type: 'separator' },
    {
      label: 'Testar Impressão',
      click: () => {
        imprimirPedido({
          id: 'TESTE-' + Date.now().toString().slice(-4),
          customerName: 'Cliente Teste',
          customerPhone: '(00) 00000-0000',
          items: [{ productName: 'Item de Teste de Impressão', quantity: 1, price: 10.0 }],
          totalOrder: 10.0,
          paymentMethod: 'PIX',
          street: 'Rua Exemplo',
          number: '123',
          neighborhood: 'Bairro',
        });
      },
    },
    { type: 'separator' },
    {
      label: 'Verificar atualizações',
      click: () => {
        checkForUpdates(true);
      },
    },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        app.isQuiting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
  tray.setToolTip(`Podi Pedir Impressora - ${statusText}${storeName}`);
}

function loadAvailablePrinters() {
  try {
    const output = execSync('powershell "Get-Printer | Select-Object -ExpandProperty Name"', { encoding: 'utf-8' });
    availablePrinters = output.split('\n').map((p) => p.trim()).filter((p) => p.length > 0);
  } catch (err) {
    availablePrinters = [];
  }
}

function autoDetectPrinter() {
  if (availablePrinters.length === 0) loadAvailablePrinters();
  const keywords = ['POS', 'Receipt', 'Bematech', 'Epson', 'Daruma', 'Elgin', 'Thermal', 'Generic'];
  let foundPrinter = null;

  for (const p of availablePrinters) {
    for (const kw of keywords) {
      if (p.toLowerCase().includes(kw.toLowerCase())) {
        foundPrinter = p;
        break;
      }
    }
    if (foundPrinter) break;
  }

  if (foundPrinter) {
    return `printer:${foundPrinter}`;
  } else if (availablePrinters.length > 0) {
    return `printer:${availablePrinters[0]}`;
  }
  return 'printer:Nenhuma';
}

function connectSocket() {
  if (socket) {
    socket.disconnect();
  }

  config = loadConfig();
  if (!config.token) {
    statusText = '⚠️ Aguardando Token';
    updateTray();
    openActivationWindow();
    return;
  }

  socket = io(API_URL, {
    auth: { token: config.token },
    query: { token: config.token, store_id: config.store_id },
    transports: ['websocket'],
  });

  socket.on('connect', () => {
    statusText = '✅ Conectado';
    updateTray();
  });

  socket.on('disconnect', () => {
    statusText = '⚠️ Desconectado';
    updateTray();
  });

  socket.on('auth_error', (data) => {
    statusText = '❌ Token Inválido';
    updateTray();
    openActivationWindow(data?.message || 'Token de impressão rejeitado pelo servidor.');
  });

  socket.on('novo_pedido_imprimir', async (pedido) => {
    imprimirPedido(pedido);
  });
}

function openActivationWindow(initialError = '') {
  if (activationWindow) {
    activationWindow.focus();
    return;
  }

  if (app.dock) app.dock.show();

  activationWindow = new BrowserWindow({
    width: 440,
    height: 480,
    resizable: false,
    title: 'Ativação da Impressora - Podi Pedir',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  const htmlContent = `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8" />
      <title>Ativar Impressora</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 24px; display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
        h2 { font-size: 18px; margin-top: 0; color: #1e293b; font-weight: 700; }
        p { font-size: 13px; color: #64748b; line-height: 1.4; margin-bottom: 20px; }
        label { font-size: 12px; font-weight: 600; color: #475569; display: block; margin-bottom: 6px; }
        input { width: 100%; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 14px; font-family: monospace; font-weight: bold; box-sizing: border-box; outline: none; transition: border-color 0.2s; }
        input:focus { border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79,70,229,0.15); }
        button { margin-top: 20px; width: 100%; background: #4f46e5; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: background 0.2s; }
        button:hover { background: #4338ca; }
        button:disabled { opacity: 0.6; cursor: not-allowed; }
        .error { margin-top: 12px; padding: 10px; background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; font-size: 12px; border-radius: 6px; display: ${initialError ? 'block' : 'none'}; }
        .info { font-size: 11px; color: #94a3b8; margin-top: auto; text-align: center; }
      </style>
    </head>
    <body>
      <h2>🖨️ Ativação da Impressora</h2>
      <p>Insira o <strong>Token da Impressora</strong> gerado no Painel Admin da sua loja para conectar o balcão ao sistema.</p>

      <label for="token">Token de Ativação (ex: PRT-XXXXXXX)</label>
      <input type="text" id="token" placeholder="Cole seu token aqui..." value="${config.token || ''}" />
      
      <div id="error" class="error">${initialError}</div>

      <button id="btn" onclick="submitToken()">Ativar Impressora</button>

      <div class="info">Podi Pedir Agent v1.0.0</div>

      <script>
        const { ipcRenderer } = require('electron');

        function submitToken() {
          const token = document.getElementById('token').value.trim();
          const errDiv = document.getElementById('error');
          const btn = document.getElementById('btn');

          if (!token) {
            errDiv.innerText = 'Por favor, digite ou cole o token da sua loja.';
            errDiv.style.display = 'block';
            return;
          }

          errDiv.style.display = 'none';
          btn.disabled = true;
          btn.innerText = 'Validando Token...';

          ipcRenderer.send('validate-token', token);
        }

        ipcRenderer.on('token-result', (event, res) => {
          const errDiv = document.getElementById('error');
          const btn = document.getElementById('btn');
          btn.disabled = false;
          btn.innerText = 'Ativar Impressora';

          if (!res.success) {
            errDiv.innerText = res.message || 'Token inválido ou não encontrado.';
            errDiv.style.display = 'block';
          }
        });
      </script>
    </body>
    </html>
  `;

  activationWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);

  activationWindow.on('closed', () => {
    activationWindow = null;
    if (app.dock) app.dock.hide();
  });
}

ipcMain.on('validate-token', async (event, token) => {
  try {
    const cleanToken = token ? token.trim() : '';
    const response = await fetch(`${API_URL}/api/stores/print-agent/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: cleanToken }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      event.sender.send('token-result', {
        success: false,
        message: errData.message || 'Token de impressão inválido.',
      });
      return;
    }

    const data = await response.json();
    saveConfig({
      token: data.printToken || cleanToken,
      store_id: data.storeId,
      store_name: data.storeName,
    });

    event.sender.send('token-result', { success: true });

    if (activationWindow) {
      activationWindow.close();
    }

    connectSocket();
  } catch (error) {
    event.sender.send('token-result', {
      success: false,
      message: 'Erro ao conectar ao servidor. Verifique sua conexão com a internet.',
    });
  }
});

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function imprimirPedido(pedido) {
  try {
    if (pedido.status === 'CANCELLED' || pedido.status === 'cancelado' || String(pedido.status).toUpperCase() === 'CANCELED') {
      console.log(`Pedido ${pedido.id} cancelado. Ignorando impressão.`);
      return;
    }

    if (!currentPrinter || currentPrinter === 'Buscando...' || currentPrinter === 'Nenhuma') {
      throw new Error('Nenhuma impressora válida selecionada.');
    }

    // Montar o HTML do Cupom
    let itensHtml = '';
    const listaItens = pedido.items || pedido.orderItems || pedido.itens || [];
    
    const is58mm = (config.paper_width === '58mm');
    const showProductPrices = pedido.showProductPrices !== false;

    if (listaItens && listaItens.length > 0) {
      listaItens.forEach(item => {
        let valorNumerico = Number(item.price || item.preco || item.unitPrice || 0);
        let qtd = item.quantidade || item.quantity || 1;
        
        // Multiplica pela quantidade para exibir o total do item
        let valorTotalItem = valorNumerico * qtd;
        
        // Sempre formata com 2 casas decimais e vírgula
        let precoFormatado = valorTotalItem.toFixed(2).replace('.', ',');
          
        let nome = item.nome || item.productName || 'Produto Genérico';
        let variacao = item.variation || item.variationString || item.variacao || '';
        let categoria = item.categoryName || item.product?.category?.title || item.categoria || '';
        let categoriaPrefix = categoria ? `[${categoria}] ` : '';
        let isBump = !!(item.isOrderBump || item.orderBumpId);
        let bumpPrefix = isBump ? `[PEÇA TAMBÉM] ` : '';
        let nomeFormatado = `${qtd}x ${bumpPrefix}${categoriaPrefix}${nome}`;
        if (variacao && String(variacao).trim() !== '') {
          nomeFormatado += `<br/><span class="bold">(${String(variacao).trim()})</span>`;
        }

        // Se for combo, listar componentes detalhados para separação e conferência
        const isCombo = item.isCombo || (item.comboSnapshot && item.comboSnapshot.items);
        if (isCombo && item.comboSnapshot && Array.isArray(item.comboSnapshot.items)) {
          nomeFormatado += `<div style="font-size: 11px; padding-left: 8px; margin-top: 2px; color: #333;">`;
          item.comboSnapshot.items.forEach(comp => {
            const compQtd = (comp.quantity || 1) * qtd;
            const compNome = comp.productName || 'Produto';
            const compVar = comp.variation ? ` (${comp.variation})` : '';
            nomeFormatado += `• ${compQtd}x ${compNome}${compVar}<br/>`;
          });
          nomeFormatado += `</div>`;
        }

        // Se for produto customizado (composição por etapas), listar etapas e opções escolhidas
        const isCustom = item.isCustomized || (item.customizationSnapshot && item.customizationSnapshot.stages);
        if (isCustom && item.customizationSnapshot && Array.isArray(item.customizationSnapshot.stages)) {
          const fontSize = is58mm ? '9.5px' : '10.5px';
          const paddingLeft = is58mm ? '4px' : '8px';
          nomeFormatado += `<div style="font-size: ${fontSize}; padding-left: ${paddingLeft}; margin-top: 2px; line-height: 1.25; word-break: break-word; overflow-wrap: break-word; color: #222;">`;
          item.customizationSnapshot.stages.forEach(stage => {
            const safeGroupName = escapeHtml(stage.groupName || 'Etapa');
            const opcoes = (stage.options || []).map(opt => {
              const optQtd = opt.quantity > 1 ? `${opt.quantity}x ` : '';
              const safeOptName = escapeHtml(opt.name || 'Opção');
              const optPrice = (showProductPrices && opt.totalPrice > 0) ? ` (+R$ ${Number(opt.totalPrice).toFixed(2)})` : '';
              return `${optQtd}${safeOptName}${optPrice}`;
            }).join(', ');
            if (opcoes) {
              nomeFormatado += `<div style="margin-top: 1px; word-break: break-word; overflow-wrap: break-word;">• <b>[${safeGroupName}]</b>: ${opcoes}</div>`;
            }
          });
          nomeFormatado += `</div>`;
        }

        // Observação opcional por item (ex.: sem cebola)
        const itemObs = typeof item.observation === 'string' ? item.observation.trim() : '';
        if (itemObs) {
          const obsFontSize = is58mm ? '9.5px' : '10.5px';
          const obsPaddingLeft = is58mm ? '4px' : '8px';
          nomeFormatado += `<div style="font-size: ${obsFontSize}; padding-left: ${obsPaddingLeft}; margin-top: 2px; line-height: 1.25; word-break: break-word; overflow-wrap: break-word; color: #111;"><b>Obs:</b> ${escapeHtml(itemObs)}</div>`;
        }
        
        if (showProductPrices) {
          itensHtml += `
            <div class="item-row">
              <div class="item-name">${nomeFormatado}</div>
              <div class="item-price bold">${precoFormatado}</div>
            </div>
          `;
        } else {
          itensHtml += `
            <div class="item-row">
              <div class="item-name">${nomeFormatado}</div>
            </div>
          `;
        }
      });
    } else {
      itensHtml = `
        <div class="item-row"><div class="item-name">Nenhum item detectado</div><div class="item-price bold">0</div></div>
      `;
    }

    // Formatadores
    const formatarData = (dataIso) => {
      if (!dataIso) return new Date().toLocaleDateString('pt-BR');
      return new Date(dataIso).toLocaleDateString('pt-BR');
    };
    
    const numeroPedido = pedido.orderNumber || pedido.id || Math.floor(Math.random() * 1000);
    const dataPedido = formatarData(pedido.createdAt);
    const nomeCliente = pedido.customerName || pedido.cliente_nome || 'Nao informado';
    const telefoneCliente = pedido.customerPhone || pedido.telefone || '';
    
    // Endereço
    let enderecoHtml = '';
    if (pedido.deliveryModality === 'STORE_PICKUP') {
      enderecoHtml = `<div class="info-block" style="font-size: 11px;"><span class="bold">Entrega:</span> Retirada na loja</div>`;
    } else {
      const temEndereco = pedido.street || pedido.deliveryAddress || pedido.endereco;
      if (temEndereco) {
        let rua = pedido.street || pedido.deliveryAddress || pedido.endereco || '';
        let num = pedido.number || pedido.deliveryNumber || pedido.numero || '';
        let comp = pedido.complement || pedido.deliveryComplement || pedido.complemento || '';
        let bairro = pedido.neighborhood || pedido.deliveryNeighborhood || pedido.bairro || '';
        
        let enderecoFormatado = `${rua}, ${num}`;
        if (comp) {
          enderecoFormatado += ` - ${comp}`;
        }
        if (bairro) {
          enderecoFormatado += ` - ${bairro}`;
        }
        enderecoHtml = `<div class="info-block"><span class="bold">Entrega:</span> ${enderecoFormatado}</div>`;
      }
    }

    let observacaoHtml = '';
    const observacao = pedido.observation || pedido.observacao || '';
    if (observacao) {
      observacaoHtml = `<div class="info-block"><span class="bold" style="background: yellow;">Obs:</span> ${observacao}</div>`;
    }

    // Pagamento e Parcelas
    let pagamentoHtml = '';
    const statusPagamento = pedido.paymentStatus === 'PAID' ? 'PAGO' : (pedido.paymentStatus || '');
    const metodoPagamento = pedido.paymentMethod || '';
    const parcelas = pedido.paymentInstallments || pedido.installments || 1;
    
    const tradutorMetodos = {
      'CREDIT_CARD': 'Cartão de Crédito',
      'credit_card': 'Cartão de Crédito',
      'credit': 'Cartão de Crédito',
      'debit': 'Cartão de Débito',
      'DEBIT_CARD': 'Cartão de Débito',
      'PIX': 'Pix',
      'pix': 'Pix',
      'CASH': 'Dinheiro',
      'cash': 'Dinheiro',
      'money': 'Dinheiro',
      'meal_voucher': 'Vale Refeição',
      'vale_refeicao': 'Vale Refeição',
      'vale refeição': 'Vale Refeição',
      'vale refeicao': 'Vale Refeição',
      'food_voucher': 'Vale Alimentação',
      'vale_alimentacao': 'Vale Alimentação',
      'vale alimentação': 'Vale Alimentação',
      'vale alimentacao': 'Vale Alimentação'
    };
    
    if (statusPagamento === 'PAGO') {
      pagamentoHtml += `<div class="bold" style="font-size: 11px; margin-top: 3px;">PAGO</div>`;
    }
    
    if (metodoPagamento) {
      let chavePagamento = String(metodoPagamento).toLowerCase();
      let txtCartao = tradutorMetodos[metodoPagamento] || tradutorMetodos[chavePagamento] || metodoPagamento;
      if (parcelas > 1) txtCartao += ` em ${parcelas}x`;
      pagamentoHtml += `<div class="bold" style="margin-top: 4px; font-size: 13px;">Forma de Pagamento: ${txtCartao}</div>`;
      
      if ((chavePagamento === 'cash' || chavePagamento === 'dinheiro') && (Number(pedido.changeAmount) > 0 || Number(pedido.change_for) > 0)) {
         let amountProv = Number(pedido.amountProvided || pedido.change_for || 0).toFixed(2).replace('.', ',');
         let changeAmt = Number(pedido.changeAmount || 0).toFixed(2).replace('.', ',');
         pagamentoHtml += `<div class="bold" style="font-size: 11px;">Troco para: R$ ${amountProv}</div>`;
         pagamentoHtml += `<div class="bold" style="font-size: 12px;">Valor do troco: R$ ${changeAmt}</div>`;
      }
    } else {
      pagamentoHtml += `<div class="bold" style="margin-top: 4px; font-size: 13px;">Forma de Pagamento: Não informado</div>`;
    }

    // Frete e Total
    let freteDisplay = '';
    if (pedido.deliveryModality === 'STORE_PICKUP') {
      freteDisplay = 'Retirada na loja';
    } else if (Number(pedido.freight) === -1) {
      freteDisplay = 'A combinar';
    } else if (Number(pedido.freight) === 0 || (pedido.coupon && pedido.coupon.type === 'FREE_SHIPPING')) {
      freteDisplay = 'Grátis';
    } else {
      freteDisplay = `R$ ${Number(pedido.freight || 0).toFixed(2).replace('.', ',')}`;
    }
    
    const valorTotal = Number(pedido.totalOrder || pedido.total || 0).toFixed(2).replace('.', ',');
    let totalHtml = `
      <div class="total-row" style="margin-top: 8px;">
        <div style="font-size: 11px;">Frete: ${freteDisplay}</div>
      </div>
    `;
    if (Number(pedido.totalOrder || pedido.total || 0) > 0 && statusPagamento !== 'PAGO') {
      totalHtml += `
        <div class="total-row" style="margin-top: 4px;">
          <div class="bold" style="font-size: 11px;">Valor Total</div>
          <div class="bold" style="font-size: 11px;">R$ ${valorTotal}</div>
        </div>
      `;
    }

    const titleText = config.store_name || 'Podi Pedir';

    const paperWidth = is58mm ? '170px' : '255px';
    const bodyFontSize = is58mm ? '10px' : '11px';
    const titleFontSize = is58mm ? '12px' : '13px';

    const receiptHtml = `
      <html>
      <head>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
          * { box-sizing: border-box; }
          @page { margin: 0; }
          body { 
            font-family: 'Inter', Arial, sans-serif; 
            font-size: ${bodyFontSize}; 
            width: ${paperWidth};
            margin: 0; 
            padding: 5px 5px;
            color: black;
            line-height: 1.2;
          }
          .center { text-align: center; }
          .bold { font-weight: bold; }
          .title { font-size: ${titleFontSize}; font-weight: bold; margin-bottom: 8px; }
          .info-block { margin-top: 8px; }
          .item-row { display: flex; justify-content: space-between; margin-top: 5px; align-items: flex-start; word-break: break-word; }
          .item-name { flex: 1; padding-right: ${is58mm ? '8px' : '15px'}; word-break: break-word; overflow-wrap: break-word; }
          .item-price { white-space: nowrap; }
          .total-row { display: flex; justify-content: space-between; margin-bottom: 8px; }
          .footer { margin-top: 10px; font-size: 11px; }
        </style>
      </head>
      <body>
        <div class="center title">${titleText}</div>
        
        <div>
          <span class="bold">Pedido:</span> ${numeroPedido}<br>
          <span class="bold">Data:</span> ${dataPedido}<br>
          <span class="bold">Nome:</span> ${nomeCliente}<br>
          ${telefoneCliente}
        </div>

        ${itensHtml}
        ${enderecoHtml}
        ${observacaoHtml}
        ${totalHtml}
        ${pagamentoHtml}

        <div class="footer">Obrigado pela preferência!</div>
      </body>
      </html>
    `;

    // Criar janela oculta para imprimir
    let printWindow = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: true }
    });

    printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(receiptHtml)}`);

    printWindow.webContents.on('did-finish-load', () => {
      printWindow.webContents.print({
        silent: true,
        printBackground: true,
        deviceName: currentPrinter
      }, (success, failureReason) => {
        if (!success) {
          console.error('Falha ao imprimir:', failureReason);
          dialog.showErrorBox('Erro na Impressora', `Falha técnica ao imprimir o pedido: ${failureReason}`);
        } else {
          console.log('Impressão enviada com sucesso!');
          if (pedido.id && socket) {
            socket.emit('marcar_como_impresso', pedido.id);
          }
        }
        // Fechar janela após imprimir
        printWindow.close();
      });
    });

  } catch (error) {
    console.error(`Erro ao tentar imprimir:`, error.message);
    dialog.showErrorBox(
      'Erro de Impressão',
      `Não foi possível imprimir o pedido #${pedido.id}.\n\nDetalhes do erro: ${error.message}\n\nVerifique se a impressora correta está selecionada no relógio e se ela está ligada.`
    );
  }
}


const UPDATE_CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 horas

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    isCheckingForUpdates = true;
  });

  autoUpdater.on('update-available', (info) => {
    console.log('Nova versão disponível:', info && info.version);
    if (isManualUpdateCheck) {
      isManualUpdateCheck = false;
      dialog.showMessageBox({
        type: 'info',
        title: 'Atualização disponível',
        message: `Nova versão (v${info.version}) encontrada.`,
        detail: 'O download foi iniciado em segundo plano. Avisaremos quando estiver pronta para instalar.',
        buttons: ['OK'],
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    isCheckingForUpdates = false;
    if (isManualUpdateCheck) {
      isManualUpdateCheck = false;
      dialog.showMessageBox({
        type: 'info',
        title: 'Sem atualizações',
        message: `Você já está na versão mais recente (v${app.getVersion()}).`,
        buttons: ['OK'],
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    isCheckingForUpdates = false;
    isManualUpdateCheck = false;
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Atualização pronta',
        message: `A versão v${info.version} foi baixada.`,
        detail: 'Deseja reiniciar o Podi Pedir agora para instalar a atualização? Se preferir, ela será instalada ao fechar o programa.',
        buttons: ['Reiniciar e atualizar', 'Depois'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          app.isQuiting = true;
          autoUpdater.quitAndInstall();
        }
      })
      .catch((err) => {
        console.error('Erro ao exibir diálogo de atualização:', err);
      });
  });

  autoUpdater.on('error', (err) => {
    isCheckingForUpdates = false;
    console.error('Erro ao verificar atualizações:', err && err.message ? err.message : err);
    if (isManualUpdateCheck) {
      isManualUpdateCheck = false;
      dialog.showMessageBox({
        type: 'warning',
        title: 'Erro ao verificar atualizações',
        message: 'Não foi possível verificar atualizações agora.',
        detail: 'Verifique sua conexão com a internet e tente novamente mais tarde.',
        buttons: ['OK'],
      });
    }
  });
}

function checkForUpdates(manual = false) {
  if (!app.isPackaged) {
    if (manual) {
      dialog.showMessageBox({
        type: 'info',
        title: 'Modo desenvolvimento',
        message: 'A verificação de atualizações só funciona na versão instalada (.exe).',
        buttons: ['OK'],
      });
    }
    return;
  }

  if (isCheckingForUpdates) return;
  isManualUpdateCheck = manual;

  autoUpdater.checkForUpdates().catch((err) => {
    isCheckingForUpdates = false;
    console.error('Falha na checagem de atualizações:', err && err.message ? err.message : err);
    if (isManualUpdateCheck) {
      isManualUpdateCheck = false;
      dialog.showMessageBox({
        type: 'warning',
        title: 'Erro ao verificar atualizações',
        message: 'Não foi possível verificar atualizações agora.',
        buttons: ['OK'],
      });
    }
  });
}

app.whenReady().then(() => {
  const iconPath = path.join(__dirname, 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);

  loadAvailablePrinters();

  if (PRINTER_INTERFACE === 'auto' || PRINTER_INTERFACE.includes('NomeDaSuaImpressora')) {
    PRINTER_INTERFACE = autoDetectPrinter();
    saveConfig({ printer: PRINTER_INTERFACE });
  }

  currentPrinter = PRINTER_INTERFACE.replace('printer:', '');
  updateTray();

  connectSocket();

  setupAutoUpdater();
  setTimeout(() => checkForUpdates(false), 10000);
  setInterval(() => checkForUpdates(false), UPDATE_CHECK_INTERVAL_MS);
});

app.on('window-all-closed', (e) => e.preventDefault());
