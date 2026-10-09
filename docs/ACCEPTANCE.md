# Acceptance test: Windows, Chrome or Edge, real devices

Run once on the Windows PC you teach from, with the microphone, camera and
screen you actually use. About 20 minutes. Tick each line; anything that
doesn't happen as written is a failure. Note it with a screenshot.

**Before you start**
- [ ] Chrome or Edge is version **126 or newer** (`chrome://version` or
      `edge://version`). Older versions save WebM instead of MP4.
- [ ] Download `full-capture.html` from the pull request's branch
      (GitHub → *Code* → branch `claude/gallant-curie-bclea8` →
      `full-capture.html` → *Download raw file*) into a folder of your own,
      e.g. `Documents\Full Capture`. Open it by double-clicking.
- [ ] Headset/microphone and webcam plugged in; HGL Studio open on the
      screen you teach from.

## 1. Set up

- [ ] **Microphone:** *Turn on microphone* → the browser asks → *Allow*.
      Pick your microphone. The meter moves when you speak and stays low
      when you're quiet.
- [ ] **Sound check:** *Check my sound*, then follow it. It ends in a verdict
      card, and *Hear it back* plays your voice clearly.
- [ ] **Camera:** turn on *Show me in a bubble* → *Allow*. Your face is in the
      bubble on the preview. Move it with *Move to a corner*.
- [ ] **Screen:** *Choose screen* → *Entire screen* tab → your monitor
      (switch on *Share system audio* if the lesson plays sound) → *Share*.
      The preview shows your screen, and the readiness line says *All set*.

## 2. Record

- [ ] *Start recording*. After the 3-2-1 countdown the page says
      *Recording*, the tab title starts with `●`, and the floating controls
      window appears on top (Chrome/Edge 116+).
- [ ] **Sync test, part 1:** within the first 5 seconds, clap your hands
      three times where the camera can see them.
- [ ] Switch to HGL Studio and teach normally for about 2 minutes. Press
      *Add chapter* (or Alt+M) once. The count shows 1.
- [ ] **Pause:** *Pause* in the floating controls (or Alt+P). They say
      *Paused*. Speak for a moment: *You're talking – press Resume* appears.
      *Resume*, then teach for another 30 seconds.
- [ ] **Sync test, part 2:** clap three times again, then *Stop & save*.

## 3. The saved file

- [ ] Review shows the take, with *Saved – nice work!*, and it plays in the
      page.
- [ ] The file is in your **Downloads** folder (or the lessons folder you
      chose), named `Lesson name (date time).mp4`. The extension is
      **.mp4**.
- [ ] It opens in the **Windows Media Player / Films & TV** app (and in VLC, if
      you have it). Picture and voice both play. The length shown matches the
      timer, without the paused part. (File Explorer → right-click → Properties
      → Details shows the same Length.)
- [ ] **Scrubbing:** in Media Player, drag the seek bar to about a quarter,
      the middle and near the end, and click a few points on it. Each time the
      picture and sound jump there straight away and play on from that point.
      Do the same in VLC and in Chrome (drag the file onto a new tab).
- [ ] **Sync after a jump:** jump back to the second set of claps. Each clap's
      sound still lands on the hands meeting.
- [ ] **Sync:** each clap's sound lands on the hands meeting, at the start
      and at the end. Look closely at the **first claps**: in testing, about
      one camera-bubble take in three had the sound about 0.15 s *ahead* of
      the picture for the first 1–2 seconds before it settled. Note whether
      you see that.
- [ ] (Optional) Upload it to YouTube as *Private*. It processes and plays.

## 4. Saving to a folder

- [ ] Header → *Choose a folder* → pick or create a lessons folder → *Allow*.
      Record 20 seconds and *Stop & save*. The file appears in that folder
      straight away, with no download step, and plays.

## 5. Recovery after a crash

- [ ] Start a take and record 30 seconds. Then close the browser tab, or end
      Chrome/Edge in Task Manager.
- [ ] Open `full-capture.html` again. It shows *We found a recording that
      didn't finish*. *Save it* gives a file with those 30 seconds that plays
      with sound.

## 6. Interruptions (quick)

- [ ] During a take, unplug the headset. A red *Microphone disconnected*
      banner appears and the take keeps going. Plug it back in: *Microphone is
      back*.
- [ ] During a take, click *Stop sharing* in the browser's sharing bar. The
      take is saved up to that moment, and Review says screen sharing ended.

## Report back

Send the browser and version, the microphone and camera models, which lines
failed (with screenshots), and the name and size of the 2-minute file. If
you can, share that file as well. I can check its streams and length with
ffmpeg and look at the clap sync frame by frame.
