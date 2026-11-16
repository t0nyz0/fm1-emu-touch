# Direct touchscreen input on macOS

This fork adds a native direct-touch input path for macOS 27 and later, including
the MacBook Pro with PROLED XDR display. It is separate from the Touch Bar and
indirect trackpad gestures. The original project's MIT licence, credits, firmware
ownership and plugin dependency licences continue to apply.

The browser already uses Pointer Events and per-pointer capture. Native
`fm1-live` and the plugin need AppKit's direct display input, which is delivered
to gesture recognizers starting with macOS 27. `crates/fm1-touch` attaches a custom
`NSGestureRecognizer` to the rendering view, accepts only `NSTouchTypeDirect`,
and retains semantic contact identities. Coordinates are normalized to the view
with the origin at the top left, then mapped into the rendered panel by each
frontend. Mouse, keyboard, MIDI and other platforms keep their existing input
sources.

## Browser version

Play the fork at [t0nyz0.github.io/fm1-emu-touch](https://t0nyz0.github.io/fm1-emu-touch/).
The fork's Pages workflow tests and builds FM-1, SMK-37 and the pinned SID player
before deployment. `/build.json` identifies the exact published source commit.
The original project's releases remain linked and clearly attributed separately
from this fork's source.

The default browser input uses Pointer Events and per-pointer capture. It already
handles independent contacts where a browser actually supplies them. Safari and
Firefox on the tested PROLED Mac exposed a mouse-compatible pointer rather than
independent touch contacts. Synthetic multi-pointer tests validate our ownership
logic, not physical browser delivery.

The local direct-code port adds a dependency-free `web/gesture-input.js`:

- Wheel input is normalized from pixels, lines or pages. Encoder remainders are
  isolated per control and cleared on input resets. Ctrl/Command-wheel does not
  change synth parameters; it remains available for browser zoom.
- Both instrument pages offer an **off-by-default Safari estimated two-note
  trial**. It reconstructs two positions from a first-point anchor plus Safari
  gesture center, scale and rotation. It does not expose real contact identities.
- Estimated hits are restricted to musical keys. They cannot operate recording,
  transport buttons, pads, sliders or knobs. Firmware still determines what a
  key press does in its current mode. The first normal pointer's
  note is transferred without retriggering it, and keyboard/MIDI owners remain
  independent.
- Tracking ends on gesture end, invalid geometry, viewport changes, focus loss,
  page hiding, firmware changes, disable or **500 ms without updates**. Both
  model notes are released and later updates cannot revive that trial. Press
  **Re-arm** before another trial.

This experiment does **not** support dependable held chords, independent finger
lifts or three-plus contacts. A motionless chord is deliberately cut off after
500 ms, because silence cannot establish whether either finger is still down.
The assumed live centroid and stationary initial anchor can also be wrong. The
underlying estimator was visually tested in an ordinary Safari tab on this Mac;
**the integrated FM-1 musical experiment still needs a physical test**. Firefox's
verified aggregate zoom does not establish independently playable fingers.

To try the local candidate: start the emulator, expand **Experimental Safari
two-finger input**, enable the trial, hold one screen finger still on a key, then
add a second and move gently. A/B outlines are explicitly estimated. Re-arm after
each trial; disable to return to normal panel input. **Release local notes** ends
local keyboard/pointer/model holds without stopping separately held MIDI notes.

No use-gesture, React or prototype package dependency is added. No global capture,
browser settings or system permissions are required. Existing real pointer,
keyboard, MIDI and native AppKit input paths remain in place.

## Native panels

The contact state tracks each finger independently. Keys and buttons remain
held until their last owner lets go, fingers can slide across keys, and each knob
drag keeps its own accumulated movement. Pads and pitch wheels have release
behavior as well as key-up events. Cancellation, focus loss and editor/window
teardown must release held controls. The native event queue is bounded; overflow
cancels the previously delivered contact stream instead of leaving controls held.

AppKit's macOS 27 view gesture exclusivity is disabled only on the attached view;
the plugin does not change the DAW's application-wide defaults. Older macOS
versions return no direct-touch attachment. The native bridge builds on older
SDKs too, with availability checks for the newer view behavior.

`fm1-live` embeds `NSIsTouchNative=YES` in its executable's Info.plist to opt out
of AppKit's extra compatibility mouse-emulation recognizers. The plugin uses an
immediately recognizing gesture recognizer on its own view; it does not change
the host's Info.plist. Host gesture arbitration and simultaneous real mouse use
remain part of physical host acceptance. macOS system gestures may cancel
multi-finger chords; the cancellation path releases contacts when this happens.

## Build and automated checks

Use a current stable Rust toolchain and Xcode's macOS SDK. No application or
plugin installation is needed for these checks:

```sh
cargo test --locked -p fm1-touch -p fm1-live
sh crates/fm1-touch/tests/run-macos-harness.sh  # macOS; synthetic contacts, real AppKit objects
cargo test --locked -p fm1-isa -p fm1-core -p fm1-soc -p fm1-web
node --test web/*.test.mjs
node tools/fetch_firmwares.mjs felucca
CARGO_PROFILE_RELEASE_OVERFLOW_CHECKS=true cargo test --release --locked --manifest-path crates/fm1-plugin/Cargo.toml
NO_INSTALL=1 tools/build_plugin.sh
```

The plugin build requires CMake and Ninja. `NO_INSTALL=1` leaves the CLAP, AU and
VST3 under `target/plugin/`; omitting it invokes the upstream installer. Do not
omit it when testing a candidate alongside existing plugins.

The `Native touch regression tests` GitHub Actions workflow checks the native
contact state on macOS, Windows and Linux, plus the plugin on macOS. These tests
exercise state transitions and native build/lifecycle behavior, not a physical
touchscreen digitizer.

The plugin's new direct-touch region is the instrument panel. Its toolbar keeps
the host/framework's normal input and compatibility emulation. Test that toolbar
separately in each DAW; this change does not replace the host's input system.

## Physical device acceptance

The initial change was developed against the connected Mac's macOS 27.2 SDK.
Physical touchscreen input has **not** been tested. Before describing hardware
support as verified, run the following with sound on a PROLED touchscreen Mac:

1. Hold a chord with several fingers, including two fingers on one key. Release
   them one at a time; the shared key must remain held until the last finger lifts.
2. Keep one note held while another finger slides across keys and leaves/reenters
   the keybed. Try short taps and simultaneous lifts.
3. Turn two knobs independently while holding notes, then combine touch with a
   real mouse, computer keyboard and MIDI keyboard.
4. On SMK-37, hold separate pads, move a fader and pitch wheel, and cancel the
   gesture. Pads must release and pitch must return to its rest value.
5. Switch windows, open a firmware dialog, close/reopen the editor, load a new
   firmware and disconnect the touchscreen while fingers are held. No note,
   button, pad or parameter automation gesture should remain held.
6. Repeat in standalone, AU, VST3 and CLAP hosts. Check resized windows, Retina
   scaling, panel margins and multiple plugin instances. Touching one plugin
   instance must not affect another or controls elsewhere in the host.
7. Confirm ordinary mouse/trackpad, computer keyboard and MIDI behavior on a
   non-touch Mac, and run native tests/builds on Linux and Windows.

## Apple API references

- [AppKit gestures](https://developer.apple.com/documentation/appkit/gestures.md)
- [Handling AppKit gestures](https://developer.apple.com/documentation/appkit/handling-appkit-gestures.md)
- [NSTouch identity](https://developer.apple.com/documentation/appkit/nstouch/identity.md)
- [View gesture exclusivity](https://developer.apple.com/documentation/appkit/nsview/exclusivegesturebehavior-swift.property.md)
- [Native touch opt-in](https://developer.apple.com/documentation/bundleresources/information-property-list/nsistouchnative.md)

Responder `touchesBegan` overrides for indirect trackpad events are insufficient
for direct display touches. Aggregate pan translation also cannot identify
independent contacts, which is why this uses a custom recognizer.
