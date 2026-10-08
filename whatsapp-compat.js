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

function installWhatsAppCompatibility() {
  const utilsPath = require.resolve('whatsapp-web.js/src/util/Injected/Utils');
  const utils = require(utilsPath);
  // Do not alter dependency files or the package lock on the owner's machine.
  if (typeof utils.LoadUtils !== 'function') throw new Error('Unsupported WhatsApp utility loader');
  utils.LoadUtils = buildCompatibleUtils(utils.LoadUtils);
}

module.exports = { buildCompatibleUtils, installWhatsAppCompatibility };