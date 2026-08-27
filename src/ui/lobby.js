/**
 * Landing, join and lobby screens.
 *
 * The lobby carries more weight than any other screen: it is where fifteen
 * people who have never played decide whether this looks like a real game. It
 * also has to make one specific thing obvious at a glance — WHO is not ready —
 * because that is the question the host will be asked out loud.
 */

import { TEAMS } from '../config.js';

const $ = (id) => document.getElementById(id);

export class LobbyUI {
  constructor(handlers) {
    this.h = handlers;
    this.roomCode = '';
    this.localId = null;
    this.isHost = false;

    $('btn-create').onclick = () => this.h.onCreate();
    $('btn-join-screen').onclick = () => this.show('join');
    $('btn-back').onclick = () => this.show('landing');
    $('btn-join').onclick = () => this._submitJoin();
    $('in-code').onkeydown = (e) => { if (e.key === 'Enter') $('in-name').focus(); };
    $('in-name').onkeydown = (e) => { if (e.key === 'Enter') this._submitJoin(); };

    $('btn-copy-code').onclick = () => this._copy(this.roomCode, 'btn-copy-code', 'Copy code');
    $('btn-copy-link').onclick = () => this._copy(this.shareLink(), 'btn-copy-link', 'Copy link');

    $('btn-ready').onclick = () => this.h.onToggleReady();
    $('btn-switch').onclick = () => this.h.onSwitchTeam();
    $('btn-start').onclick = () => this.h.onStart();
    $('btn-again').onclick = () => this.h.onPlayAgain();

    const nick = $('in-nick');
    nick.onchange = () => this.h.onSetName(nick.value);
    nick.onkeydown = (e) => { if (e.key === 'Enter') { nick.blur(); } };
  }

  shareLink() {
    const u = new URL(location.href);
    u.searchParams.set('room', this.roomCode);
    return u.toString();
  }

  _copy(text, btnId, label) {
    const btn = $(btnId);
    const done = () => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = label; }, 1400); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => this._fallbackCopy(text, done));
    else this._fallbackCopy(text, done);
  }

  _fallbackCopy(text, done) {
    // Clipboard API needs a secure context; plain http:// from the relay is not
    // one, so keep a path that always works.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch { /* user can select it manually */ }
    ta.remove();
  }

  _submitJoin() {
    const code = $('in-code').value.trim().toUpperCase();
    if (!code) { this.error('join', 'Enter the room code the host read out.'); return; }
    this.h.onJoin(code, $('in-name').value.trim());
  }

  show(which) {
    for (const s of ['landing', 'join', 'lobby', 'end']) {
      $(`screen-${s}`).classList.toggle('hidden', s !== which);
    }
    this.current = which;
    if (which === 'join') setTimeout(() => $('in-code').focus(), 60);
  }

  hideAll() {
    for (const s of ['landing', 'join', 'lobby', 'end']) $(`screen-${s}`).classList.add('hidden');
    this.current = null;
  }

  error(screen, msg) {
    const el = $(`${screen}-error`);
    if (el) el.textContent = msg || '';
  }

  status(msg) { $('lobby-status').textContent = msg || ''; }

  setBusy(busy, label) {
    $('btn-create').disabled = busy;
    $('btn-join').disabled = busy;
    if (busy) $('landing-hint').textContent = label || 'Connecting…';
    else $('landing-hint').textContent = 'One host, up to 16 players, nothing to install';
  }

  enterLobby(roomCode, localId, isHost) {
    this.roomCode = roomCode;
    this.localId = localId;
    this.isHost = isHost;
    $('lobby-code').textContent = roomCode;
    $('btn-start').classList.toggle('hidden', !isHost);
    this.show('lobby');
  }

  /** state: { players: [...], blocker } */
  render(state) {
    const me = state.players.find((p) => p.id === this.localId);
    const lists = { red: [], blue: [] };

    for (const p of state.players) {
      const el = document.createElement('div');
      el.className = 'slot'
        + (p.id === this.localId ? ' me' : '')
        + (p.ready ? ' ready' : '')
        + (p.connected ? '' : ' gone');

      const tags = [];
      if (p.isHost) tags.push('<span class="tag host">Host</span>');
      tags.push(p.ready
        ? '<span class="tag rdy">Ready</span>'
        : '<span class="tag not">Not ready</span>');
      if (p.ping) tags.push(`<span class="tag ping">${p.ping}ms</span>`);

      el.innerHTML = `<span class="nm">${escapeHtml(p.name)}</span>${tags.join('')}`;

      // The host gets a kick, so one frozen laptop cannot hold the room hostage.
      if (this.isHost && p.id !== this.localId) {
        const k = document.createElement('button');
        k.className = 'btn ghost small';
        k.style.padding = '2px 8px';
        k.style.fontSize = '10px';
        k.textContent = 'Kick';
        k.onclick = () => this.h.onKick(p.id);
        el.appendChild(k);
      }
      lists[p.team].push(el);
    }

    for (const team of ['red', 'blue']) {
      const box = $(`${team}-list`);
      box.replaceChildren(...lists[team]);
      $(`${team}-count`).textContent = `${lists[team].length} player${lists[team].length === 1 ? '' : 's'}`;
    }

    const total = state.players.filter((p) => p.connected).length;
    const ready = state.players.filter((p) => p.connected && p.ready).length;
    $('ready-count').textContent = `${ready} / ${total}`;

    if (me) {
      $('btn-ready').textContent = me.ready ? 'Not ready' : 'Ready up';
      $('btn-ready').classList.toggle('ghost', me.ready);
      $('btn-switch').textContent = `Switch to ${me.team === 'red' ? 'Blue' : 'Red'}`;
      $('btn-switch').className = `btn small ${me.team === 'red' ? 'blue' : 'red'}`;
      if (document.activeElement !== $('in-nick')) $('in-nick').value = me.name;
    }

    if (this.isHost) {
      const btn = $('btn-start');
      btn.disabled = !!state.blocker;
      btn.textContent = state.blocker || 'Start game';
    } else {
      // Non-hosts should still know exactly what everyone is waiting for.
      this.status(state.blocker ? `Waiting: ${state.blocker.toLowerCase()}` : 'Waiting for the host to start');
    }
    if (this.isHost) this.status(state.blocker ? '' : 'Everyone is ready — you can start');
  }

  showResult(result, localTeam) {
    const w = $('end-winner');
    const winner = result.winner;
    w.className = `winner ${winner}`;
    w.textContent = winner === 'draw' ? 'Draw' : `${TEAMS[winner].name} Team Wins`;

    const mvp = result.mvp;
    $('end-mvp').classList.toggle('hidden', !mvp || mvp.sinks === 0);
    if (mvp) {
      $('mvp-name').textContent = mvp.name;
      $('mvp-stat').textContent = `${mvp.sinks} sink${mvp.sinks === 1 ? '' : 's'}`;
    }

    const rows = result.board.map((b, i) => `
      <tr class="${b.team}${b.id === this.localId ? ' me' : ''}">
        <td class="num" style="width:34px;color:var(--dim)">${i + 1}</td>
        <td>${escapeHtml(b.name)}</td>
        <td style="color:var(--dim);text-transform:uppercase;font-size:12px">${b.vessel}</td>
        <td class="num">${b.sinks}</td>
        <td class="num" style="color:var(--dim)">${b.deaths}</td>
      </tr>`).join('');

    $('end-board').innerHTML = `
      <div class="sb-head">
        <span class="r">${result.score.red}</span><span class="d">&ndash;</span><span class="b">${result.score.blue}</span>
      </div>
      <table>
        <thead><tr><th></th><th>Player</th><th>Vessel</th><th>Sinks</th><th>Losses</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

    $('btn-again').classList.toggle('hidden', !this.isHost);
    $('end-hint').textContent = this.isHost
      ? 'Play again returns everyone to the lobby'
      : 'Waiting for the host to start the next match';
    this.show('end');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export { escapeHtml };
