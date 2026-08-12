# MenoRadio icon

- `app-icon.svg` is the editable vector master used by the renderer UI.
- `app-icon.png` is the 512 px packaging asset used by electron-builder.

Keep the SVG and PNG visually in sync when the mark changes. The PNG is kept
as a checked-in build asset so packaging does not depend on platform-specific
SVG rasterization tools.

The mark keeps MenoRadio's original blue-green tile and white `M`. Its stems
finish in compact inward curves rather than separate circles, keeping the
original inward stance while leaving more breathing room below. The complete
mark is rendered through one mask so the curves remain seamless and
color-consistent at taskbar size.
