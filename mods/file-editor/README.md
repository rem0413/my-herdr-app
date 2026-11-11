# File editor

`my-files` opens files in `file-editor` tabs. Props: `file`, `on` (remote machine), `space`, `icon`, `preview`.

- Single-click: reusable preview tab, italic label. Double-click file/tab or click Keep: retain tab. First edit also retains it.
- Toolbar: Save, Reload (discards buffer edits), Copy, soft wrap. Save: Cmd-S/Ctrl-S; wrap: Alt-Z.
- Markdown and SVG: Preview/Code. Raster images: Fit, zoom steps, actual size; Cmd/Ctrl-wheel zooms.
- PDF (macOS only): one page at a time, rendered to PNG by PDFKit through `osascript`; ‹ › buttons or Left/Right/Page Up/Page Down turn pages, plus Fit/zoom. Remote PDFs: maximum 6 MiB.
- Clean files reload after disk changes. Dirty buffers show a conflict banner; save refuses a file changed since load.
- Disk/git polling: 3 seconds for shown tabs in the foreground window, otherwise 30 seconds.
- Above 150 KiB: plain editor without highlighting/folding. Above 1 MiB: first 1 MiB only, read-only. Markdown above 300 KiB opens as code.
- Remote raster images: maximum 6 MiB. Images/SVG previews use temporary copies under `data/file-editor/`, removed on close. Numeric raster zoom needs local `sips`; otherwise Fit only.
- Current file metadata/remote save use POSIX tools. Windows editor operations are not supported by these paths.
- Remote save checks expected contents before chunked transfer; it does not provide an atomic compare-and-swap against concurrent writers.

Checks from app home:

```sh
node --experimental-vm-modules mods/file-editor/editor.test.mjs
node mods/file-editor/lang.test.mjs
herdr-app check mods/file-editor
```

Behavior checks cover preview replacement, dirty-tab retention, promotion/reuse, successful save and refusal of conflicting local saves. Live screenshots verified local Markdown/raster/SVG, large-file read-only view, clean auto-reload and remote macOS raster loading. Automated native file-row clicks were not verified.
