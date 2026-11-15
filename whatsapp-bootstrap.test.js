const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildCompatibleAuthStore, installWhatsAppCompatibility } = require('./whatsapp-compat');
const { ExposeAuthStore } = require('whatsapp-web.js/src/util/Injected/AuthStore/AuthStore');

function authStoreHarness(socketModule) {
  let elapsed = 0;
  let waits = 0;
  const socket = { state: 'CONNECTED' };
  const context = {
    window: {
      require(name) {
        if (name === 'WAWebSocketModel') return socketModule(socket);
        return { Cmd: {}, Conn: {}, OfflineMessageHandler: {} };
      }
    },
    Date: { now: () => elapsed },
    setTimeout(resolve, ms) { elapsed += ms; waits++; resolve(); }
  };
  vm.createContext(context);
  const inject = vm.runInContext(`(${buildCompatibleAuthStore(ExposeAuthStore).toString()})`, context);
  return { context, socket, inject, waits: () => waits, elapsed: () => elapsed };
}

test('auth store waits for a temporarily null Socket module before reading it', async () => {
  let loads = 0;
  const harness = authStoreHarness(socket => ++loads <= 2 ? null : { Socket: socket });
  await harness.inject();
  assert.equal(harness.waits(), 2);
  assert.equal(harness.context.window.AuthStore.AppState, harness.socket);
});

test('auth store waits when the module loader throws or the Socket export is missing', async () => {
  let loads = 0;
  const harness = authStoreHarness(socket => {
    loads++;
    if (loads === 1) throw new Error('Module not loaded yet');
    return loads === 2 ? {} : { Socket: socket };
  });
  await harness.inject();
  assert.equal(harness.waits(), 2);
  assert.equal(harness.context.window.AuthStore.AppState, harness.socket);
});

test('ready Socket modules initialize the original auth store without delay', async () => {
  const harness = authStoreHarness(socket => ({ Socket: socket }));
  await harness.inject();
  assert.equal(harness.waits(), 0);
  assert.equal(harness.context.window.AuthStore.AppState, harness.socket);
  assert.ok(harness.context.window.AuthStore.RegistrationUtils);
});

test('a missing Socket module times out without creating a partial auth store', async () => {
  const harness = authStoreHarness(() => null);
  await assert.rejects(harness.inject(), /WhatsApp bootstrap timeout: WAWebSocketModel\.Socket unavailable/);
  assert.equal(harness.elapsed(), 30000);
  assert.equal(harness.context.window.AuthStore, undefined);
});

test('compatibility installation patches the auth store before loading Client and remains idempotent', () => {
  const clientPath = require.resolve('whatsapp-web.js/src/Client');
  assert.equal(require.cache[clientPath], undefined);
  installWhatsAppCompatibility();
  const authStore = require('whatsapp-web.js/src/util/Injected/AuthStore/AuthStore');
  const patched = authStore.ExposeAuthStore;
  assert.equal(patched.__socketCompat, true);
  assert.ok(require.cache[clientPath]);
  installWhatsAppCompatibility();
  assert.equal(authStore.ExposeAuthStore, patched);
});
