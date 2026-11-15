//! Per-contact panel input. Mouse, fingers and computer keys own their holds independently.
//! The platform adapter only supplies ordered contact events in panel coordinates.

use crate::{panel, panel_smk};
use fm1_soc::{Action, Board};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Control {
    Key(u8), Button(u8), Encoder(usize), Pot, Pad(usize), Fader(usize), Pitch, Mod,
}

struct Contact {
    control: Control,
    key: Option<u8>,
    velocity: u8,
    last_y: f32,
    drag: f32,
}

pub struct PanelInput {
    board: Board,
    contacts: BTreeMap<u64, Contact>,
    keyboard: [bool; 64],
    pad_keys: [bool; 8],
    pub down: [bool; 64],
    pub analog: [u16; 23],
    pub pot: u16,
    pub enc_clicks: [i32; 8],
    pub turning: [u32; 8],
    pressure: [u8; 64],
    scroll: [f32; 8],
}

impl PanelInput {
    pub fn new(board: Board, pot: u16) -> Self {
        let mut analog = [0; 23];
        analog[fm1_soc::smk::ANALOG_PITCH as usize] = fm1_soc::smk::PITCH_REST;
        analog[fm1_soc::smk::ANALOG_MOD as usize] = fm1_soc::smk::MOD_REST;
        Self { board, contacts: BTreeMap::new(), keyboard: [false; 64], pad_keys: [false; 8],
            down: [false; 64], analog, pot, enc_clicks: [0; 8], turning: [0; 8], pressure: [0; 64], scroll: [0.0; 8] }
    }

    fn smk(&self) -> bool { self.board == Board::Smk37 }

    fn hit(&self, x: f32, y: f32) -> Option<(Control, u8)> {
        if !x.is_finite() || !y.is_finite() { return None; }
        if self.smk() {
            use panel_smk::Ctl as S;
            Some(match panel_smk::hit(x, y)? {
                S::Key(k, f) => (Control::Key(k), (1.0 + 126.0 * f.clamp(0.0, 1.0)).round() as u8),
                S::Btn(k) => (Control::Button(k), 100), S::Enc(i) => (Control::Encoder(i), 0),
                S::Pad(p) => (Control::Pad(p), 0), S::Fader(f) => (Control::Fader(f), 0),
                S::Pitch => (Control::Pitch, 0), S::Mod => (Control::Mod, 0),
            })
        } else {
            use panel::Ctl as F;
            Some(match panel::hit(x, y)? {
                F::Key(k) => (Control::Key(k), panel::key_vel(k, y)),
                F::Btn(k) => (Control::Button(k), 100), F::Enc(i) => (Control::Encoder(i), 0),
                F::Pot => (Control::Pot, 0),
            })
        }
    }

    /// Begin or replace one contact. Empty-space starts never acquire a control later.
    pub fn start(&mut self, id: u64, x: f32, y: f32) -> Vec<Action> {
        let mut out = self.end(id);
        if let Some((control, velocity)) = self.hit(x, y) {
            let key = match control { Control::Key(k) | Control::Button(k) => Some(k), _ => None };
            self.contacts.insert(id, Contact { control, key, velocity, last_y: y, drag: 0.0 });
            self.slide(control, y, &mut out);
            self.sync(&mut out);
        }
        out
    }

    pub fn moved(&mut self, id: u64, x: f32, y: f32) -> Vec<Action> {
        let mut out = Vec::new();
        if !x.is_finite() || !y.is_finite() { return out; }
        let hit = self.hit(x, y);
        let Some(g) = self.contacts.get_mut(&id) else { return out; };
        let control = g.control;
        match control {
            Control::Key(_) => {
                let (key, velocity) = match hit {
                    Some((Control::Key(k), v)) => (Some(k), v), _ => (None, 0),
                };
                g.key = key;
                g.velocity = velocity;
            }
            Control::Encoder(i) => {
                g.drag += g.last_y - y;
                let clicks = (g.drag / 12.0).trunc() as i32;
                g.drag -= clicks as f32 * 12.0;
                if clicks != 0 { self.turn(i, clicks, &mut out); }
            }
            Control::Pot => {
                let value = (self.pot as f32 + (g.last_y - y) * 4.0).clamp(0.0, 1023.0) as u16;
                if value != self.pot {
                    self.pot = value;
                    self.turning[7] = 10;
                    out.push(Action::Adc { ch: 4, value });
                }
            }
            _ => self.slide(control, y, &mut out),
        }
        if let Some(g) = self.contacts.get_mut(&id) { g.last_y = y; }
        self.sync(&mut out);
        out
    }

    pub fn end(&mut self, id: u64) -> Vec<Action> {
        let mut out = Vec::new();
        if let Some(g) = self.contacts.remove(&id) {
            if g.control == Control::Pitch && !self.contacts.values().any(|g| g.control == Control::Pitch) {
                self.analog(fm1_soc::smk::ANALOG_PITCH as usize, fm1_soc::smk::PITCH_REST, &mut out);
            }
            self.sync(&mut out);
        }
        out
    }

    /// Cancel local sources on focus loss or close, including pitch spring and pad force.
    pub fn cancel(&mut self) -> Vec<Action> {
        self.contacts.clear();
        self.keyboard = [false; 64];
        self.pad_keys = [false; 8];
        let mut out = Vec::new();
        if self.smk() { self.analog(fm1_soc::smk::ANALOG_PITCH as usize, fm1_soc::smk::PITCH_REST, &mut out); }
        self.sync(&mut out);
        out
    }

    pub fn keyboard(&mut self, keys: [bool; 64], pads: [bool; 8]) -> Vec<Action> {
        self.keyboard = keys;
        self.pad_keys = pads;
        let mut out = Vec::new();
        self.sync(&mut out);
        out
    }

    fn sync(&mut self, out: &mut Vec<Action>) {
        let mut want = self.keyboard;
        let mut velocities = [100; 64];
        for g in self.contacts.values() {
            if let Some(k) = g.key {
                let k = k as usize;
                if !want[k] { velocities[k] = g.velocity; }
                else { velocities[k] = velocities[k].max(g.velocity); }
                want[k] = true;
            }
        }
        // Release before pressing when a glissando crosses to a lower key id, too.
        for k in 0..64 {
            if self.down[k] && !want[k] {
                self.down[k] = false;
                self.pressure[k] = 0;
                out.push(Action::Key { id: k as u8, down: false });
            }
        }
        for k in 0..64 {
            if !want[k] || self.down[k] { continue; }
            if if self.smk() { k < 37 } else { (14..41).contains(&k) } {
                if self.smk() { out.push(Action::Vel { us: fm1_soc::script::smk_contact_us(velocities[k]) }); }
                else { out.push(Action::KeyVel { vel: velocities[k] }); }
            }
            self.down[k] = true;
            self.pressure[k] = velocities[k];
            out.push(Action::Key { id: k as u8, down: true });
        }
        // Several fingers (or a keyboard key) can hold one note. Its force follows
        // the strongest remaining owner, including when that owner lets go.
        if !self.smk() {
            for k in 14..41 {
                if want[k] && velocities[k].abs_diff(self.pressure[k]) >= 4 {
                    self.pressure[k] = velocities[k];
                    out.push(Action::Pressure { id: k as u8, vel: velocities[k] });
                }
            }
        }
        if self.smk() {
            for p in 0..16 {
                let held = self.contacts.values().any(|g| g.control == Control::Pad(p)) || (p < 8 && self.pad_keys[p]);
                self.analog(p, if held { 700 } else { 0 }, out);
            }
        }
    }

    fn analog(&mut self, ch: usize, value: u16, out: &mut Vec<Action>) {
        if self.analog[ch] != value {
            self.analog[ch] = value;
            out.push(Action::Adc { ch: ch as u8, value });
        }
    }

    fn slide(&mut self, control: Control, y: f32, out: &mut Vec<Action>) {
        match control {
            Control::Fader(f) => self.analog(16 + f, panel_smk::fader_value(f, y), out),
            Control::Pitch => self.analog(fm1_soc::smk::ANALOG_PITCH as usize, panel_smk::wheel_value(true, y), out),
            Control::Mod => self.analog(fm1_soc::smk::ANALOG_MOD as usize, panel_smk::wheel_value(false, y), out),
            _ => {}
        }
    }

    pub fn turn(&mut self, i: usize, clicks: i32, out: &mut Vec<Action>) {
        self.enc_clicks[i] += clicks;
        self.turning[i] = 10;
        out.push(Action::Enc { enc: if self.smk() { i as u8 } else { panel::ENCS[i].1 }, clicks });
    }

    pub fn scroll(&mut self, x: f32, y: f32, delta: f32) -> Vec<Action> {
        let mut out = Vec::new();
        match self.hit(x, y).map(|p| p.0) {
            Some(Control::Encoder(i)) => {
                self.scroll[i] += delta;
                let clicks = self.scroll[i].trunc() as i32;
                self.scroll[i] -= clicks as f32;
                if clicks != 0 { self.turn(i, clicks, &mut out); }
            }
            Some(Control::Pot) => {
                self.pot = (self.pot as f32 + delta * 24.0).clamp(0.0, 1023.0) as u16;
                self.turning[7] = 10;
                out.push(Action::Adc { ch: 4, value: self.pot });
            }
            _ => {}
        }
        out
    }

    pub fn tick(&mut self) { for t in &mut self.turning { *t = t.saturating_sub(1); } }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn key_events(actions: Vec<Action>) -> Vec<(u8, bool)> {
        actions.into_iter().filter_map(|a| match a { Action::Key { id, down } => Some((id, down)), _ => None }).collect()
    }
    #[test]
    fn chord_contacts_release_independently_and_shared_key_waits_for_last_owner() {
        let mut p = PanelInput::new(Board::Fm1, 512);
        assert_eq!(key_events(p.start(1, 80.0, 720.0)), [(14, true)]);
        assert_eq!(key_events(p.start(2, 160.0, 720.0)), [(16, true)]);
        assert!(key_events(p.start(3, 80.0, 730.0)).is_empty());
        assert!(key_events(p.end(1)).is_empty());
        assert_eq!(key_events(p.end(3)), [(14, false)]);
        assert!(p.down[16]);
        assert_eq!(key_events(p.cancel()), [(16, false)]);
    }
    #[test]
    fn glissando_releases_outside_then_reenters_and_tap_is_not_lost() {
        let mut p = PanelInput::new(Board::Fm1, 512);
        p.start(1, 80.0, 720.0);
        assert_eq!(key_events(p.moved(1, 160.0, 720.0)), [(14, false), (16, true)]);
        assert_eq!(key_events(p.moved(1, 80.0, 720.0)), [(16, false), (14, true)]);
        assert_eq!(key_events(p.moved(1, -20.0, 720.0)), [(14, false)]);
        assert_eq!(key_events(p.moved(1, 80.0, 720.0)), [(14, true)]);
        assert_eq!(key_events(p.end(1)), [(14, false)]);
        assert_eq!(key_events(p.start(2, 80.0, 720.0)), [(14, true)]);
        assert_eq!(key_events(p.end(2)), [(14, false)]);
        assert!(p.down.iter().all(|k| !k));
    }
    #[test]
    fn keyboard_hold_survives_finger_release_and_cancel_releases_both() {
        let mut p = PanelInput::new(Board::Fm1, 512);
        let mut keys = [false; 64]; keys[14] = true;
        p.keyboard(keys, [false; 8]);
        assert!(key_events(p.start(1, 80.0, 720.0)).is_empty());
        assert!(key_events(p.end(1)).is_empty());
        assert_eq!(key_events(p.cancel()), [(14, false)]);
    }
    #[test]
    fn independent_encoder_remainders_and_other_held_key() {
        let mut p = PanelInput::new(Board::Fm1, 512);
        p.start(1, 80.0, 720.0); p.start(2, 250.0, 135.0); p.start(3, 110.0, 295.0);
        assert!(p.moved(2, 250.0, 128.0).is_empty());
        let a = p.moved(3, 110.0, 282.0);
        assert!(a.contains(&Action::Enc { enc: 6, clicks: 1 }));
        let a = p.moved(2, 250.0, 122.0);
        assert!(a.contains(&Action::Enc { enc: 0, clicks: 1 }));
        assert_eq!(&p.enc_clicks[..2], &[1, 1]); assert!(p.down[14]);
    }
    #[test]
    fn slow_key_drag_accumulates_aftertouch_threshold() {
        let mut p = PanelInput::new(Board::Fm1, 512);
        p.start(1, 80.0, 720.0);
        let mut actions = Vec::new();
        for y in 721..726 { actions.extend(p.moved(1, 80.0, y as f32)); }
        assert!(actions.iter().any(|a| matches!(a, Action::Pressure { id: 14, .. })));
        assert!(p.down[14]);
    }
    #[test]
    fn shared_note_pressure_uses_strongest_remaining_contact_or_keyboard() {
        let mut p = PanelInput::new(Board::Fm1, 512);
        p.start(1, 80.0, 780.0);
        let hard = panel::key_vel(14, 780.0);
        let soft = panel::key_vel(14, 700.0);
        assert!(p.start(2, 80.0, 700.0).is_empty());
        assert!(p.moved(2, 80.0, 705.0).is_empty());
        assert_eq!(p.pressure[14], hard);
        let actions = p.end(1);
        assert!(actions.contains(&Action::Pressure { id: 14, vel: panel::key_vel(14, 705.0) }));
        assert!(p.down[14]);
        let mut keys = [false; 64]; keys[14] = true;
        assert!(p.keyboard(keys, [false; 8]).contains(&Action::Pressure { id: 14, vel: 100 }));
        assert!(p.moved(2, 80.0, 700.0).is_empty());
        assert!(p.keyboard([false; 64], [false; 8]).contains(&Action::Pressure { id: 14, vel: soft }));
        assert_eq!(key_events(p.end(2)), [(14, false)]);
    }
    #[test]
    fn pads_and_pitch_obey_last_contact_and_focus_cancel() {
        let mut p = PanelInput::new(Board::Smk37, 512);
        p.start(1, 800.0, 250.0); p.start(2, 800.0, 250.0);
        p.start(3, 80.0, 90.0); p.start(4, 80.0, 120.0);
        p.end(1); p.end(3);
        assert_eq!(p.analog[0], 700); assert_ne!(p.analog[20], fm1_soc::smk::PITCH_REST);
        p.cancel(); assert_eq!(p.analog[0], 0); assert_eq!(p.analog[20], fm1_soc::smk::PITCH_REST);
    }
    #[test]
    fn faders_and_mod_remain_set_but_pitch_springs_back() {
        let mut p = PanelInput::new(Board::Smk37, 512);
        p.start(1, 1562.0, 90.0); p.moved(1, 1562.0, 200.0); let fader = p.analog[16];
        p.start(2, 170.0, 80.0); let modulation = p.analog[21];
        p.cancel(); assert_eq!(p.analog[16], fader); assert_eq!(p.analog[21], modulation);
    }
}
