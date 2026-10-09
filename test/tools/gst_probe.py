# Open a video file with GStreamer (qtdemux, an MP4 reader independent of
# ffmpeg) and report what a player sees: the duration, whether it is
# seekable, and where accurate seeks land, with a decoded frame each time.
#   python3 gst_probe.py FILE [SECONDS ...]  ->  JSON on stdout
import json, sys
import gi
gi.require_version('Gst', '1.0')
gi.require_version('GstApp', '1.0')
from gi.repository import Gst, GstApp  # noqa: E402

Gst.init(None)
path, targets = sys.argv[1], [float(x) for x in sys.argv[2:]]
pipe = Gst.parse_launch(
    f'filesrc location="{path}" ! qtdemux name=d d.video_0 ! queue ! decodebin ! videoconvert ! '
    'video/x-raw,format=GRAY8 ! appsink name=v sync=false')
sink = pipe.get_by_name('v')
pipe.set_state(Gst.State.PAUSED)
pipe.get_state(20 * Gst.SECOND)
ok, dur = pipe.query_duration(Gst.Format.TIME)
q = Gst.Query.new_seeking(Gst.Format.TIME)
pipe.query(q)
_, seekable, start, end = q.parse_seeking()
out = {'duration': dur / 1e9 if ok else None, 'seekable': bool(seekable),
       'seekEnd': end / 1e9 if end >= 0 else None, 'seeks': []}
for t in targets:
    accepted = pipe.seek_simple(Gst.Format.TIME, Gst.SeekFlags.FLUSH | Gst.SeekFlags.ACCURATE, int(t * Gst.SECOND))
    pipe.get_state(20 * Gst.SECOND)
    sample = sink.pull_preroll()
    buf = sample.get_buffer() if sample else None
    out['seeks'].append({'target': t, 'accepted': bool(accepted),
                         'pts': buf.pts / 1e9 if buf and buf.pts != Gst.CLOCK_TIME_NONE else None,
                         'bytes': buf.get_size() if buf else 0})
pipe.set_state(Gst.State.NULL)
print(json.dumps(out))
