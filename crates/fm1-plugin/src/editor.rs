//! The plugin's window: the front panel (the native window's and the page's drawing code) with the
//! machine's screen and LEDs, played with the mouse as on the page (keys and buttons held while
//! pressed, a drag across the keys a glissando, knobs dragged up / down or scrolled, MASTER a pot
//! that is the host's "Master" parameter), and a bar to load a firmware package.

use crate::engine::Cmd;
use crate::{panel, panel_smk, Clock, Fm1Params, Lead, Link};
use fm1_soc::Board;
use nih_plug::prelude::*;
use nih_plug_egui::{create_egui_editor, egui, widgets};
use std::sync::{Arc, Mutex};
use crate::panel_input::{Effect, Input, MasterGesture, Pointer};

pub(super) type SharedInput = Arc<Mutex<(bool, Input)>>;

struct Ui {
    board: Board,
    base: Vec<u32>,
    buf: Vec<u32>,
    rgba: Vec<u8>,
    tex: Option<egui::TextureHandle>,
    down: [bool; 64],
    enc_clicks: [i32; 8],
    turning: [u32; 9],
    /// SMK-37: its analog inputs as set (fm1_soc::smk's ANALOG_* indices)
    analog: [u16; 23],
    input: SharedInput,
    session: u64,
    master: MasterGesture,
    firmware: Arc<Vec<u8>>,
    wheel_acc: f32,
    msg: String,
    msg_until: Option<std::time::Instant>,
    /// the file dialog's answer, while it is open
    picking: Option<(FileAction, Answer)>,
    job: Option<Job>,
}

impl Default for Ui {
    fn default() -> Self {
        let mut analog = [0; 23];
        analog[fm1_soc::smk::ANALOG_PITCH as usize] = fm1_soc::smk::PITCH_REST;
        analog[fm1_soc::smk::ANALOG_MOD as usize] = fm1_soc::smk::MOD_REST;
        Ui {
            board: Board::Fm1,
            base: Vec::new(),
            buf: Vec::new(),
            rgba: Vec::new(),
            tex: None,
            down: [false; 64],
            enc_clicks: [0; 8],
            turning: [0; 9],
            analog,
            input: Arc::new(Mutex::new((false, Input::default()))),
            session: 0,
            master: MasterGesture::default(),
            firmware: Arc::new(Vec::new()),
            wheel_acc: 0.0,
            msg: String::new(),
            msg_until: None,
            picking: None,
            job: None,
        }
    }
}

impl Ui {
    fn reopen(&mut self) {
        self.tex = None;
        self.down.fill(false);
        self.master.end();
        self.analog[..16].fill(0);
        self.analog[fm1_soc::smk::ANALOG_PITCH as usize] = fm1_soc::smk::PITCH_REST;
    }
}

pub fn create(params: Arc<Fm1Params>, link: Arc<Link>) -> Option<Box<dyn Editor>> {
    // (the state outlives a window: one opened again has a new egui context, so the panel's
    // texture, which belongs to the old one, is made again)
    let input: SharedInput = Arc::new(Mutex::new((false, Input::default())));
    let session = crate::native_editor::new_session();
    let initial = Ui { input: input.clone(), session, ..Ui::default() };
    let wrapped_params = params.clone();
    let wrapped_link = link.clone();
    let build = |_: &egui::Context, ui: &mut Ui| {
        ui.reopen();
    };
    let inner = create_egui_editor(params.editor_state.clone(), initial, build, move |ctx, setter, ui| {
        let (lcd, leds, pads, board, booted, halted, speed, late) = {
            let v = link.shared.view.lock().unwrap();
            (v.lcd.clone(), v.leds, v.pads, v.board, v.booted, v.halted, v.speed, v.late)
        };
        let firmware = params.firmware.lock().unwrap().pkg.clone();
        if board != ui.board || ui.base.is_empty() || !Arc::ptr_eq(&firmware, &ui.firmware) {
            let effects = { let mut state = ui.input.lock().unwrap(); let smk = state.0; let out = state.1.cancel(smk); state.0 = board == Board::Smk37; out };
            apply_effects(ui, &params, &link, setter, effects);
            ui.board = board;
            ui.firmware = firmware;
            ui.base = if board == Board::Smk37 { panel_smk::base() } else { panel::base(panel::Theme::by_name("default")) };
            ui.buf = vec![0; ui.base.len()];
        }
        let smk = board == Board::Smk37;
        let (w, h) = if smk { (panel_smk::W, panel_smk::H) } else { (panel::W, panel::H) };

        egui::TopBottomPanel::top("bar").show(ctx, |bar| {
            bar.horizontal_wrapped(|bar| {
                if ui.msg_until.is_some_and(|until| std::time::Instant::now() >= until) {
                    ui.msg.clear(); ui.msg_until = None;
                }
                if let Some(result) = ui.job.as_ref().and_then(|job| job.lock().unwrap().take()) {
                    ui.job = None;
                    ui.msg_until = result.as_ref().ok().map(|_| std::time::Instant::now() + std::time::Duration::from_secs(3));
                    ui.msg = match result { Ok(message) => message, Err(error) => error };
                }
                let name = params.firmware.lock().unwrap().name.clone();
                let idle = ui.picking.is_none() && ui.job.is_none();
                if bar.add_enabled(idle, egui::Button::new("Load firmware / save…"))
                    .on_hover_text("Open a .fwsc firmware package or a shared .fm1save setup").clicked() {
                    ui.picking = Some((FileAction::Load, pick(FileAction::Load, &name)));
                }
                let has_firmware = !params.firmware.lock().unwrap().pkg.is_empty();
                if bar.add_enabled(idle && has_firmware, egui::Button::new("Export save…"))
                    .on_hover_text("Share the running firmware, patches and settings as a .fm1save file").clicked() {
                    ui.picking = Some((FileAction::Export, pick(FileAction::Export, &name)));
                }
                let chosen = ui.picking.as_ref().and_then(|(action, answer)|
                    answer.lock().unwrap().take().map(|path| (*action, path)));
                if let Some((action, path)) = chosen {
                    ui.picking = None;
                    if let Some(path) = path {
                        ui.msg_until = None;
                        ui.msg = if matches!(action, FileAction::Load) { "Loading save…" } else { "Exporting live flash…" }.into();
                        ui.job = Some(file_job(action, path, params.clone(), link.clone()));
                    }
                }
                bar.label(egui::RichText::new(if name.is_empty() { "no firmware".into() } else { name }).strong());
                bar.separator();
                bar.label("MIDI channel");
                bar.add(widgets::ParamSlider::for_param(&params.channel, setter).with_width(90.0));
                bar.label("CPU clock").on_hover_text("The emulated FM-1's clock, 240 MHz as on the chip. Lower it if this computer can't keep up with a heavy firmware (\"frames late\"); raise it if a firmware runs out of time. Changing it restarts the firmware");
                // a menu in the clocks' order (the parameter's own order keeps v0.2.0's projects)
                enum_menu(bar, setter, "clock", &params.clock, &Clock::ALL, 90.0, Clock::name);
                bar.label("Lead").on_hover_text("How far ahead of the host the firmware runs, beyond one host block: a note you play waits this long, plus the host's own buffers, before it sounds. 23 ms is room for any firmware; try less, and go back up if \"frames late\" appear in the status bar. An AU host learns the new latency when the plugin is loaded again");
                enum_menu(bar, setter, "lead", &params.lead, &Lead::ALL, 70.0, Lead::name);
                bar.separator();
                // the recorder: a WAV of the output, as the machine's thread reports it
                let (file, said) = {
                    let mut r = params.rec.lock().unwrap();
                    (r.file.clone(), r.msg.take())
                };
                if let Some(said) = said {
                    ui.msg = said;
                    ui.msg_until = Some(std::time::Instant::now() + std::time::Duration::from_secs(4));
                }
                let rec_label = match &file {
                    Some((_, frames)) => format!("■ Stop  {}:{:02}", frames / 44_100 / 60, frames / 44_100 % 60),
                    None => "● Record".into(),
                };
                if bar.add_enabled(booted, egui::Button::new(rec_label))
                    .on_hover_text("Write the FM-1's output to a WAV (44.1 kHz, 16-bit) in your Music folder's fm1-emu").clicked() {
                    let _ = link.cmds.send(Cmd::Record);
                }
                bar.separator();
                let status = if !ui.msg.is_empty() {
                    ui.msg.clone()
                } else if !booted {
                    "Open a .fwsc firmware or shared .fm1save to start".into()
                } else if halted {
                    "The firmware stopped: an instruction the emulator does not know".into()
                } else {
                    let late = if late > 0 { format!(", {late} frames late in the last second") } else { String::new() };
                    if speed > 0.0 { format!("could run {speed:.1}x real time{late}") } else { format!("starting{late}") }
                };
                bar.label(status);
            });
        });

        egui::CentralPanel::default().frame(egui::Frame::NONE.fill(egui::Color32::from_rgb(0x18, 0x19, 0x1b))).show(ctx, |c| {
            let avail = c.available_rect_before_wrap();
            let k = (avail.width() / w as f32).min(avail.height() / h as f32);
            let rect = egui::Rect::from_center_size(avail.center(), egui::vec2(w as f32 * k, h as f32 * k));
            let resp = c.allocate_rect(rect, egui::Sense::click_and_drag());
            let at = |p: egui::Pos2| ((p.x - rect.min.x) / k, (p.y - rect.min.y) / k);

            // Coordinates in the native view and egui are both logical, top-left based.
            // The recognizer only claims the panel; the toolbar keeps its normal egui input.
            let screen = ctx.input(|i| i.screen_rect());
            let region = [(rect.min.x - screen.min.x) / screen.width(), (rect.min.y - screen.min.y) / screen.height(), rect.width() / screen.width(), rect.height() / screen.height()];
            let touch = crate::native_editor::drain(ui.session, region);
            let (pressed, released, pos, scroll, focused) = ctx.input(|i| (i.pointer.primary_pressed(), i.pointer.primary_released(), i.pointer.interact_pos(), i.raw_scroll_delta.y, i.focused));
            if !focused || ui.picking.is_some() || ui.job.is_some() || !booted {
                let effects = ui.input.lock().unwrap().1.cancel(smk);
                apply_effects(ui, &params, &link, setter, effects);
            } else {
                for event in touch {
                    let p = egui::pos2(screen.min.x + event.x * screen.width(), screen.min.y + event.y * screen.height());
                    let (x,y) = at(p);
                    let effects = {
                        let mut state = ui.input.lock().unwrap();
                        match event.phase {
                            fm1_touch::Phase::Start => state.1.start(Pointer::Touch(event.id), smk, x, y),
                            fm1_touch::Phase::Move => state.1.moved(Pointer::Touch(event.id), smk, x, y),
                            fm1_touch::Phase::End | fm1_touch::Phase::Cancel => state.1.end(Pointer::Touch(event.id), smk),
                        }
                    };
                    apply_effects(ui, &params, &link, setter, effects);
                }
                // Mouse input uses a separate owner, including when a finger already holds
                // the same key.
                if let Some(p) = pos {
                    let (x,y) = at(p);
                    let effects = {
                        let mut state = ui.input.lock().unwrap();
                        if pressed && resp.hovered() { state.1.start(Pointer::Mouse, smk, x, y) }
                        else { state.1.moved(Pointer::Mouse, smk, x, y) }
                    };
                    apply_effects(ui, &params, &link, setter, effects);
                }
                if released {
                    let effects = ui.input.lock().unwrap().1.end(Pointer::Mouse, smk);
                    apply_effects(ui, &params, &link, setter, effects);
                }
            }
            if scroll != 0.0 && resp.hovered() {
                if let Some(p) = pos {
                    let (x, y) = at(p);
                    let h = hit(smk, x, y);
                    if smk && (300..304).contains(&h) {
                        let i = 16 + (h - 300) as usize;
                        analog(ui, &link, i, (ui.analog[i] as f32 + scroll * 2.0).clamp(0.0, 1023.0) as u16);
                    } else if !smk && h == 7 {
                        let v = ui.master.adjust(params.master.value(), scroll * 0.5 / 1023.0);
                        let held = ui.input.lock().unwrap().1.master_active();
                        if !held { setter.begin_set_parameter(&params.master); }
                        setter.set_parameter(&params.master, v);
                        if !held { setter.end_set_parameter(&params.master); }
                    } else if (0..if smk { 8 } else { 7 }).contains(&h) {
                        ui.wheel_acc += scroll;
                        while ui.wheel_acc >= 40.0 {
                            ui.wheel_acc -= 40.0;
                            turn(ui, &link, smk, h, 1);
                        }
                        while ui.wheel_acc <= -40.0 {
                            ui.wheel_acc += 40.0;
                            turn(ui, &link, smk, h, -1);
                        }
                    }
                }
            }

            // the panel
            if smk {
                let a = &ui.analog;
                let st = panel_smk::State {
                    lcd: &lcd,
                    enc_clicks: &ui.enc_clicks,
                    turning: &std::array::from_fn(|i| ui.turning[i]),
                    down: &ui.down,
                    leds: &std::array::from_fn(|i| leds[i]),
                    pads: &pads,
                    pad_force: &std::array::from_fn(|p| a[p]),
                    faders: &std::array::from_fn(|f| a[16 + f]),
                    pitch: a[fm1_soc::smk::ANALOG_PITCH as usize],
                    modw: a[fm1_soc::smk::ANALOG_MOD as usize],
                };
                panel_smk::draw(&mut ui.buf, &ui.base, &st);
            } else {
                let st = panel::State {
                    lcd: &lcd,
                    enc_clicks: &std::array::from_fn(|i| ui.enc_clicks[i]),
                    pot: (params.master.value() * 1023.0).round() as u16,
                    down: &std::array::from_fn(|i| ui.down[i]),
                    leds: &leds,
                    turning: &std::array::from_fn(|i| ui.turning[i]),
                };
                panel::draw(&mut ui.buf, &ui.base, &st, panel::Theme::by_name("default"));
            }
            for t in ui.turning.iter_mut() {
                *t = t.saturating_sub(1);
            }
            ui.rgba.clear();
            ui.rgba.extend(ui.buf.iter().flat_map(|p| [(p >> 16) as u8, (p >> 8) as u8, *p as u8, 255]));
            let img = egui::ColorImage::from_rgba_unmultiplied([w, h], &ui.rgba);
            match ui.tex.as_mut() {
                Some(t) if t.size() == [w, h] => t.set(img, egui::TextureOptions::LINEAR),
                _ => ui.tex = Some(ctx.load_texture("panel", img, egui::TextureOptions::LINEAR)),
            }
            if let Some(t) = &ui.tex {
                c.painter().image(t.id(), rect, egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)), egui::Color32::WHITE);
            }
        });
        ctx.request_repaint_after(std::time::Duration::from_millis(33));
    })?;
    Some(crate::native_editor::wrap(inner, session, input, wrapped_params, wrapped_link))
}

fn apply_effects(ui: &mut Ui, params: &Fm1Params, link: &Link, setter: &ParamSetter, effects: Vec<Effect>) {
    for effect in effects {
        match effect {
            Effect::Key(k, down) => ui.down[k as usize] = down,
            Effect::Turn(i, clicks) => { ui.enc_clicks[i] += clicks; ui.turning[i] = 10; }
            Effect::Analog(i, v) => ui.analog[i] = v,
            Effect::MasterBegin => ui.master.begin(params.master.value()),
            Effect::MasterEnd => ui.master.end(),
            Effect::MasterDelta(delta) => {
                ui.turning[7] = 10;
                let value = ui.master.adjust(params.master.value(), delta);
                setter.set_parameter(&params.master, value);
                continue;
            }
            _ => {}
        }
        send_effect(params, link, setter, ui.board == Board::Smk37, effect);
    }
}

pub(super) fn send_effect(params: &Fm1Params, link: &Link, setter: &ParamSetter, smk: bool, effect: Effect) {
    let cmd = match effect {
        Effect::Key(id, down) => Some(Cmd::Key { id, down }),
        Effect::KeyVelocity(v) => Some(Cmd::KeyVel(v)),
        Effect::Pressure(id, vel) => Some(Cmd::Pressure { id, vel }),
        Effect::Velocity(f) => { velocity(link, f); None }
        Effect::Turn(i, clicks) => Some(Cmd::Enc { enc: if smk { i as u8 } else { panel::ENCS[i].1 }, clicks }),
        Effect::Analog(idx, value) => Some(Cmd::Analog { idx: idx as u8, value }),
        Effect::MasterBegin => { setter.begin_set_parameter(&params.master); None }
        Effect::MasterDelta(_) => None, // resolved against the UI's gesture-local value above
        Effect::MasterEnd => { setter.end_set_parameter(&params.master); None }
    };
    if let Some(cmd) = cmd { let _ = link.cmds.send(cmd); }
}

/// Ask for a package. The dialog runs modally, so not from inside the window's frame: macOS
/// sends the window events while it is open (a mouse leaving it), and the window's code is still
/// in the frame then (in GarageBand's AU host that aborts). On macOS it opens from the main queue
/// once the frame is done; elsewhere on a thread of its own. On Windows it gets the window the
/// click came from (the host's window around the plugin) as its owner, so it opens on top of it
/// and that window takes no clicks until it closes; without one it opened behind the host. The
/// answer lands in the returned slot (a path, or None if cancelled).
type Answer = Arc<std::sync::Mutex<Option<Option<std::path::PathBuf>>>>;
/// A menu for an enum parameter, in the order given (not the enum's own, which the saved index
/// keeps), setting it through the host.
fn enum_menu<T: Enum + PartialEq + Copy + 'static>(
    bar: &mut egui::Ui, setter: &ParamSetter, salt: &str, param: &EnumParam<T>, order: &[T], width: f32, name: fn(T) -> String,
) {
    let now = param.value();
    egui::ComboBox::from_id_salt(salt).width(width).selected_text(name(now)).show_ui(bar, |menu| {
        for &v in order {
            if menu.selectable_label(v == now, name(v)).clicked() && v != now {
                setter.begin_set_parameter(param);
                setter.set_parameter(param, v);
                setter.end_set_parameter(param);
            }
        }
    });
}

type Job = Arc<std::sync::Mutex<Option<Result<String, String>>>>;
#[derive(Clone, Copy)]
enum FileAction { Load, Export }

fn pick(action: FileAction, name: &str) -> Answer {
    let answer: Answer = Default::default();
    let slot = answer.clone();
    let name: String = name.chars().take(100).map(|c|
        if c.is_alphanumeric() || " _-".contains(c) { c } else { '_' }).collect();
    #[cfg(target_os = "windows")]
    let owner = win_owner::foreground();
    let ask = move || {
        let dialog = rfd::FileDialog::new();
        #[cfg(target_os = "windows")]
        let dialog = match &owner { Some(o) => dialog.set_parent(o), None => dialog };
        let path = match action {
            FileAction::Load => dialog
                .add_filter("FM-1 firmware or shared save", &["fwsc", "fm1save", "json"]).pick_file(),
            FileAction::Export => dialog.add_filter("FM-1 shared save", &["fm1save"])
                .set_file_name(format!("{}.fm1save", if name.is_empty() { "FM-1" } else { &name })).save_file(),
        };
        *slot.lock().unwrap() = Some(path);
    };
    #[cfg(target_os = "macos")]
    dispatch2::DispatchQueue::main().exec_async(ask);
    #[cfg(not(target_os = "macos"))]
    std::thread::spawn(ask);
    answer
}

/// The window a Windows file dialog belongs to: the foreground window when the button was
/// clicked, as a raw-window-handle for rfd.
#[cfg(target_os = "windows")]
mod win_owner {
    use raw_window_handle::{DisplayHandle, HandleError, HasDisplayHandle, HasWindowHandle,
                            RawWindowHandle, Win32WindowHandle, WindowHandle};
    use std::num::NonZeroIsize;

    #[link(name = "user32")]
    extern "system" { fn GetForegroundWindow() -> isize; }

    pub struct Owner(NonZeroIsize);

    pub fn foreground() -> Option<Owner> {
        NonZeroIsize::new(unsafe { GetForegroundWindow() }).map(Owner)
    }

    impl HasWindowHandle for Owner {
        fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
            let raw = RawWindowHandle::Win32(Win32WindowHandle::new(self.0));
            // the handle came from the OS and is only used while the dialog is up
            Ok(unsafe { WindowHandle::borrow_raw(raw) })
        }
    }

    impl HasDisplayHandle for Owner {
        fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
            Ok(DisplayHandle::windows())
        }
    }
}

// File I/O, hashing and serialization never run in the audio callback or window frame.
// The machine acknowledges imports only after a validated boot has replaced the old setup.
fn file_job(action: FileAction, mut path: std::path::PathBuf, params: Arc<Fm1Params>, link: Arc<Link>) -> Job {
    let job: Job = Default::default();
    let result = job.clone();
    std::thread::spawn(move || {
        if matches!(action, FileAction::Export) && path.extension().is_none() { path.set_extension("fm1save"); }
        let run = || -> Result<String, String> {
            match action {
                FileAction::Load => {
                    let current = params.firmware.lock().unwrap().clone();
                    let data = crate::savefile::read_with_firmware(&path, Some(&current))?;
                    let firmware = data.firmware.clone();
                    let (tx, rx) = std::sync::mpsc::channel();
                    link.cmds.send(Cmd::Load { firmware: data.firmware, sectors: data.sectors, reply: tx })
                        .map_err(|_| "the machine stopped".to_owned())?;
                    rx.recv().map_err(|_| "the machine stopped while loading".to_owned())??;
                    *link.running.lock().unwrap() = Some(firmware.pkg);
                    Ok(format!("Loaded {}", firmware.name))
                }
                FileAction::Export => {
                    let firmware = params.firmware.lock().unwrap().clone();
                    if firmware.pkg.is_empty() { return Err("load a firmware first".into()); }
                    let (tx, rx) = std::sync::mpsc::channel();
                    link.cmds.send(Cmd::Snapshot { pkg: firmware.pkg.clone(), reply: tx })
                        .map_err(|_| "the machine stopped".to_owned())?;
                    let sectors = rx.recv().map_err(|_| "the machine stopped while exporting".to_owned())??;
                    crate::savefile::write(&path, &crate::savefile::SaveData { firmware, sectors })?;
                    Ok(format!("Exported {}", path.file_name().unwrap_or_default().to_string_lossy()))
                }
            }
        };
        // (the error says which of the two it was: a refused load once read "Save file: …", #56)
        let what = match action { FileAction::Load => "Load", FileAction::Export => "Export" };
        *result.lock().unwrap() = Some(run().map_err(|e| format!("{what}: {e}")));
    });
    job
}

use crate::panel_input::hit;

fn turn(ui: &mut Ui, link: &Link, smk: bool, i: i32, clicks: i32) {
    ui.enc_clicks[i as usize] += clicks;
    ui.turning[i as usize] = 10;
    let enc = if smk { i as u8 } else { panel::ENCS[i as usize].1 };
    let _ = link.cmds.send(Cmd::Enc { enc, clicks });
}

fn analog(ui: &mut Ui, link: &Link, i: usize, v: u16) {
    if ui.analog[i] != v {
        ui.analog[i] = v;
        let _ = link.cmds.send(Cmd::Analog { idx: i as u8, value: v });
    }
}

/// SMK-37: the next keys' velocity, from how far down the key was hit (fm1-web's curve).
fn velocity(link: &Link, f: f32) {
    let us = (80000f32.ln() + (2000f32.ln() - 80000f32.ln()) * f.clamp(0.0, 1.0)).exp();
    let _ = link.cmds.send(Cmd::Vel(us as u32));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reopening_ends_old_master_gesture_and_releases_transient_controls() {
        let mut ui = Ui::default();
        ui.master.begin(0.2);
        ui.master.adjust(0.2, 0.1);
        ui.down[21] = true;
        ui.analog[0] = 700;
        ui.analog[16] = 321;
        ui.analog[fm1_soc::smk::ANALOG_MOD as usize] = 456;
        ui.analog[fm1_soc::smk::ANALOG_PITCH as usize] = 900;
        // The host closes during a drag, automates master while closed, and reopens.
        ui.reopen();
        assert!((ui.master.adjust(0.8, 0.1) - 0.9).abs() < 0.00001);
        assert!(ui.down.iter().all(|down| !down));
        assert!(ui.analog[..16].iter().all(|force| *force == 0));
        assert_eq!(ui.analog[fm1_soc::smk::ANALOG_PITCH as usize], fm1_soc::smk::PITCH_REST);
        assert_eq!(ui.analog[16], 321);
        assert_eq!(ui.analog[fm1_soc::smk::ANALOG_MOD as usize], 456);
    }
}
