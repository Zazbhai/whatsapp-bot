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
  const message = require('whatsapp-web.js/src/structures/Message');
  assert.equal(require.cache[clientPath], undefined);
  installWhatsAppCompatibility();
  const authStore = require('whatsapp-web.js/src/util/Injected/AuthStore/AuthStore');
  const patched = authStore.ExposeAuthStore;
  assert.equal(patched.__socketCompat, true);
  assert.equal(message.prototype.downloadMedia.__mediaMimeCompat, true);
  assert.match(message.prototype.downloadMedia.toString(), /mimetype:\s*msg\.mimetype/);
  assert.ok(require.cache[clientPath]);
  installWhatsAppCompatibility();
  assert.equal(authStore.ExposeAuthStore, patched);
});

test('patched media downloads pass the resolved MIME type to WhatsApp decryption', async () => {
  const Message = require('whatsapp-web.js/src/structures/Message');
  installWhatsAppCompatibility();
  let downloadOptions;
  const storedMessage = {
    mediaData: { mediaStage: 'RESOLVED' },
    directPath: '/media', encFilehash: 'enc-hash', filehash: 'hash',
    mediaKey: 'key', mediaKeyTimestamp: 1, type: 'ptt',
    mimetype: 'audio/ogg; codecs=opus', filename: 'voice.ogg', size: 3
  };
  const client = { pupPage: { evaluate: async (fn, id) => {
    const context = {
      AbortController,
      Buffer,
      window: {
        require: name => name === 'WAWebCollections'
          ? { Msg: { get: key => key === id ? storedMessage : null } }
          : { downloadManager: { downloadAndMaybeDecrypt: async options => {
            downloadOptions = options;
            return new Uint8Array([1, 2, 3]).buffer;
          } } },
        WWebJS: { arrayBufferToBase64Async: async data => Buffer.from(data).toString('base64') }
      }
    };
    return vm.runInNewContext(`(${fn.toString()})(${JSON.stringify(id)})`, context);
  } } };
  const media = await Message.prototype.downloadMedia.call({
    hasMedia: true,
    id: { _serialized: 'voice-id' },
    client
  });
  assert.equal(downloadOptions.mimetype, 'audio/ogg; codecs=opus');
  assert.equal(media.data, 'AQID');
});
