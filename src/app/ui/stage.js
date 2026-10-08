// The stage: live screen preview, the draggable camera bubble, the 3-2-1
// countdown, the still thumbnail while recording, and playback in review.

import { $, show, text, attr } from './dom.js';
import { bubbleRect } from '../video/compositor.js';

export class Stage {
  constructor(session) {
    this.session = session;
    this.el = $('stage');
    this.screenVideo = $('screenVideo');
    this.reviewVideo = $('reviewVideo');
    this.cameraVideo = $('cameraVideo');
    this.bubble = $('bubblePreview');
    this.thumb = $('stageThumb');
    this.bubbleState = null;
    for (const v of [this.screenVideo, this.cameraVideo]) { v.muted = true; v.playsInline = true; v.autoplay = true; }
    this.reviewVideo.playsInline = true;
    this.reviewVideo.controls = true;
    this.#wireDrag();
    new ResizeObserver(() => this.#placeBubble()).observe(this.el);
  }

  render(st) {
    const phase = st.phase;
    const recording = ['recording', 'paused', 'stopping'].includes(phase);
    const review = phase === 'review' && st.review;
    const screenStream = st.screen?.stream || null;
    const hideLive = recording && st.prefs.hidePreview;

    // Live screen preview.
    const showLive = !!screenStream && !review && !hideLive;
    if (showLive && this.screenVideo.srcObject !== screenStream) this.screenVideo.srcObject = screenStream;
    if (!screenStream && this.screenVideo.srcObject) this.screenVideo.srcObject = null;
    show(this.screenVideo, showLive);

    // Still thumbnail while recording with the preview hidden.
    const thumbSrc = recording ? st.take?.thumbnail : '';
    show(this.thumb, hideLive);
    if (hideLive && thumbSrc && this.thumb.getAttribute('src') !== thumbSrc) this.thumb.src = thumbSrc;
    if (hideLive) this.thumb.alt = 'Recording in progress – preview hidden to save power';

    // Playback.
    const url = review ? st.review.url : null;
    if (url && this.reviewVideo.dataset.src !== url) { this.reviewVideo.dataset.src = url; this.reviewVideo.src = url; }
    if (!url && this.reviewVideo.dataset.src) { this.reviewVideo.pause(); this.reviewVideo.removeAttribute('src'); delete this.reviewVideo.dataset.src; this.reviewVideo.load(); }
    show(this.reviewVideo, !!url);

    // Empty state.
    show($('stageEmpty'), !screenStream && !url && !recording);
    text($('stageLabel'), url ? 'Playing back' : hideLive ? 'Recording – preview hidden' : screenStream ? (recording ? 'Live preview' : 'Live preview') : review ? 'This take can’t be played here' : 'Preview');
    attr(this.el, 'data-mode', url ? 'playback' : recording ? 'recording' : screenStream ? 'live' : 'empty');

    // Camera bubble preview (positioned like the recorded bubble).
    const cam = st.camera;
    const camStream = cam.enabled && cam.status === 'live' ? cam.previewStream : null;
    if (camStream && this.cameraVideo.srcObject !== camStream) this.cameraVideo.srcObject = camStream;
    if (!camStream && this.cameraVideo.srcObject) this.cameraVideo.srcObject = null;
    const showBubble = !!camStream && !url && (!!screenStream || !recording) && !hideLive;
    show(this.bubble, showBubble);
    this.bubbleState = cam.bubble;
    attr(this.bubble, 'data-shape', cam.bubble.shape);
    attr(this.bubble, 'data-mirror', cam.bubble.mirror ? 'true' : 'false');
    attr(this.bubble, 'data-size', cam.bubble.size);
    if (showBubble) this.#placeBubble();

    // Countdown overlay.
    show($('countdown'), phase === 'countdown');
    if (phase === 'countdown') {
      const n = $('countdownNum');
      if (n.textContent !== String(st.countdown)) {
        n.textContent = String(st.countdown);
        // Restart the pop animation for each number.
        n.style.animation = 'none'; void n.offsetWidth; n.style.animation = '';
      }
    }

    // Hint under/over the stage.
    let hint = '';
    if (st.screen && st.screen.surface !== 'monitor') hint = 'Only one window is being recorded';
    else if (showBubble && phase !== 'countdown' && !recording) hint = 'Drag the camera bubble to move it';
    text($('stageHint'), hint);
    show($('stageHint'), !!hint);
  }

  /** The video content box inside the stage (the preview is letterboxed). */
  #contentBox() {
    const r = this.el.getBoundingClientRect();
    const v = this.screenVideo;
    const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
    const scale = Math.min(r.width / vw, r.height / vh);
    const w = vw * scale, h = vh * scale;
    return { left: (r.width - w) / 2, top: (r.height - h) / 2, width: w, height: h };
  }

  #placeBubble() {
    if (!this.bubbleState || this.bubble.hidden) return;
    const box = this.#contentBox();
    if (!box.width) return;
    const r = bubbleRect({ width: box.width, height: box.height }, this.bubbleState);
    Object.assign(this.bubble.style, {
      position: 'absolute', left: `${box.left + r.x}px`, top: `${box.top + r.y}px`, width: `${r.size}px`, height: `${r.size}px`,
    });
  }

  #wireDrag() {
    let drag = null;
    const toNorm = e => {
      const box = this.#contentBox();
      const rect = this.el.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(1, (e.clientX - rect.left - box.left - drag.dx) / box.width)),
        y: Math.max(0, Math.min(1, (e.clientY - rect.top - box.top - drag.dy) / box.height)),
      };
    };
    this.bubble.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const b = this.bubble.getBoundingClientRect();
      drag = { dx: e.clientX - (b.left + b.width / 2), dy: e.clientY - (b.top + b.height / 2) };
      this.bubble.setPointerCapture(e.pointerId);
      this.bubble.classList.add('dragging');
      e.preventDefault();
    });
    this.bubble.addEventListener('pointermove', e => {
      if (!drag) return;
      this.bubbleState = { ...this.bubbleState, ...toNorm(e) };
      this.#placeBubble();
    });
    const end = e => {
      if (!drag) return;
      const pos = toNorm(e);
      drag = null;
      this.bubble.classList.remove('dragging');
      this.session.setBubble(pos);
    };
    this.bubble.addEventListener('pointerup', end);
    this.bubble.addEventListener('pointercancel', end);
    // Keyboard: arrow keys nudge the bubble.
    attr(this.bubble, 'tabindex', '0');
    attr(this.bubble, 'role', 'img');
    attr(this.bubble, 'aria-label', 'Camera bubble. Use the arrow keys to move it.');
    this.bubble.addEventListener('keydown', e => {
      const step = e.shiftKey ? 0.1 : 0.02;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!d || !this.bubbleState) return;
      e.preventDefault();
      const b = this.bubbleState;
      this.session.setBubble({ x: Math.max(0, Math.min(1, b.x + d[0])), y: Math.max(0, Math.min(1, b.y + d[1])) });
    });
  }
}
