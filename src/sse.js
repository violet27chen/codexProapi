export function createSSEParser(onEvent) {
  let buffer = '';
  let eventName = '';
  let dataLines = [];

  const dispatch = () => {
    if (dataLines.length === 0) {
      eventName = '';
      return;
    }

    const data = dataLines.join('\n');
    dataLines = [];
    if (data === '[DONE]') {
      onEvent({ type: '[DONE]' });
      eventName = '';
      return;
    }

    let event;
    try {
      event = JSON.parse(data);
    } catch {
      event = { type: eventName || 'message', data };
    }
    if (eventName && !event.type && typeof event === 'object' && !Array.isArray(event)) {
      event.type = eventName;
    }
    eventName = '';
    onEvent(event);
  };

  return (chunk, final = false) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = final ? '' : (lines.pop() || '');
    if (final && lines.length === 0 && buffer) lines.push(buffer);

    for (const line of lines) {
      if (!line) {
        dispatch();
      } else if (line.startsWith(':')) {
        continue;
      } else if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (final) dispatch();
  };
}
