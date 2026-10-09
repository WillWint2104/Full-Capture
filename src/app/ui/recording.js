// The Recording view: state pill, big timer, meters, Stop & save, Pause,
// Add chapter, floating controls, Discard take, notes, paused banner.

import { $, show, text, attr, focusEl, label } from './dom.js';
import { Meter } from './meters.js';
import { formatClock, formatDuration } from '../lib/time.js';

export class RecordingView {
  constructor(session, { meters, notices, confirm, popout }) {
    this.session = session;
    this.notices = notices;
    this.confirm = confirm;
    this.popout = popout;
    this.prevPhase = null;
    this.clock = { elapsedMs: 0, at: 0, running: false, shown: 0 };

    this.mic = new Meter($('recMicMeter'), $('recMicLabel'), {
      labels: { good: 'We can hear you ✓', quiet: 'Too quiet – speak up or move closer', loud: 'Too loud – move back a little', off: 'No sound from your microphone' },
    });
    this.sys = new Meter($('recSysMeter'), null);
    meters.add(this.mic);
    meters.add(this.sys);
    session.on('meter', m => {
      this.mic.set(m.voice?.rmsDb ?? -100, m.voice?.peakDb ?? -100);
      const sp = m.mix?.sysPeakDb ?? -100;
      this.sys.set(sp - 6, sp);
    });
    // Smooth timer between the recorder's ticks.
    meters.onFrame(now => this.#tickClock(now));

    $('btnStop').addEventListener('click', () => {
      if ($('btnStop').getAttribute('aria-disabled') === 'true') return;
      session.stop();
    });
    const enabled = id => $(id).getAttribute('aria-disabled') !== 'true';
    $('btnPause').addEventListener('click', () => { if (enabled('btnPause')) session.togglePause(); });
    $('btnResumeBig').addEventListener('click', () => session.togglePause());
    $('btnMarker').addEventListener('click', () => { if (enabled('btnMarker')) session.addMarker(); });
    $('btnPopout').addEventListener('click', () => (this.popout.isOpen ? this.popout.close() : this.popout.open()));
    $('btnDiscard').addEventListener('click', () => { if (enabled('btnDiscard')) this.discard(); });
    attr($('btnStop'), 'aria-keyshortcuts', 'Alt+R');
    attr($('btnPause'), 'aria-keyshortcuts', 'Alt+P');
    attr($('btnMarker'), 'aria-keyshortcuts', 'Alt+M');
  }

  /** Confirm, then throw the take away. */
  async discard() {
    const st = this.session.state;
    if (!st.take || !['recording', 'paused'].includes(st.phase)) return;
    const id = st.take.id;
    const mins = Math.floor(st.take.elapsedMs / 60_000);
    const ok = await this.confirm({
      title: 'Discard this take?',
      text: mins >= 1 ? `${formatDuration(st.take.elapsedMs)} will be deleted. This can’t be undone.` : 'It won’t be saved. This can’t be undone.',
      ok: 'Discard take', cancel: 'Keep recording', danger: true,
    });
    // The take may have ended while the question was open (Stop in the floating controls, sharing ended).
    const now = this.session.state;
    if (ok && now.take?.id === id && ['recording', 'paused'].includes(now.phase)) this.session.cancelTake();
    else if (ok && now.library.some(t => t.id === id)) this.notices.toast({ kind: 'info', title: 'That take was already saved', text: 'It stopped while you were deciding. Delete it from Your takes if you don’t want it.' });
    else if (ok) this.notices.toast({ kind: 'info', title: 'That take had already ended', text: 'There was nothing left to discard.' });
  }

  #tickClock(now) {
    const c = this.clock;
    if (!c.at) return;
    const ms = c.running ? c.elapsedMs + (now - c.at) : c.elapsedMs;
    // Never run backwards when a tick lands slightly behind our estimate.
    c.shown = Math.max(c.running ? c.shown : 0, ms);
    text($('recTimer'), formatClock(c.running ? c.shown : c.elapsedMs));
  }

  render(st) {
    const phase = st.phase;
    const active = ['recording', 'paused', 'stopping'].includes(phase);
    if (active && st.take) {
      const running = phase === 'recording';
      if (st.take.elapsedMs !== this.clock.elapsedMs || running !== this.clock.running) {
        this.clock = { ...this.clock, elapsedMs: st.take.elapsedMs, at: performance.now(), running };
      }
      text($('recLesson'), st.lesson.name.trim() || 'Untitled lesson');
      const pill = $('recPill');
      text(pill, phase === 'paused' ? '❚❚ Paused' : phase === 'stopping' ? 'Saving…' : '● Recording');
      attr(pill, 'data-state', phase);
      const where = st.take.savingTo === 'folder' ? `Saving into “${st.take.folderName || 'your folder'}”` : 'Downloads when you stop';
      text($('recSafety'), `${where} · safety copy ${st.take.safetyCopy ? 'on' : 'off'}`);
      attr($('recSafety'), 'data-on', st.take.safetyCopy ? 'true' : 'false');
      show($('recSysRow'), !!st.screen?.hasAudio && st.audio.systemAudio);
      if (st.prefs.noVoice) text($('recMicLabel'), 'Voice off');

      const stopping = phase === 'stopping';
      attr($('btnStop'), 'aria-disabled', stopping ? 'true' : null);
      label($('btnStop'), stopping ? 'Saving…' : 'Stop & save');
      label($('btnPause'), phase === 'paused' ? 'Resume' : 'Pause');
      attr($('btnPause'), 'aria-disabled', stopping ? 'true' : null);
      attr($('btnMarker'), 'aria-disabled', stopping ? 'true' : null);
      const n = st.take.markers.length;
      text($('markerCount'), n ? String(n) : '');
      show($('markerCount'), n > 0);
      attr($('btnPopout'), 'aria-pressed', this.popout.isOpen ? 'true' : 'false');
      show($('btnPopout'), this.popout.supported);
      attr($('btnDiscard'), 'aria-disabled', stopping ? 'true' : null);
      text($('recNotes'), st.lesson.notes);
      show($('recNotes'), !!st.lesson.notes.trim());
      show($('recBanner'), phase === 'paused');
      show($('recTalkingHint'), phase === 'paused' && !!st.take.talkingWhilePaused);
    } else {
      this.clock = { elapsedMs: 0, at: 0, running: false, shown: 0 };
      text($('recTimer'), '00:00');
      show($('recBanner'), false);
    }

    // Announcements and focus.
    const prev = this.prevPhase;
    if (phase !== prev) {
      if (phase === 'recording' && prev !== 'paused') {
        this.notices.announce('Recording started.');
        requestAnimationFrame(() => focusEl($('btnStop')));
      }
      if (phase === 'paused') {
        this.notices.announce('Paused. Not recording.');
        requestAnimationFrame(() => $('recBanner')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
      }
      if (phase === 'recording' && prev === 'paused') this.notices.announce('Recording resumed.');
      if (phase === 'stopping') this.notices.announce('Saving…');
    }
    if (phase === 'paused' && st.take?.talkingWhilePaused && !this.talkingAnnounced) {
      this.talkingAnnounced = true;
      this.notices.shout('You’re talking, but recording is paused.');
    }
    if (phase !== 'paused') this.talkingAnnounced = false;
    this.prevPhase = phase;
  }
}
