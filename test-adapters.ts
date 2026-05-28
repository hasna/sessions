import { listAdapters, getAdapter, autoDetectAdapters } from './src/lib/adapters/index.ts';

console.log('Adapters:', JSON.stringify(listAdapters(), null, 2));
console.log('---');

const codex = getAdapter('codex');
if (codex) {
  console.log('Codex available:', codex.isAvailable());
  const files = codex.discoverSessions();
  console.log('Codex sessions found:', files.length);
  if (files.length > 0) {
    const session = codex.parseSession(files[0]);
    console.log('First session:', JSON.stringify({
      id: session?.id,
      cwd: session?.cwd,
      events: session?.events.length,
      model: session?.model,
      agentName: session?.agentName,
      source: session?.source,
    }, null, 2));
  }
}
