# Sound effects

Drop short audio files here and `produce` will play them at the exact moment
each interaction or camera move happens (remapped through the per-beat speed, so
a sped-up click still lands on the visible click).

Files are matched **by name** (any extension: `.wav .mp3 .m4a .aac .ogg .flac`).
A type with no matching file is simply silent — add only the ones you want.

| Event | Looked-up names (first match wins) |
|-------|-------------------------------------|
| Left click (menu item, swatch, palette, Execute) | `click`, `tap`, `select`, `pop` |
| Right click (add a node) | `rightclick`, `right-click`, `rclick`, `contextmenu`, `menu`, `open`, → `click` |
| Double click | `dblclick`, `doubleclick`, → `click` |
| Drag (wire a connection) | `drag`, `connect`, `wire`, `link`, `swoosh`, `whoosh` |
| Typing into a field | `type`, `typing`, `keypress`, `keys`, `fill` |
| Zoom in | `zoom-in`, `zoomin`, `zoom`, `whoosh`, `swoosh` |
| Zoom out | `zoom-out`, `zoomout`, `zoom`, `whoosh`, `swoosh` |

So the simplest setup is just `click.wav`, `drag.wav`, and `zoom.wav`.

Keep them short (a click is ~50–150 ms). They're mixed **under** the voiceover
(default −5 dB); tune with the `sfxGain` option in `composeReel`.

Disable all SFX for a run with `npm run produce <flow> --no-sfx`.
