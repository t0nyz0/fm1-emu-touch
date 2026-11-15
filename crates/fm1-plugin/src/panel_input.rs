//! Independent panel contacts. Mouse and direct touches share ownership, so lifting one
//! finger never releases a key still held by another contact.
use crate::{panel, panel_smk};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Pointer {
    Mouse,
    Touch(u64),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Effect {
    Key(u8, bool),
    KeyVelocity(u8),
    Pressure(u8, u8),
    Velocity(f32),
    Turn(usize, i32),
    Analog(usize, u16),
    MasterBegin,
    MasterDelta(f32),
    MasterEnd,
}

struct Grab {
    ctl: i32,
    held: Option<u8>,
    last_y: f32,
    acc: f32,
    velocity: u8,
}

pub struct Input {
    contacts: BTreeMap<Pointer, Grab>,
    pressure: [u8; 64],
}

/// Host parameter writes can be deferred until the next audio block. Retain this
/// gesture's value so several queued moves never read the same stale host value.
#[derive(Default)]
pub struct MasterGesture {
    value: Option<f32>,
}
impl MasterGesture {
    pub fn begin(&mut self, host: f32) {
        self.value = Some(host);
    }
    pub fn end(&mut self) {
        self.value = None;
    }
    pub fn adjust(&mut self, host: f32, delta: f32) -> f32 {
        let value = (self.value.unwrap_or(host) + delta).clamp(0.0, 1.0);
        if self.value.is_some() {
            self.value = Some(value);
        }
        value
    }
}

impl Default for Input {
    fn default() -> Self {
        Self {
            contacts: BTreeMap::new(),
            pressure: [0; 64],
        }
    }
}

impl Input {
    pub fn master_active(&self) -> bool {
        self.contacts.values().any(|g| g.ctl == 7)
    }

    pub fn start(&mut self, id: Pointer, smk: bool, x: f32, y: f32) -> Vec<Effect> {
        let mut out = self.end(id, smk);
        if !x.is_finite() || !y.is_finite() {
            return out;
        }
        let ctl = hit(smk, x, y);
        let shared = (100..200).contains(&ctl) || (smk && (200..216).contains(&ctl));
        if ctl < 0 || (!shared && self.contacts.values().any(|g| g.ctl == ctl)) {
            return out;
        }
        let held = (100..200).contains(&ctl).then_some((ctl - 100) as u8);
        let old = self.held();
        let velocity = key_velocity(smk, ctl, x, y);
        self.contacts.insert(
            id,
            Grab {
                ctl,
                held,
                last_y: y,
                acc: 0.0,
                velocity,
            },
        );
        self.keys_changed(old, smk, x, y, &mut out);
        if smk && ctl >= 200 {
            slide(ctl, y, &mut out);
        }
        if !smk && ctl == 7 {
            out.push(Effect::MasterBegin);
        }
        out
    }

    pub fn moved(&mut self, id: Pointer, smk: bool, x: f32, y: f32) -> Vec<Effect> {
        if !x.is_finite() || !y.is_finite() {
            return self.end(id, smk);
        }
        let old = self.held();
        let Some(g) = self.contacts.get_mut(&id) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let keys = if smk { 0..37 } else { 14..41 };
        if keys.contains(&(g.ctl - 100)) {
            let h = hit(smk, x, y) - 100;
            let held = keys.contains(&h).then_some(h as u8);
            let velocity = key_velocity(smk, h + 100, x, y);
            g.held = held;
            g.velocity = velocity;
        } else if smk && g.ctl >= 300 {
            slide(g.ctl, y, &mut out);
        } else if (0..if smk { 8 } else { 7 }).contains(&g.ctl) {
            g.acc += g.last_y - y;
            let clicks = (g.acc / 12.0).trunc() as i32;
            g.acc -= clicks as f32 * 12.0;
            if clicks != 0 {
                out.push(Effect::Turn(g.ctl as usize, clicks));
            }
        } else if !smk && g.ctl == 7 {
            out.push(Effect::MasterDelta((g.last_y - y) * 4.0 / 1023.0));
        }
        g.last_y = y;
        self.keys_changed(old, smk, x, y, &mut out);
        out
    }

    pub fn end(&mut self, id: Pointer, smk: bool) -> Vec<Effect> {
        let old = self.held();
        let Some(g) = self.contacts.remove(&id) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        self.keys_changed(old, smk, 0.0, 0.0, &mut out);
        if smk
            && (200..216).contains(&g.ctl)
            && !self.contacts.values().any(|other| other.ctl == g.ctl)
        {
            out.push(Effect::Analog((g.ctl - 200) as usize, 0));
        }
        if smk && g.ctl == 400 {
            out.push(Effect::Analog(
                fm1_soc::smk::ANALOG_PITCH as usize,
                fm1_soc::smk::PITCH_REST,
            ));
        }
        if !smk && g.ctl == 7 {
            out.push(Effect::MasterEnd);
        }
        out
    }

    pub fn cancel(&mut self, smk: bool) -> Vec<Effect> {
        let ids: Vec<_> = self.contacts.keys().copied().collect();
        ids.into_iter().flat_map(|id| self.end(id, smk)).collect()
    }

    fn held(&self) -> [bool; 64] {
        let mut held = [false; 64];
        for g in self.contacts.values() {
            if let Some(k) = g.held {
                held[k as usize] = true;
            }
        }
        held
    }

    fn keys_changed(&mut self, old: [bool; 64], smk: bool, x: f32, y: f32, out: &mut Vec<Effect>) {
        let new = self.held();
        let mut force = [0u8; 64];
        for g in self.contacts.values() {
            if let Some(k) = g.held {
                force[k as usize] = force[k as usize].max(g.velocity);
            }
        }
        for k in 0..64 {
            if old[k] && !new[k] {
                out.push(Effect::Key(k as u8, false));
                self.pressure[k] = 0;
            }
        }
        for k in 0..64 {
            if !old[k] && new[k] {
                if smk && k < 37 {
                    let f = match panel_smk::hit(x, y) {
                        Some(panel_smk::Ctl::Key(_, f)) => f,
                        _ => 0.5,
                    };
                    out.push(Effect::Velocity(f));
                } else if !smk && k >= 14 {
                    out.push(Effect::KeyVelocity(force[k]));
                    self.pressure[k] = force[k];
                }
                out.push(Effect::Key(k as u8, true));
            } else if !smk && k >= 14 && new[k] && force[k].abs_diff(self.pressure[k]) >= 4 {
                self.pressure[k] = force[k];
                out.push(Effect::Pressure(k as u8, force[k]));
            }
        }
    }
}

pub fn hit(smk: bool, x: f32, y: f32) -> i32 {
    if smk {
        return match panel_smk::hit(x, y) {
            Some(panel_smk::Ctl::Enc(i)) => i as i32,
            Some(panel_smk::Ctl::Btn(id)) | Some(panel_smk::Ctl::Key(id, _)) => 100 + id as i32,
            Some(panel_smk::Ctl::Pad(p)) => 200 + p as i32,
            Some(panel_smk::Ctl::Fader(f)) => 300 + f as i32,
            Some(panel_smk::Ctl::Pitch) => 400,
            Some(panel_smk::Ctl::Mod) => 401,
            None => -1,
        };
    }
    match panel::hit(x, y) {
        Some(panel::Ctl::Enc(i)) => i as i32,
        Some(panel::Ctl::Pot) => 7,
        Some(panel::Ctl::Btn(id)) | Some(panel::Ctl::Key(id)) => 100 + id as i32,
        None => -1,
    }
}

fn key_velocity(smk: bool, ctl: i32, _x: f32, y: f32) -> u8 {
    if !smk && (114..141).contains(&ctl) {
        panel::key_vel((ctl - 100) as u8, y)
    } else {
        100
    }
}

fn slide(ctl: i32, y: f32, out: &mut Vec<Effect>) {
    if ctl < 300 {
        out.push(Effect::Analog((ctl - 200) as usize, 700));
    } else if ctl < 400 {
        let f = (ctl - 300) as usize;
        out.push(Effect::Analog(16 + f, panel_smk::fader_value(f, y)));
    } else {
        let pitch = ctl == 400;
        out.push(Effect::Analog(
            if pitch { 20 } else { 21 },
            panel_smk::wheel_value(pitch, y),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn at(smk: bool, ctl: i32) -> (f32, f32) {
        let (w, h) = if smk {
            (panel_smk::W, panel_smk::H)
        } else {
            (panel::W, panel::H)
        };
        for y in (0..h).step_by(2) {
            for x in (0..w).step_by(2) {
                if hit(smk, x as f32, y as f32) == ctl {
                    return (x as f32, y as f32);
                }
            }
        }
        panic!("missing control {ctl}");
    }
    #[test]
    fn chord_and_shared_mouse_key_release_only_last_owner() {
        let mut i = Input::default();
        let (x, y) = at(false, 121);
        let (x2, y2) = at(false, 125);
        assert!(i
            .start(Pointer::Mouse, false, x, y)
            .contains(&Effect::Key(21, true)));
        assert!(!i
            .start(Pointer::Touch(1), false, x, y)
            .contains(&Effect::Key(21, true)));
        assert!(i
            .start(Pointer::Touch(2), false, x2, y2)
            .contains(&Effect::Key(25, true)));
        assert!(!i
            .end(Pointer::Mouse, false)
            .contains(&Effect::Key(21, false)));
        assert!(i
            .end(Pointer::Touch(1), false)
            .contains(&Effect::Key(21, false)));
        assert!(i
            .end(Pointer::Touch(2), false)
            .contains(&Effect::Key(25, false)));
    }
    #[test]
    fn glissando_leaves_keys_and_recovers_without_stuck_notes() {
        let mut i = Input::default();
        let (x, y) = at(false, 121);
        let (x2, y2) = at(false, 125);
        i.start(Pointer::Touch(1), false, x, y);
        let moved = i.moved(Pointer::Touch(1), false, x2, y2);
        assert_eq!(moved.first(), Some(&Effect::Key(21, false)));
        assert_eq!(moved.last(), Some(&Effect::Key(25, true)));
        assert!(i
            .moved(Pointer::Touch(1), false, -20.0, -20.0)
            .contains(&Effect::Key(25, false)));
        assert!(i
            .moved(Pointer::Touch(1), false, x, y)
            .contains(&Effect::Key(21, true)));
        assert_eq!(i.cancel(false), vec![Effect::Key(21, false)]);
        assert!(i.cancel(false).is_empty());
    }
    #[test]
    fn independent_knobs_and_master_gesture_cancel() {
        let mut i = Input::default();
        let (x, y) = at(false, 0);
        let (x2, y2) = at(false, 1);
        let (mx, my) = at(false, 7);
        i.start(Pointer::Touch(1), false, x, y);
        i.start(Pointer::Touch(2), false, x2, y2);
        assert_eq!(
            i.moved(Pointer::Touch(1), false, x, y - 24.0),
            vec![Effect::Turn(0, 2)]
        );
        assert_eq!(
            i.moved(Pointer::Touch(2), false, x2, y2 + 12.0),
            vec![Effect::Turn(1, -1)]
        );
        assert_eq!(
            i.start(Pointer::Touch(3), false, mx, my),
            vec![Effect::MasterBegin]
        );
        assert!(i.start(Pointer::Touch(4), false, mx, my).is_empty());
        assert_eq!(i.cancel(false), vec![Effect::MasterEnd]);
    }
    #[test]
    fn smk_pad_pitch_and_chord_cancel() {
        let mut i = Input::default();
        let (x, y) = at(true, 112);
        let (px, py) = at(true, 200);
        let (wx, wy) = at(true, 400);
        i.start(Pointer::Touch(1), true, x, y);
        i.start(Pointer::Touch(2), true, px, py);
        i.start(Pointer::Touch(3), true, wx, wy);
        let out = i.cancel(true);
        assert!(out.contains(&Effect::Key(12, false)));
        assert!(out.contains(&Effect::Analog(0, 0)));
        assert!(out.contains(&Effect::Analog(20, fm1_soc::smk::PITCH_REST)));
    }
    #[test]
    fn strongest_key_contact_owns_pressure_until_it_leaves() {
        let mut i = Input::default();
        let (_, x, y, w, h, _) = panel::keys().into_iter().find(|key| key.0 == 21).unwrap();
        let (x, soft, hard) = (
            x as f32 + w as f32 / 2.0,
            y as f32 + 10.0,
            (y + h - 5) as f32,
        );
        let soft_force = panel::key_vel(21, soft);
        let hard_force = panel::key_vel(21, hard);
        i.start(Pointer::Touch(1), false, x, hard);
        assert!(!i
            .start(Pointer::Touch(2), false, x, soft)
            .iter()
            .any(|e| matches!(e, Effect::Pressure(..))));
        assert!(!i
            .moved(Pointer::Touch(2), false, x, soft + 5.0)
            .iter()
            .any(|e| matches!(e, Effect::Pressure(..))));
        assert_eq!(
            i.end(Pointer::Touch(1), false),
            vec![Effect::Pressure(21, panel::key_vel(21, soft + 5.0))]
        );
        assert!(hard_force > soft_force);
        assert_eq!(
            i.end(Pointer::Touch(2), false),
            vec![Effect::Key(21, false)]
        );
    }
    #[test]
    fn repeated_small_pressure_moves_accumulate_and_shared_pad_keeps_gate() {
        let mut i = Input::default();
        let (x, y) = at(false, 121);
        i.start(Pointer::Touch(1), false, x, y);
        let mut out = Vec::new();
        for offset in 1..12 {
            out.extend(i.moved(Pointer::Touch(1), false, x, y + offset as f32));
        }
        assert!(out.iter().any(|e| matches!(e, Effect::Pressure(21, _))));
        i.cancel(false);
        let (px, py) = at(true, 200);
        i.start(Pointer::Mouse, true, px, py);
        i.start(Pointer::Touch(2), true, px, py);
        assert!(!i.end(Pointer::Mouse, true).contains(&Effect::Analog(0, 0)));
        assert_eq!(i.end(Pointer::Touch(2), true), vec![Effect::Analog(0, 0)]);
    }
    #[test]
    fn master_moves_accumulate_when_host_parameter_updates_are_deferred() {
        let mut master = MasterGesture::default();
        master.begin(0.5);
        assert!((master.adjust(0.5, 0.01) - 0.51).abs() < 0.00001);
        assert!((master.adjust(0.5, 0.01) - 0.52).abs() < 0.00001);
        assert!((master.adjust(0.5, 0.01) - 0.53).abs() < 0.00001);
        assert_eq!(master.adjust(0.5, 2.0), 1.0);
        master.end();
        master.begin(0.25);
        assert!((master.adjust(0.5, 0.01) - 0.26).abs() < 0.00001);
    }
}
