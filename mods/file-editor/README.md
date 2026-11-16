# File editor

`my-files` opens files in `file-editor` tabs. Props: `file`, `on` (remote machine), `space`, `icon`, `preview`.

- Single-click: reusable preview tab, italic label. Double-click file/tab or click Keep: retain tab. First edit also retains it.
- Toolbar: Save, Reload (discards buffer edits), Copy, soft wrap. Save: Cmd-S/Ctrl-S; wrap: Alt-Z.
- Markdown and SVG: Preview/Code. Raster images: Fit, zoom steps, actual size; Cmd/Ctrl-wheel zooms.
- Animated GIF, WebP and APNG (macOS only): ImageIO splits the frames to PNG (`osascript`, at most 1000 frames or 400 Mpx in total) and the tab plays them at each frame's own delay, only while the tab shows. Pause/Play button or Space; Left/Right step frames. Other platforms show the first frame.
- Audio (mp3, wav, ogg, oga, opus, m4a, aac, flac, aif/aiff): needs ffmpeg. `ffprobe` reads duration/codec; `ffplay -nodisp` plays in the background. Play/pause, seek bar, volume; Space plays/pauses, Left/Right seek 5 s. Seeking or changing volume restarts ffplay at the position. Closing the tab stops it; a mod hot reload does not (the old ffplay runs to the end). Remote audio is copied locally first.
- CSV/TSV: Table/Code. Table shows the first row as header, the first 5000 rows, columns sized from the first 200 rows; `.csv` uses `;` when the first line has more semicolons than commas.
- HTML: Open in browser (local files only, system default app). No in-pane rendering: GPUI has no web view. Video is not previewed for the same reason.
- PDF (macOS only): one page at a time, rendered to PNG by PDFKit through `osascript`; ‹ › buttons or Left/Right/Page Up/Page Down turn pages, plus Fit/zoom.
- Clean files reload after disk changes. Dirty buffers show a conflict banner; save refuses a file changed since load.
- Disk/git polling: 3 seconds for shown tabs in the foreground window, otherwise 30 seconds.
- Above 150 KiB: plain editor without highlighting/folding. Above 1 MiB: first 1 MiB only, read-only. Markdown above 300 KiB opens as code.
- Remote pictures, PDFs and audio: no size limit (one copy may take up to 10 minutes). Each tab copies the file byte for byte with `hc exec --on <machine> cat` (needs local `hc`) into `data/file-editor/` and deletes it when the tab closes, also when it closes mid-copy or mid-frame-extraction (`.cancel` / `-fcancel` markers). A mod hot reload does not close tabs, so the previous copies stay until the daily sweep (files older than a day). Images/SVG previews use temporary copies under `data/file-editor/`, removed on close. Numeric raster zoom needs local `sips`; otherwise Fit only.
- Current file metadata/remote save use POSIX tools. Windows editor operations are not supported by these paths.
- Remote save checks expected contents before chunked transfer; it does not provide an atomic compare-and-swap against concurrent writers.

Checks from app home:

```sh
node --experimental-vm-modules mods/file-editor/editor.test.mjs
node mods/file-editor/lang.test.mjs
node mods/file-editor/csv.test.mjs
herdr-app check mods/file-editor
```

Behavior checks cover preview replacement, dirty-tab retention, promotion/reuse, successful save and refusal of conflicting local saves. Live screenshots verified local Markdown/raster/SVG, large-file read-only view, clean auto-reload and remote macOS raster loading. Automated native file-row clicks were not verified.
