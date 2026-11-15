# Native direct contacts

`fm1-touch` attaches a custom AppKit `NSGestureRecognizer` to a rendering view
on macOS 27 and later. It exposes independent contact IDs and start, move, end,
and cancel events. Coordinates are normalized to the view bounds, with y down;
captured contacts may move outside those bounds. `set_region` restricts only new
contacts, allowing other parts of an embedded editor to retain their own input.

Attach, drain and drop on AppKit's main thread. The Rust handle is neither `Send`
nor `Sync`. `attach_window` uses a standalone window's content view; `ChildSnapshot`
locates exactly one newly added embedded editor view without touching sibling
controls. Both attachment paths are unsafe because the supplied Objective-C
pointer must have the documented type and lifetime. Non-macOS attachment returns
`None`. The Objective-C bridge builds against older macOS SDKs as well: it checks
macOS 27 at runtime and accesses the new view exclusivity property dynamically.

Touch identities are copied dictionary keys compared semantically, rather than
NSTouch snapshot addresses. The bridge cancels on recognizer reset, system
cancellation, focus loss, window close or a window change. Its event queue is
bounded to 1024 entries, and its contact map to 64 contacts. Overflow explicitly
cancels already reported contacts before a fresh stream can begin. Dropping the
handle removes its recognizer and restores the rendering view's prior gesture
exclusivity setting when it is still unchanged.

The recognizer accepts direct touches only and leaves mouse, keyboard and indirect
trackpad handling to each frontend. AppKit's normal recognizer arbitration applies
to touch-to-mouse emulation; the standalone app also opts out of the extra framework
emulation with `NSIsTouchNative`. A plugin must not change its host application's
plist or window-wide gesture settings. Physical display delivery, simultaneous
real mouse input, DAW host arbitration, and system gestures require hardware tests.
This crate does not disable system gestures.

Validation:

```sh
cargo test -p fm1-touch
sh crates/fm1-touch/tests/run-macos-harness.sh
```

The native harness uses real AppKit views and the actual bridge with synthetic
contact snapshots. It verifies identity equality, independent capture and release,
coordinates, region filtering, cancellation/reset/focus/close behavior, bounded
queue recovery, child selection, and attachment teardown. It does not simulate
hardware touch delivery or AppKit's gesture gathering.

Apple references:

- [Handling AppKit gestures](https://developer.apple.com/documentation/appkit/handling-appkit-gestures)
- [Adopting gesture recognizers](https://developer.apple.com/documentation/appkit/adopting-gesture-recognizers-in-your-app)
- [NSIsTouchNative](https://developer.apple.com/documentation/bundleresources/information-property-list/nsistouchnative)
- [Touch support for games](https://developer.apple.com/documentation/technotes/tn3216-supporting-touch-input-for-games-on-macos)
