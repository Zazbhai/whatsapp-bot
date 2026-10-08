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

function installWhatsAppCompatibility() {
  const utilsPath = require.resolve('whatsapp-web.js/src/util/Injected/Utils');
  const utils = require(utilsPath);
  // Do not alter dependency files or the package lock on the owner's machine.
  if (typeof utils.LoadUtils !== 'function') throw new Error('Unsupported WhatsApp utility loader');
  utils.LoadUtils = buildCompatibleUtils(utils.LoadUtils);
  patchStructures();
}

module.exports = { buildCompatibleUtils, installWhatsAppCompatibility, normalizeStructureData, patchStructures };