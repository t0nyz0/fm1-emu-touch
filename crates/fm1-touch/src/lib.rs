//! Direct display contacts delivered through an AppKit gesture recognizer.
//!
//! The handle belongs to the main thread. Attach it to the *rendering* NSView,
//! rather than a host application's entire window. Mouse, keyboard and indirect
//! trackpad input remain owned by the existing frontend. Older macOS releases and
//! other platforms return `None` and keep those existing input paths.

#[cfg(any(target_os = "macos", test))]
use std::collections::BTreeMap;
use std::ffi::c_void;
use std::marker::PhantomData;
use std::rc::Rc;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Phase {
    Start,
    Move,
    End,
    Cancel,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Event {
    /// Stable for one contact's lifetime; independent of other contacts.
    pub id: u64,
    pub phase: Phase,
    /// Position relative to the view bounds, with (0, 0) at the top left.
    /// Coordinates may leave 0..=1 during capture, so clients can release a key
    /// when a finger leaves the rendered panel.
    pub x: f32,
    pub y: f32,
}

/// An attached direct-touch recognizer. Must be attached, drained and dropped on
/// the AppKit main thread. It deliberately cannot be sent or shared across threads.
pub struct TouchInput {
    #[cfg(target_os = "macos")]
    native: std::ptr::NonNull<c_void>,
    #[cfg(any(target_os = "macos", test))]
    reported: BTreeMap<u64, Event>,
    _main_thread: PhantomData<Rc<()>>,
}

impl TouchInput {
    /// Attach to a rendering NSView. Returns `None` without modifying the view
    /// when direct display input is unavailable (before macOS 27).
    ///
    /// # Safety
    /// `view` must be a valid Objective-C NSView pointer on the AppKit main
    /// thread. The host must keep its UI event loop running and drop this handle
    /// before disposing the editor. AppKit owns the recognizer attachment.
    pub unsafe fn attach(view: *mut c_void) -> Option<Self> {
        #[cfg(target_os = "macos")]
        {
            let native = std::ptr::NonNull::new(unsafe { fm1_touch_attach(view, false) })?;
            Some(Self {
                native,
                reported: BTreeMap::new(),
                _main_thread: PhantomData,
            })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = view;
            None
        }
    }

    /// Attach to an NSWindow's content view (for minifb).
    ///
    /// # Safety
    /// `window` must be a valid NSWindow pointer on the AppKit main thread;
    /// otherwise the same requirements as [`Self::attach`] apply.
    pub unsafe fn attach_window(window: *mut c_void) -> Option<Self> {
        #[cfg(target_os = "macos")]
        {
            let native = std::ptr::NonNull::new(unsafe { fm1_touch_attach(window, true) })?;
            Some(Self {
                native,
                reported: BTreeMap::new(),
                _main_thread: PhantomData,
            })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = window;
            None
        }
    }

    /// Drain contacts in arrival order. Queue overflow cancels all contacts
    /// already reported to the caller before any newly gathered contacts.
    pub fn drain(&mut self) -> Vec<Event> {
        #[cfg(target_os = "macos")]
        {
            let mut raw = [RawEvent::default(); QUEUE_CAPACITY];
            let mut reset = false;
            let count = unsafe {
                fm1_touch_drain(
                    self.native.as_ptr(),
                    raw.as_mut_ptr(),
                    raw.len(),
                    &mut reset,
                )
            };
            self.accept(reset, &raw[..count])
        }
        #[cfg(not(target_os = "macos"))]
        {
            Vec::new()
        }
    }

    /// Limit new contacts to a rectangle in normalized view coordinates. Existing
    /// contacts remain captured outside it. A zero-sized region disables starts.
    /// Returns false for negative dimensions or non-finite coordinates.
    pub fn set_region(&mut self, region: [f32; 4]) -> bool {
        if !region.iter().all(|v| v.is_finite()) || region[2] < 0.0 || region[3] < 0.0 {
            return false;
        }
        #[cfg(target_os = "macos")]
        unsafe {
            fm1_touch_region(
                self.native.as_ptr(),
                region[0],
                region[1],
                region[2],
                region[3],
            );
        }
        true
    }

    #[cfg(any(target_os = "macos", test))]
    fn accept(&mut self, reset: bool, raw: &[RawEvent]) -> Vec<Event> {
        let mut events = Vec::with_capacity(raw.len() + self.reported.len());
        if reset {
            events.extend(self.reported.values().map(|event| Event {
                phase: Phase::Cancel,
                ..*event
            }));
            self.reported.clear();
        }
        for raw in raw {
            let phase = match raw.phase {
                0 => Phase::Start,
                1 => Phase::Move,
                2 => Phase::End,
                3 => Phase::Cancel,
                _ => continue,
            };
            let event = Event {
                id: raw.id,
                phase,
                x: raw.x,
                y: raw.y,
            };
            match phase {
                Phase::Start => {
                    self.reported.insert(event.id, event);
                }
                Phase::Move if self.reported.contains_key(&event.id) => {
                    self.reported.insert(event.id, event);
                }
                Phase::Move => continue,
                Phase::End | Phase::Cancel => {
                    self.reported.remove(&event.id);
                }
            }
            events.push(event);
        }
        events
    }
}

/// A retained snapshot of a plugin host view's immediate children. This lets an
/// editor attach to its own newly created renderer without class-name guesses or
/// placing a recognizer on unrelated controls in the host window.
pub struct ChildSnapshot {
    #[cfg(target_os = "macos")]
    native: std::ptr::NonNull<c_void>,
    _main_thread: PhantomData<Rc<()>>,
}

impl ChildSnapshot {
    /// Capture a host view before spawning an embedded editor.
    ///
    /// # Safety
    /// `parent` must be a valid NSView pointer on the AppKit main thread.
    pub unsafe fn capture(parent: *mut c_void) -> Option<Self> {
        #[cfg(target_os = "macos")]
        {
            Some(Self {
                native: std::ptr::NonNull::new(unsafe { fm1_touch_children(parent) })?,
                _main_thread: PhantomData,
            })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = parent;
            None
        }
    }

    /// Attach to exactly one immediate child added since capture. Zero or
    /// multiple new children return None; unrelated existing views are ignored.
    ///
    /// # Safety
    /// Must be called on the AppKit main thread after synchronous editor spawn.
    pub unsafe fn attach_new_child(self) -> Option<TouchInput> {
        #[cfg(target_os = "macos")]
        {
            Some(TouchInput {
                native: std::ptr::NonNull::new(unsafe {
                    fm1_touch_new_child(self.native.as_ptr())
                })?,
                reported: BTreeMap::new(),
                _main_thread: PhantomData,
            })
        }
        #[cfg(not(target_os = "macos"))]
        {
            None
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for ChildSnapshot {
    fn drop(&mut self) {
        unsafe { fm1_touch_children_free(self.native.as_ptr()) }
    }
}

#[cfg(target_os = "macos")]
impl Drop for TouchInput {
    fn drop(&mut self) {
        unsafe { fm1_touch_detach(self.native.as_ptr()) }
    }
}

#[cfg(target_os = "macos")]
const QUEUE_CAPACITY: usize = 1024;

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Default)]
#[repr(C)]
struct RawEvent {
    id: u64,
    phase: u32,
    x: f32,
    y: f32,
}

#[cfg(target_os = "macos")]
extern "C" {
    fn fm1_touch_attach(view_or_window: *mut c_void, window: bool) -> *mut c_void;
    fn fm1_touch_drain(
        handle: *mut c_void,
        events: *mut RawEvent,
        capacity: usize,
        reset: *mut bool,
    ) -> usize;
    fn fm1_touch_detach(handle: *mut c_void);
    fn fm1_touch_region(handle: *mut c_void, left: f32, top: f32, width: f32, height: f32);
    fn fm1_touch_children(parent: *mut c_void) -> *mut c_void;
    fn fm1_touch_new_child(snapshot: *mut c_void) -> *mut c_void;
    fn fm1_touch_children_free(snapshot: *mut c_void);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> TouchInput {
        TouchInput {
            #[cfg(target_os = "macos")]
            native: std::ptr::NonNull::dangling(),
            reported: BTreeMap::new(),
            _main_thread: PhantomData,
        }
    }

    fn raw(id: u64, phase: u32, x: f32) -> RawEvent {
        RawEvent {
            id,
            phase,
            x,
            y: 0.5,
        }
    }

    #[test]
    fn overflow_cancels_every_reported_contact_before_new_starts() {
        // ManuallyDrop: this exercises the pure reducer without an AppKit object.
        let mut input = std::mem::ManuallyDrop::new(input());
        input.accept(false, &[raw(1, 0, 0.1), raw(2, 0, 0.2)]);
        input.accept(false, &[raw(1, 1, 0.3)]);
        let events = input.accept(true, &[raw(3, 0, 0.4)]);
        assert_eq!(
            events.iter().map(|e| (e.id, e.phase)).collect::<Vec<_>>(),
            [(1, Phase::Cancel), (2, Phase::Cancel), (3, Phase::Start)]
        );
        assert_eq!(events[0].x, 0.3);
        assert_eq!(input.reported.keys().copied().collect::<Vec<_>>(), [3]);
    }

    #[test]
    fn independent_end_and_cancel_keep_other_contacts_and_ignore_stale_moves() {
        let mut input = std::mem::ManuallyDrop::new(input());
        input.accept(false, &[raw(1, 0, 0.1), raw(2, 0, 0.2)]);
        let events = input.accept(false, &[raw(1, 2, -0.1), raw(1, 1, 0.5), raw(2, 1, 0.6)]);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].phase, Phase::End);
        assert_eq!(events[0].x, -0.1);
        assert_eq!(input.reported.len(), 1);
        input.accept(false, &[raw(2, 3, 0.6)]);
        assert!(input.reported.is_empty());
        assert!(input.accept(true, &[]).is_empty());
    }
}
