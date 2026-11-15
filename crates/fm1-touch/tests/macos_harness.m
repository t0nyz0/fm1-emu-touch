// Synthetic contact snapshots exercise the actual Objective-C bridge and AppKit
// attachment lifecycle. They do not emulate hardware delivery/hit-testing.
#include "../src/macos.m"
#include <assert.h>
#include <math.h>
#include <stdio.h>

@interface FM1TestTouch : NSObject
@property(copy) NSString *testIdentity;
@property NSPoint testPoint;
@property NSTouchType testType;
@end

@interface FM1CancelledTestGesture : NSGestureRecognizer
@end
@implementation FM1CancelledTestGesture
- (NSGestureRecognizerState)state { return NSGestureRecognizerStateCancelled; }
@end

@interface FM1TestRenderingView : NSView
@end
@implementation FM1TestRenderingView
- (BOOL)acceptsFirstResponder { return YES; }
@end
@implementation FM1TestTouch
- (id)identity { return self.testIdentity; }
- (NSPoint)locationInView:(NSView *)view { (void)view; return self.testPoint; }
- (NSTouchType)type { return self.testType; }
@end

static NSTouch *touch(NSString *identity, CGFloat x, CGFloat y, NSTouchType type) {
    FM1TestTouch *touch = [FM1TestTouch new];
    // Mutable copies exercise semantic equality across distinct snapshot keys.
    touch.testIdentity = [identity mutableCopy];
    touch.testPoint = NSMakePoint(x, y);
    touch.testType = type;
    return (id)touch;
}

static NSUInteger drain(void *handle, FM1TouchEvent *events, bool *reset) {
    return fm1_touch_drain(handle, events, FM1TouchQueueCapacity, reset);
}

static void identityAndLifecycle(NSWindow *window) {
    NSView *view = window.contentView;
    NSInteger exclusivity = FM1Exclusivity(view);
    NSUInteger before = view.gestureRecognizers.count;
    void *handle = fm1_touch_attach((__bridge void *)window, true);
    assert(handle);
    FM1DirectTouchRecognizer *recognizer = (__bridge id)handle;
    assert(view.gestureRecognizers.count == before + 1);
    assert(FM1Exclusivity(view) == 2);
    [recognizer processTouches:@[touch(@"a", 20, 30, NSTouchTypeDirect),
        touch(@"b", 40, 50, NSTouchTypeDirect), touch(@"trackpad", 80, 80, NSTouchTypeIndirect)] phase:0];
    FM1TouchEvent events[FM1TouchQueueCapacity];
    bool reset;
    assert(drain(handle, events, &reset) == 2 && !reset);
    uint64_t a = events[0].id, b = events[1].id;
    assert(a != b && events[0].phase == 0 && events[1].phase == 0);
    NSEvent *mouse = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:NSZeroPoint
        modifierFlags:0 timestamp:0 windowNumber:window.windowNumber context:nil
        eventNumber:1 clickCount:1 pressure:1];
    assert(mouse && ![recognizer gestureRecognizer:recognizer shouldAttemptToRecognizeWithEvent:mouse]);
    assert(fabsf(events[0].x - 0.2f) < 0.0001 && fabsf(events[0].y - 0.7f) < 0.0001);
    [recognizer processTouches:@[touch(@"a", -20, 70, NSTouchTypeDirect)] phase:1];
    [recognizer processTouches:@[touch(@"b", 40, 50, NSTouchTypeDirect)] phase:2];
    assert(drain(handle, events, &reset) == 2 && !reset);
    assert(events[0].id == a && events[0].phase == 1 && events[0].x < 0);
    assert(events[1].id == b && events[1].phase == 2);
    assert(recognizer.contacts.count == 1);
    [recognizer reset];
    assert(drain(handle, events, &reset) == 1 && events[0].id == a && events[0].phase == 3);
    [recognizer processTouches:@[touch(@"a", 10, 10, NSTouchTypeDirect)] phase:0];
    assert(drain(handle, events, &reset) == 1 && events[0].id != a);
    [[NSNotificationCenter defaultCenter] postNotificationName:NSWindowDidResignKeyNotification object:window];
    assert(drain(handle, events, &reset) == 1 && events[0].phase == 3);
    [recognizer reset];
    [recognizer processTouches:@[touch(@"c", 10, 10, NSTouchTypeDirect)] phase:0];
    drain(handle, events, &reset);
    [[NSNotificationCenter defaultCenter] postNotificationName:NSWindowWillCloseNotification object:window];
    assert(drain(handle, events, &reset) == 1 && events[0].phase == 3);
    fm1_touch_detach(handle);
    assert(view.gestureRecognizers.count == before);
    assert(FM1Exclusivity(view) == exclusivity);
}

static void regionsAndOverflow(NSWindow *window) {
    void *handle = fm1_touch_attach((__bridge void *)window.contentView, false);
    FM1DirectTouchRecognizer *recognizer = (__bridge id)handle;
    fm1_touch_region(handle, 0.25f, 0.25f, 0.5f, 0.5f);
    NSTouch *inside = touch(@"inside", 50, 50, NSTouchTypeDirect);
    NSTouch *outside = touch(@"outside", 10, 10, NSTouchTypeDirect);
    assert(![recognizer gestureRecognizer:recognizer shouldReceiveTouch:outside]);
    assert([recognizer gestureRecognizer:recognizer shouldReceiveTouch:inside]);
    [window makeFirstResponder:window];
    [recognizer processTouches:@[outside] phase:0];
    assert(window.firstResponder != window.contentView);
    [recognizer processTouches:@[outside, inside] phase:0];
    assert(window.firstResponder == window.contentView);
    assert(recognizer.contacts.count == 1);
    [recognizer processTouches:@[touch(@"inside", 110, 110, NSTouchTypeDirect)] phase:1];
    FM1TouchEvent events[FM1TouchQueueCapacity];
    bool reset;
    assert(drain(handle, events, &reset) == 2);
    assert(events[1].x > 1.0 && events[1].y < 0.0);
    for (NSUInteger i = 0; i <= FM1TouchQueueCapacity; ++i)
        [recognizer processTouches:@[inside] phase:1];
    assert(drain(handle, events, &reset) == 0 && reset);
    assert(recognizer.contacts.count == 0);
    [recognizer processTouches:@[inside] phase:0];
    assert(drain(handle, events, &reset) == 0); // terminal until AppKit reset
    [recognizer reset];
    [recognizer processTouches:@[inside] phase:0];
    assert(drain(handle, events, &reset) == 1 && events[0].phase == 0);
    [recognizer recognitionChanged:[FM1CancelledTestGesture new]];
    assert(drain(handle, events, &reset) == 1 && events[0].phase == 3);
    fm1_touch_detach(handle);
}

static void childSelection(NSWindow *window) {
    NSView *parent = window.contentView;
    NSView *existing = [[NSView alloc] initWithFrame:parent.bounds];
    [parent addSubview:existing];
    void *snapshot = fm1_touch_children((__bridge void *)parent);
    assert(!fm1_touch_new_child(snapshot));
    NSView *renderer = [[NSView alloc] initWithFrame:parent.bounds];
    [parent addSubview:renderer];
    void *handle = fm1_touch_new_child(snapshot);
    assert(handle && renderer.gestureRecognizers.count == 1 && existing.gestureRecognizers.count == 0);
    fm1_touch_detach(handle);
    [parent addSubview:[[NSView alloc] initWithFrame:parent.bounds]];
    assert(!fm1_touch_new_child(snapshot)); // ambiguous: fail closed
    fm1_touch_children_free(snapshot);
    for (NSView *child in parent.subviews.copy) [child removeFromSuperview];
}

int main(void) {
    @autoreleasepool {
        if (@available(macOS 27.0, *)) {
            [NSApplication sharedApplication];
            NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 100, 100)
                styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
            window.contentView = [[FM1TestRenderingView alloc] initWithFrame:NSMakeRect(0, 0, 100, 100)];
            identityAndLifecycle(window);
            regionsAndOverflow(window);
            childSelection(window);
            puts("PASS: native identity, independent capture, coordinates, regions, reset, focus, close, overflow, attach/detach, child selection");
        } else {
            puts("SKIP: runtime requires macOS 27");
        }
    }
    return 0;
}
