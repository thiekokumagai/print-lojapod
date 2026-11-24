const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { createAutoUpdate } = require('../auto-update');
const { createPrintJobs } = require('../print-jobs');

function setup({ busy = false } = {}) {
  const autoUpdater = new EventEmitter();
  autoUpdater.installs = [];
  autoUpdater.checks = 0;
  autoUpdater.quitAndInstall = (...args) => autoUpdater.installs.push(args);
  autoUpdater.checkForUpdates = () => {
    autoUpdater.checks += 1;
    return Promise.resolve();
  };
  const app = { isPackaged: true, getVersion: () => '1.0.47' };
  const state = { busy };
  const timers = [];
  const notes = [];
  const updater = createAutoUpdate({
    autoUpdater,
    app,
    isPrintBusy: () => state.busy,
    notify: (title, content) => notes.push({ title, content }),
    log: { log() {}, error() {} },
    setTimeoutFn: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
  });
  return { autoUpdater, app, state, timers, notes, updater };
}

test('mantém download automático e instalação ao fechar', () => {
  const { autoUpdater } = setup();
  assert.strictEqual(autoUpdater.autoDownload, true);
  assert.strictEqual(autoUpdater.autoInstallOnAppQuit, true);
});

test('sem impressão pendente: instala sozinho, silencioso e reabrindo o app', () => {
  const { autoUpdater, app } = setup();
  autoUpdater.emit('update-available', { version: '1.0.48' });
  autoUpdater.emit('update-downloaded', { version: '1.0.48' });
  assert.deepStrictEqual(autoUpdater.installs, [[true, true]]);
  assert.strictEqual(app.isQuiting, true);
});

test('com impressão pendente: espera e só instala depois que termina', () => {
  const { autoUpdater, state, timers } = setup({ busy: true });
  autoUpdater.emit('update-downloaded', { version: '1.0.48' });
  assert.strictEqual(autoUpdater.installs.length, 0);
  assert.strictEqual(timers.length, 1);
  assert.strictEqual(timers[0].ms, 30000);

  timers.shift().fn(); // ainda imprimindo
  assert.strictEqual(autoUpdater.installs.length, 0);
  assert.strictEqual(timers.length, 1);

  state.busy = false;
  timers.shift().fn();
  assert.deepStrictEqual(autoUpdater.installs, [[true, true]]);
  assert.strictEqual(timers.length, 0);
});

test('checagem manual só gera aviso não bloqueante, nunca instala duas vezes', () => {
  const { autoUpdater, notes, updater } = setup();
  updater.check(true);
  autoUpdater.emit('update-available', { version: '1.0.48' });
  assert.strictEqual(notes.length, 1);
  autoUpdater.emit('update-downloaded', { version: '1.0.48' });
  autoUpdater.emit('update-downloaded', { version: '1.0.48' });
  assert.strictEqual(autoUpdater.installs.length, 1);
});

test('erro do updater não instala e só avisa quando a checagem foi manual', () => {
  const { autoUpdater, notes, updater } = setup();
  autoUpdater.emit('error', new Error('offline'));
  assert.strictEqual(notes.length, 0);
  updater.check(true);
  autoUpdater.emit('error', new Error('offline'));
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(autoUpdater.installs.length, 0);
});

test('fora do .exe não checa atualização', () => {
  const { autoUpdater, app, updater } = setup();
  app.isPackaged = false;
  updater.check(false);
  assert.strictEqual(autoUpdater.checks, 0);
});

test('main.js não abre caixa modal no fluxo de atualização', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.doesNotMatch(src, /showMessageBox/);
  assert.doesNotMatch(src, /autoUpdater\.on\(/);
  const mod = fs.readFileSync(path.join(__dirname, '..', 'auto-update.js'), 'utf8');
  assert.doesNotMatch(mod, /dialog/);
});

test('print-jobs: ocupado durante a impressão e no respiro depois dela', () => {
  let t = 0;
  const jobs = createPrintJobs({ graceMs: 5000, staleMs: 60000, now: () => t });
  assert.strictEqual(jobs.isBusy(), false);
  const finish = jobs.begin();
  assert.strictEqual(jobs.isBusy(), true);
  t = 1000;
  finish();
  finish(); // idempotente
  assert.strictEqual(jobs.isBusy(), true);
  t = 6001;
  assert.strictEqual(jobs.isBusy(), false);
});

test('print-jobs: impressão travada não bloqueia o update para sempre', () => {
  let t = 0;
  const jobs = createPrintJobs({ graceMs: 5000, staleMs: 60000, now: () => t });
  jobs.begin();
  t = 59000;
  assert.strictEqual(jobs.isBusy(), true);
  t = 60001;
  assert.strictEqual(jobs.isBusy(), false);
});
