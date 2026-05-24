import re

with open('server.js', 'r', encoding='utf8') as f:
    content = f.read()

# Find the start and end of processGlobalAIQueue
start_str = 'async function processGlobalAIQueue() {'
end_str = '}\n}\n\n// =============================================================\n// CONCURRENT API KEY REGISTRY'

start_idx = content.find(start_str)
end_idx = content.find(end_str)

if start_idx == -1 or end_idx == -1:
    print('Could not find bounds')
    exit(1)

old_func = content[start_idx:end_idx + 2]

body_start_str = 'const { slug, senderNumber, msg } = task;'
body_end_str = '    } catch (err) {\n      logInstanceEvent(slug, \'error\', `AI Auto-responder routine failed: ${err.message}`);\n    }'

body_start_idx = old_func.find(body_start_str)
body_end_idx = old_func.find(body_end_str) + len(body_end_str)

if body_start_idx == -1 or body_end_idx == -1:
    print('Could not find body bounds')
    exit(1)

body = old_func[body_start_idx:body_end_idx]

body = re.sub(r'\bcontinue;\b', 'return;', body)
body = body.replace('const { slug, senderNumber, msg } = task;', 'const { slug, senderNumber, msg } = task;\n  try {')

new_func = f'''async function processSingleAITask(task) {{
  {body}
  }} catch (outerErr) {{
    logInstanceEvent(task.slug, 'error', `Global AI queue item failed: ${{outerErr.message}}`);
  }}
}}

async function processGlobalAIQueue() {{
  if (globalAIProcessing || globalAIQueue.length === 0) return;

  globalAIProcessing = true;

  try {{
    while (globalAIQueue.length > 0) {{
      const task = globalAIQueue.shift();
      acquireAISlot(task.slug).then(() => {{
        processSingleAITask(task).catch(err => {{
          console.error('Unhandled parallel AI task error:', err);
        }}).finally(() => {{
          releaseAISlot(task.slug);
        }});
      }});
    }}
  }} finally {{
    globalAIProcessing = false;
    if (globalAIQueue.length > 0) {{
      processGlobalAIQueue().catch(err => {{
        console.error('Failed to process global AI queue post-loop:', err);
      }});
    }}
  }}
}}'''

new_content = content[:start_idx] + new_func + content[end_idx + 2:]
with open('server.js', 'w', encoding='utf8') as f:
    f.write(new_content)

print('Done')
