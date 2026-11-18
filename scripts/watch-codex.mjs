import { spawn } from 'node:child_process';

export function nextCheck(report, stage, savedId) {
  const { progress } = report;
  if (!report.configuration || stage === 'independent write verification') return `Check ${stage}.`;
  if (progress.lastToolState === 'verified') {
    const checks = [['project', report.project], ['recall', report.recall], ['remember', report.write === 'not-requested' || savedId], ['inbox', report.inbox]];
    const missing = checks.find(([, verified]) => !verified)?.[0];
    return missing ? `Last verified: ${progress.lastTool}. Check whether Codex calls hivemem_${missing}.` : 'Check whether the host session finishes.';
  }
  if (progress.lastTool) return `Inspect ${progress.lastTool} (${progress.lastToolState}) in the host session.`;
  if (progress.toolsListed) return 'HiveMem returned the tool list. Check whether the model turn proceeds to a tool call.';
  if (progress.protocolReplied) return 'HiveMem answered protocol setup. Check whether the host requests the tool list.';
  if (progress.serverLaunched) return 'The server process launched. Check stdio initialization and the host connection status.';
  if (progress.hostStarted) return 'Codex launched. Check the session and MCP startup; no HiveMem process launch was observed.';
  return 'Check the Codex executable and host launch.';
}

// Retain one bounded JSONL frame, never a transcript. Shell and assistant items are ignored.
export function watchCodex(bin, args, options, progress, onTool, timeoutMs = 180_000, finishMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let frame = '';
    let stopped = false;
    let failure;
    let exitGrace;
    function stop(message) {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      failure = new Error(message);
      exitGrace = setTimeout(() => reject(failure), 3000);
      child.kill('SIGKILL');
      child.stdout.destroy();
    }
    let finishing = false;
    let timer = setTimeout(() => stop('Host timed out waiting for verified tool results'), timeoutMs);
    function consume(line) {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { return stop('Host emitted invalid JSONL'); }
      if (event?.type === 'thread.started') progress.threadStarted = true;
      if (event?.type === 'turn.started') progress.turnStarted = true;
      if (event?.type === 'turn.failed') return stop('Codex reported a failed turn');
      const item = event?.item;
      if (item?.type !== 'mcp_tool_call' || item.server !== 'hivemem' ||
        !['hivemem_project', 'hivemem_recall', 'hivemem_remember', 'hivemem_inbox'].includes(item.tool)) return;
      if (!['item.started', 'item.completed'].includes(event.type)) return;
      progress.lastTool = item.tool;
      progress.lastToolState = 'started';
      if (event.type === 'item.started') return;
      if (item.status !== 'completed' || item.error || !item.result || item.result.is_error || item.result.isError) {
        progress.lastToolState = 'failed';
        return stop(`Host did not complete ${item.tool}; inspect the tool status or approval prompt in the host`);
      }
      progress.lastToolState = 'returned';
      try {
        const data = item.result.structured_content ?? item.result.structuredContent ?? JSON.parse(item.result.content.find(part => part.type === 'text').text);
        const allVerified = onTool(item.tool, data);
        progress.lastToolState = 'verified';
        if (allVerified === true && !finishing) {
          finishing = true;
          clearTimeout(timer);
          timer = setTimeout(() => stop('Host timed out finishing the turn after tool verification'), finishMs);
        }
      } catch { stop(`Unexpected result for ${item.tool}`); }
    }
    child.once('spawn', () => { progress.hostStarted = true; });
    child.stdout.setEncoding('utf8').on('data', chunk => {
      const parts = chunk.split('\n');
      for (const [index, part] of parts.entries()) {
        if (stopped) break;
        frame += part;
        if (Buffer.byteLength(frame) > 1024 * 1024) return stop('Host JSONL frame exceeded 1 MiB');
        if (index < parts.length - 1) { consume(frame); frame = ''; }
      }
    });
    child.stdout.once('error', () => stop('Could not read host events'));
    child.once('error', () => stop('Could not launch host executable'));
    child.once('close', code => {
      if (!stopped) consume(frame);
      clearTimeout(exitGrace);
      if (stopped) return reject(failure);
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Host exited with code ${code}`));
      else resolve();
    });
  });
}
