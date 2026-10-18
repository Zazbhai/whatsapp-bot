// WhatsApp's July 2026 update also exposes message/Wid IDs as $1.
// Apply the upstream compatibility changes before Client captures LoadUtils.
function buildCompatibleUtils(loadUtils) {
  let source = loadUtils.toString();
  for (const name of ['chat.lastReceivedKey', 'chat.id', 'newMsgKey', 'msg.id.remote']) {
    source = source.replaceAll(`${name}._serialized`, `(${name}._serialized || ${name}.$1)`);
  }
  source = source.replace(
    'delete msg.pendingAckUpdate;',
    `if (msg.id && msg.id._serialized == null && msg.id.$1 != null) {
      msg.id = Object.assign({}, msg.id, { _serialized: msg.id.$1 });
    }
    delete msg.pendingAckUpdate;`
  );
  // MediaData.__x_id collides with the outgoing Msg's own id.
  source = source.replace('if (botOptions) {', 'if (message.__x_id) delete message.__x_id;\n        if (botOptions) {');
  // WhatsApp removed canCheckStatusRankingPosterGating in WAWebStatusGatingUtils
  source = source.replaceAll(
    'window.require(\'WAWebStatusGatingUtils\').canCheckStatusRankingPosterGating()',
    '(typeof window.require(\'WAWebStatusGatingUtils\')?.canCheckStatusRankingPosterGating === \'function\' ? window.require(\'WAWebStatusGatingUtils\').canCheckStatusRankingPosterGating() : false)'
  );
  return new Function(`return (${source});`)();
}

// Node-side structures (Message.from/to/author, chat.id, client.info.wid) also read
// _serialized; without this, msg.from is undefined and every incoming message crashes.
const ID_KEYS = ['id', 'from', 'to', 'author', 'wid', 'participant', 'remote'];

function normalizeId(value) {
  if (value && typeof value === 'object' && value._serialized == null && value.$1 != null) {
    return Object.assign({}, value, { _serialized: value.$1 });
  }
  return value;
}

function normalizeStructureData(data) {
  if (!data || typeof data !== 'object') return data;
  const copy = Object.assign({}, data);
  for (const key of ID_KEYS) {
    if (copy[key] && typeof copy[key] === 'object') {
      copy[key] = normalizeId(copy[key]);
      for (const inner of ['remote', 'participant']) {
        if (copy[key][inner] && typeof copy[key][inner] === 'object') {
          copy[key] = Object.assign({}, copy[key], { [inner]: normalizeId(copy[key][inner]) });
        }
      }
    }
  }
  return copy;
}

const STRUCTURES = ['Message', 'Chat', 'Contact', 'ClientInfo', 'GroupNotification', 'Broadcast', 'Channel'];

function patchStructures(load = (name) => require(`whatsapp-web.js/src/structures/${name}`)) {
  for (const name of STRUCTURES) {
    let Structure;
    try { Structure = load(name); } catch (_) { continue; }
    const proto = Structure && Structure.prototype;
    if (!proto || typeof proto._patch !== 'function' || proto._patch.__idCompat) continue;
    const original = proto._patch;
    const patched = function (data) { return original.call(this, normalizeStructureData(data)); };
    patched.__idCompat = true;
    proto._patch = patched;
  }
}

function patchClient(loadClient = () => require('whatsapp-web.js/src/Client')) {
  let Client;
  try { Client = loadClient(); } catch (_) { return; }
  const proto = Client && Client.prototype;
  if (!proto || typeof proto.inject !== 'function' || proto.inject.__navCompat) return;
  const originalInject = proto.inject;
  const patchedInject = async function () {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await originalInject.call(this);
      } catch (err) {
        const isNavError = /Execution context was destroyed|most likely because of a navigation/i.test(err?.message || String(err));
        if (isNavError && attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        throw err;
      }
    }
  };
  patchedInject.__navCompat = true;
  proto.inject = patchedInject;
}

function installWhatsAppCompatibility() {
  const utilsPath = require.resolve('whatsapp-web.js/src/util/Injected/Utils');
  const utils = require(utilsPath);
  // Do not alter dependency files or the package lock on the owner's machine.
  if (typeof utils.LoadUtils !== 'function') throw new Error('Unsupported WhatsApp utility loader');
  utils.LoadUtils = buildCompatibleUtils(utils.LoadUtils);
  patchStructures();
  patchClient();
}

module.exports = { buildCompatibleUtils, installWhatsAppCompatibility, normalizeStructureData, patchStructures, patchClient };