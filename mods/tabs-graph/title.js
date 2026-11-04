// Explicit tab names win; otherwise follow the terminal's live OSC title.
export function tabTitle(tab, pane) {
  if (tab.named) return tab.name;
  const program = pane?.program;
  const live = (pane?.title ?? "").trim();
  const telling = live && live !== program?.name && live.toLowerCase() !== program?.key
    && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@");
  return telling ? live : program?.name || tab.name || "Terminal";
}
