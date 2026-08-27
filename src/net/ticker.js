/**
 * A clock that does not stop when the tab is in the background.
 *
 * Browsers throttle requestAnimationFrame to a crawl (and setTimeout to ~1Hz)
 * in hidden tabs. For a client that is merely annoying. For the HOST it is
 * fatal: the authoritative simulation is the match, so the instant the host
 * alt-tabs to Slack, all sixteen players freeze mid-fight.
 *
 * Worker timers are exempt from that throttling, so the host's simulation and
 * snapshot broadcasts are driven from a worker tick instead of the render loop.
 * Rendering stays on rAF, where it belongs — a hidden tab draws nothing, but it
 * keeps running the game for everybody else.
 */

const WORKER_SRC = `
  let id = null;
  onmessage = (e) => {
    if (e.data && e.data.cmd === 'start') {
      clearInterval(id);
      id = setInterval(() => postMessage(1), e.data.ms);
    } else {
      clearInterval(id);
      id = null;
    }
  };
`;

export function createTicker(intervalMs, onTick) {
  let worker = null;
  let fallback = null;

  try {
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
    worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = () => onTick();
    worker.onerror = () => { /* fall through to the interval below on next stop/start */ };
    worker.postMessage({ cmd: 'start', ms: intervalMs });
  } catch {
    worker = null;
  }

  // Blob workers can be blocked by a strict CSP. A throttled clock beats none.
  if (!worker) fallback = setInterval(onTick, intervalMs);

  return {
    backgroundSafe: !!worker,
    stop() {
      if (worker) { try { worker.postMessage({ cmd: 'stop' }); worker.terminate(); } catch { /* gone */ } }
      if (fallback) clearInterval(fallback);
    },
  };
}
