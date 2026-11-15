//! Scope native touch to this editor's newly created rendering view, never the host window.
use crate::editor::{send_effect, SharedInput};
use crate::{Fm1Params, Link};
use nih_plug::prelude::*;
use std::any::Any;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
pub fn new_session() -> u64 {
    NEXT_SESSION.fetch_add(1, Ordering::Relaxed)
}

#[cfg(target_os = "macos")]
thread_local! {
    // AppKit objects stay on their UI thread; only the numeric session crosses threads.
    static TOUCH: std::cell::RefCell<std::collections::HashMap<u64, fm1_touch::TouchInput>> = Default::default();
}

pub fn drain(session: u64, region: [f32; 4]) -> Vec<fm1_touch::Event> {
    #[cfg(target_os = "macos")]
    return TOUCH.with(|touch| {
        let mut touch = touch.borrow_mut();
        let Some(input) = touch.get_mut(&session) else {
            return Vec::new();
        };
        input.set_region(region);
        input.drain()
    });
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (session, region);
        Vec::new()
    }
}

pub fn wrap(
    inner: Box<dyn Editor>,
    session: u64,
    input: SharedInput,
    params: Arc<Fm1Params>,
    link: Arc<Link>,
) -> Box<dyn Editor> {
    Box::new(TouchEditor {
        inner,
        session,
        input,
        params,
        link,
    })
}

struct TouchEditor {
    inner: Box<dyn Editor>,
    session: u64,
    input: SharedInput,
    params: Arc<Fm1Params>,
    link: Arc<Link>,
}

impl Editor for TouchEditor {
    fn spawn(
        &self,
        parent: ParentWindowHandle,
        context: Arc<dyn GuiContext>,
    ) -> Box<dyn Any + Send> {
        #[cfg(target_os = "macos")]
        let snapshot = match parent {
            ParentWindowHandle::AppKitNsView(view) => unsafe {
                fm1_touch::ChildSnapshot::capture(view)
            },
            _ => None,
        };
        let editor = self.inner.spawn(parent, context.clone());
        #[cfg(target_os = "macos")]
        if let Some(snapshot) = snapshot {
            // baseview adds its own child synchronously during spawn. Exactly one new child
            // is required, so a host's unrelated views can never become our input surface.
            if let Some(mut touch) = unsafe { snapshot.attach_new_child() } {
                touch.set_region([0.0; 4]); // enabled after egui has laid out the panel
                TOUCH.with(|inputs| {
                    inputs.borrow_mut().insert(self.session, touch);
                });
            }
        }
        Box::new(TouchHandle {
            _editor: editor,
            session: self.session,
            input: self.input.clone(),
            params: self.params.clone(),
            link: self.link.clone(),
            context,
        })
    }
    fn size(&self) -> (u32, u32) {
        self.inner.size()
    }
    fn set_scale_factor(&self, factor: f32) -> bool {
        self.inner.set_scale_factor(factor)
    }
    fn param_value_changed(&self, id: &str, v: f32) {
        self.inner.param_value_changed(id, v);
    }
    fn param_modulation_changed(&self, id: &str, v: f32) {
        self.inner.param_modulation_changed(id, v);
    }
    fn param_values_changed(&self) {
        self.inner.param_values_changed();
    }
}

struct TouchHandle {
    _editor: Box<dyn Any + Send>,
    session: u64,
    input: SharedInput,
    params: Arc<Fm1Params>,
    link: Arc<Link>,
    context: Arc<dyn GuiContext>,
}

impl Drop for TouchHandle {
    fn drop(&mut self) {
        let (smk, effects) = {
            let mut state = self.input.lock().unwrap();
            let smk = state.0;
            (smk, state.1.cancel(smk))
        };
        let setter = ParamSetter::new(self.context.as_ref());
        for effect in effects {
            send_effect(&self.params, &self.link, &setter, smk, effect);
        }
        #[cfg(target_os = "macos")]
        {
            let removed = TOUCH.with(|inputs| inputs.borrow_mut().remove(&self.session).is_some());
            if !removed {
                let session = self.session;
                dispatch2::DispatchQueue::main().exec_async(move || {
                    TOUCH.with(|inputs| {
                        inputs.borrow_mut().remove(&session);
                    });
                });
            }
        }
    }
}
