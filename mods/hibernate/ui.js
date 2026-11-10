// The two dialogs: confirm sleeping busy agents, and resume after a restart.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, closeOverlay, setShared, settings } from "herdr";

const button = (t, id, label, primary, onClick) =>
  h_flex()
    .id(id)
    .h(32)
    .px(14)
    .items_center()
    .rounded(8)
    .border_1()
    .border_color(primary ? t.solid : t.input)
    .bg(primary ? t.solid : t.raised)
    .text_color(primary ? t.solid_foreground : t.foreground)
    .cursor_pointer()
    .hover((s) => s.opacity(0.88))
    .on_click(onClick)
    .child(label);

const check = (t, on) =>
  div()
    .size(14)
    .flex_none()
    .rounded(4)
    .border_1()
    .border_color(on ? t.accent : t.input)
    .bg(on ? t.accent : t.background)
    .text_size(10)
    .text_color(t.accent_foreground)
    .flex()
    .items_center()
    .justify_center()
    .child(on ? "✓" : "");

const frame = (v, t, title, body, footer, onKey) =>
  v_flex()
    .id("hibernate-dialog")
    .track_focus(v.handle)
    .on_key_down((e, cx) => {
      if (!onKey(e, cx)) return;
      cx.stop_propagation();
      cx.notify();
    })
    .size_full()
    .min_h(0)
    .p(18)
    .gap(12)
    .bg(t.popover)
    .text_size(13)
    .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child(title)).child(div().text_size(11).text_color(t.dim).child("Esc")))
    .child(v_flex().flex_1().min_h(0).gap(8).overflow_y_scrollbar().text_color(t.muted).children(body))
    .child(footer);

export const SleepDialog = {
  init(v, cx) {
    v.handle = cx.focus_handle();
    v.handle.focus();
  },
  yes() {
    const p = props();
    setShared("hibernate.request", { nonce: Date.now(), action: "sleep", space: p.space, confirmed: true });
    closeOverlay(p.overlay);
  },
  render(v) {
    const t = theme();
    const p = props() ?? {};
    return frame(
      v,
      t,
      `Sleep ${p.name ?? "space"}?`,
      [
        div().child("Still busy:"),
        ...(p.busy ?? []).map((b, i) => div().id(`b${i}`).text_color(t.foreground).child(`• ${b}`)),
        div().child("Sleeping interrupts them. Waking resumes their conversations where they stopped."),
      ],
      h_flex()
        .justify_end()
        .gap(8)
        .text_size(12)
        .child(button(t, "no", "Cancel", false, () => closeOverlay(props().overlay)))
        .child(button(t, "yes", "Sleep anyway", true, () => SleepDialog.yes())),
      (e) => {
        if (e.key === "enter") SleepDialog.yes();
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return false;
        return true;
      },
    );
  },
};

export const ResumeDialog = {
  init(v, cx) {
    v.handle = cx.focus_handle();
    v.handle.focus();
    v.picked = new Set((props()?.items ?? []).map((i) => i.address));
    v.auto = false;
    v.answered = false;
    v.offer = props()?.offer;
  },
  answer(v, resume) {
    v.answered = true;
    setShared("hibernate.answer", { nonce: Date.now(), dialog: true, offer: v.offer, resume, auto: v.auto });
    closeOverlay(props().overlay);
  },
  // Closed some other way: count it as "not now", so it isn't offered again.
  close(v) {
    if (!v.answered) setShared("hibernate.answer", { nonce: Date.now(), dialog: true, offer: v.offer, resume: [] });
  },
  render(v, cx) {
    const t = theme();
    const items = props()?.items ?? [];
    const mono = settings().font_family ?? "JetBrains Mono";
    const rows = items.map((it, i) =>
      h_flex()
        .id(`r${i}`)
        .gap(10)
        .p(8)
        .rounded(8)
        .items_start()
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (v.picked.has(it.address)) v.picked.delete(it.address);
          else v.picked.add(it.address);
          cx.notify();
        })
        .child(div().pt(2).child(check(t, v.picked.has(it.address))))
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(2)
            .child(h_flex().gap(6).child(div().text_color(t.foreground).font_semibold().child(it.name)).child(div().text_color(t.dim).truncate().child(`${it.where} · ${it.address}`)))
            .child(div().font_family(mono).text_size(11).text_color(t.muted).truncate().child(it.line)),
        ),
    );
    const n = v.picked.size;
    return frame(
      v,
      t,
      "Resume after restart",
      [div().child("These were running before their terminals were lost (a reboot or a core restart). Each comes back in its own pane."), ...rows],
      v_flex()
        .gap(10)
        .child(
          h_flex()
            .id("auto")
            .gap(8)
            .items_center()
            .cursor_pointer()
            .text_size(12)
            .text_color(t.muted)
            .on_click((_e, cx) => {
              v.auto = !v.auto;
              cx.notify();
            })
            .child(check(t, v.auto))
            .child("Resume automatically next time"),
        )
        .child(
          h_flex()
            .justify_end()
            .gap(8)
            .text_size(12)
            .child(button(t, "no", "Not now", false, () => ResumeDialog.answer(v, [])))
            .when(n > 0 && n < items.length, (el) => el.child(button(t, "some", `Resume ${n}`, false, () => ResumeDialog.answer(v, [...v.picked]))))
            .child(button(t, "all", "Resume all", true, () => ResumeDialog.answer(v, items.map((i) => i.address))))),
      (e) => {
        if (e.key === "enter") ResumeDialog.answer(v, n ? [...v.picked] : []);
        else if (e.key === "escape") ResumeDialog.answer(v, []);
        else return false;
        return true;
      },
    );
  },
};
