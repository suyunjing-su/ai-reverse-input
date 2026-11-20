const SEPARATOR = '\n\n';

export function findPromptRule(config, model) {
  if (typeof model !== 'string' || !model) return null;
  return config.promptRules.find((rule) => rule.enabled && rule.modelId === model && rule.prompt.trim()) || null;
}

export function injectPrompt(body, protocol, rule) {
  const prompt = rule?.prompt;
  if (rule?.enabled === false || typeof prompt !== 'string' || !prompt.trim()) return { changed: false, body };
  let value;
  try { value = JSON.parse(body.toString('utf8')); } catch { return { changed: false, body }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { changed: false, body };

  let changed = false;
  switch (protocol) {
    case 'chat': changed = injectChat(value, prompt); break;
    case 'responses': changed = injectResponses(value, prompt); break;
    case 'anthropic': changed = injectAnthropic(value, prompt); break;
  }
  return changed ? { changed: true, body: Buffer.from(JSON.stringify(value)) } : { changed: false, body };
}

export function detectProtocol(pathname) {
  if (/\/v1\/chat\/completions\/?$/.test(pathname)) return 'chat';
  if (/\/v1\/responses\/?$/.test(pathname)) return 'responses';
  if (/\/v1\/messages\/?$/.test(pathname)) return 'anthropic';
  return null;
}

function appendInstruction(body, field, prompt) {
  const original = body[field];
  if (original == null || original === '') {
    body[field] = prompt;
    return true;
  }
  if (typeof original !== 'string' || original === prompt || original.endsWith(`${SEPARATOR}${prompt}`)) return false;
  body[field] = `${original}${SEPARATOR}${prompt}`;
  return true;
}

function injectResponses(body, prompt) {
  if (body.input === undefined) {
    body.input = [{ role: 'developer', content: prompt }];
    return true;
  }
  if (typeof body.input === 'string') {
    body.input = [{ role: 'developer', content: prompt }, { role: 'user', content: body.input }];
    return true;
  }
  if (!Array.isArray(body.input)) return false;
  if (body.input.some((item) => isGatewayDeveloper(item, prompt))) return false;
  const insertionIndex = findDeveloperInsertionIndex(body.input);
  if (body.input.some((item, index) => index > insertionIndex && isInstruction(item))) return false;
  body.input.splice(insertionIndex, 0, { role: 'developer', content: prompt });
  return true;
}

function isGatewayDeveloper(item, prompt) {
  return item?.role === 'developer' && item.content === prompt && Object.keys(item).length === 2;
}

function findDeveloperInsertionIndex(input) {
  let index = 0;
  while (index < input.length && isInstruction(input[index])) index++;
  return index;
}
function injectAnthropic(body, prompt) {
  if (!Array.isArray(body.system)) return appendInstruction(body, 'system', prompt);
  if (!body.system.every((block) => block?.type === 'text' && typeof block.text === 'string')) return false;
  const last = body.system.at(-1);
  if (last?.text === prompt && Object.keys(last).length === 2) return false;
  body.system.push({ type: 'text', text: prompt });
  return true;
}

function isInstruction(message) {
  return message?.role === 'system' || message?.role === 'developer';
}

function injectChat(body, prompt) {
  if (!Array.isArray(body.messages)) return false;
  let index = 0;
  let role = 'system';
  while (index < body.messages.length && isInstruction(body.messages[index])) {
    if (body.messages[index].role === 'developer') role = 'developer';
    index++;
  }
  // A later instruction leaves no insertion point that is both after all
  // native instructions and before the conversation, without moving messages.
  if (body.messages.some((message, i) => i > index && isInstruction(message))) return false;
  const last = body.messages[index - 1];
  if (last?.role === role && last.content === prompt && Object.keys(last).length === 2) return false;
  body.messages.splice(index, 0, { role, content: prompt });
  return true;
}
