import sys

with open('server.js', 'r', encoding='utf8') as f:
    content = f.read()

target = '''    for (const user of users) {
      if (!user.unmuted && !user.isMuted && (now - user.firstSeen > cutoffMs)) {
        const muteResult = await setNativeChatMute(client, {
          number: user.number,
          chatId: user.chatId,
          mute: true,
          until: new Date(now + 100 * 365 * 24 * 3600 * 1000)
        });
        if (muteResult.success) {
          user.chatId = muteResult.chatId;
          logInstanceEvent(slug, 'system', `Auto-muted chat with +${user.number} on WhatsApp (interaction older than ${thresholdHours} hours)`);
        } else {
          logInstanceEvent(slug, 'system', `Bot muted +${user.number} internally; WhatsApp native mute unavailable: ${muteResult.error.message}`);
        }
        user.isMuted = true;
        changed = true;
      }
    }'''

replacement = '''    for (const user of users) {
      if (!user.unmuted && !user.isMuted && (now - user.firstSeen > cutoffMs)) {
        if (!user.verificationPromptSent) {
          logInstanceEvent(slug, 'system', `Sending order verification prompt to +${user.number} before auto-muting...`);
          const textQuestion = `Did you successfully place your iPhone order on the app? 😊`;
          const fallbackText = `Did you successfully place your iPhone order on the app? Please reply *Yes* or *No* 😊`;
          
          enqueueWhatsAppSend(slug, async () => {
             try {
               const chat = await client.getChatById(`${user.number}@c.us`);
               if (chat) await chat.sendMessage(fallbackText);
             } catch (e) {
               console.error(`Failed to send verification to ${user.number}:`, e.message);
             }
          }).catch(() => {});
          
          addToMemory(slug, user.number, 'assistant', textQuestion);
          
          user.verificationPromptSent = true;
          user.firstSeen = now; // Reset timer so they get more time to reply
          changed = true;
        } else {
          const muteResult = await setNativeChatMute(client, {
            number: user.number,
            chatId: user.chatId,
            mute: true,
            until: new Date(now + 100 * 365 * 24 * 3600 * 1000)
          });
          if (muteResult.success) {
            user.chatId = muteResult.chatId;
            logInstanceEvent(slug, 'system', `Auto-muted chat with +${user.number} on WhatsApp (interaction older than ${thresholdHours} hours)`);
          } else {
            logInstanceEvent(slug, 'system', `Bot muted +${user.number} internally; WhatsApp native mute unavailable: ${muteResult.error.message}`);
          }
          user.isMuted = true;
          changed = true;
        }
      }
    }'''

if target not in content:
    print('Target not found')
    sys.exit(1)

content = content.replace(target, replacement)

with open('server.js', 'w', encoding='utf8') as f:
    f.write(content)

print('Done')
