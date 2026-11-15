// AppKit owns event gathering; this recognizer exposes independent direct contacts
// instead of reducing fingers to a mouse pointer or an aggregate pan gesture.
#import <AppKit/AppKit.h>
#import <objc/message.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

enum { FM1TouchQueueCapacity = 1024, FM1TouchContactLimit = 64 };
typedef struct {
    uint64_t id;
    uint32_t phase;
    float x;
    float y;
} FM1TouchEvent;

@interface FM1TouchContact : NSObject
@property uint64_t token;
@property NSPoint point;
@end
@implementation FM1TouchContact
@end

@interface FM1DirectTouchRecognizer : NSGestureRecognizer <NSGestureRecognizerDelegate> {
    FM1TouchEvent _events[FM1TouchQueueCapacity];
    NSUInteger _eventCount;
    BOOL _overflow;
    BOOL _awaitingReset;
    uint64_t _nextToken;
}
@property(strong) NSMutableDictionary *contacts;
@property(weak) NSWindow *observedWindow;
@property NSInteger previousExclusivity;
@property BOOL changedExclusivity;
@property NSRect inputRegion;
- (void)synchronizeWindow;
- (void)cancelContacts;
- (void)processTouches:(NSArray<NSTouch *> *)touches phase:(uint32_t)phase;
- (NSUInteger)drain:(FM1TouchEvent *)events capacity:(NSUInteger)capacity reset:(bool *)reset;
@end

// Call the macOS 27 property dynamically so older SDKs still compile this crate.
// The runtime check below is required even when built with a newer SDK.
static NSInteger FM1Exclusivity(NSView *view) {
    return ((NSInteger (*)(id, SEL))objc_msgSend)(view, NSSelectorFromString(@"exclusiveGestureBehavior"));
}
static void FM1SetExclusivity(NSView *view, NSInteger value) {
    ((void (*)(id, SEL, NSInteger))objc_msgSend)(view, NSSelectorFromString(@"setExclusiveGestureBehavior:"), value);
}

@implementation FM1DirectTouchRecognizer
- (instancetype)init {
    self = [super initWithTarget:nil action:nil];
    if (self) {
        _contacts = [NSMutableDictionary dictionary];
        _nextToken = 1;
        self.target = self;
        self.action = @selector(recognitionChanged:);
        self.delegate = self;
        self.inputRegion = NSMakeRect(0, 0, 1, 1);
        self.allowedTouchTypes = NSTouchTypeMaskDirect;
        // This touch-only recognizer does not delay real mouse or keyboard input.
        self.delaysPrimaryMouseButtonEvents = NO;
        [[NSNotificationCenter defaultCenter] addObserver:self
            selector:@selector(windowInterrupted:)
            name:NSApplicationDidResignActiveNotification object:nil];
    }
    return self;
}
- (void)dealloc {
    [[NSNotificationCenter defaultCenter] removeObserver:self];
}
- (void)synchronizeWindow {
    NSWindow *window = self.view.window;
    if (window == self.observedWindow) return;
    BOOL wasTracking = self.contacts.count != 0;
    [self cancelContacts];
    if (wasTracking) {
        _awaitingReset = YES;
        self.state = NSGestureRecognizerStateCancelled;
    }
    NSNotificationCenter *center = [NSNotificationCenter defaultCenter];
    if (self.observedWindow) {
        [center removeObserver:self name:NSWindowDidResignKeyNotification object:self.observedWindow];
        [center removeObserver:self name:NSWindowWillCloseNotification object:self.observedWindow];
    }
    self.observedWindow = window;
    if (window) {
        [center addObserver:self selector:@selector(windowInterrupted:)
            name:NSWindowDidResignKeyNotification object:window];
        [center addObserver:self selector:@selector(windowInterrupted:)
            name:NSWindowWillCloseNotification object:window];
    }
}
- (void)windowInterrupted:(NSNotification *)notification {
    (void)notification;
    BOOL wasTracking = self.contacts.count != 0;
    [self cancelContacts];
    if (wasTracking) {
        _awaitingReset = YES;
        self.state = NSGestureRecognizerStateCancelled;
    }
}
- (void)recognitionChanged:(NSGestureRecognizer *)recognizer {
    if (recognizer.state == NSGestureRecognizerStateCancelled ||
        recognizer.state == NSGestureRecognizerStateFailed) {
        _awaitingReset = YES;
        [self cancelContacts];
    }
}
- (NSPoint)normalizedPoint:(NSTouch *)touch {
    NSView *view = self.view;
    NSRect bounds = view.bounds;
    NSPoint point = [touch locationInView:view];
    point = NSMakePoint((point.x - bounds.origin.x) / bounds.size.width,
        (point.y - bounds.origin.y) / bounds.size.height);
    if (!view.isFlipped) point.y = 1.0 - point.y;
    return point;
}
- (BOOL)gestureRecognizer:(NSGestureRecognizer *)recognizer shouldReceiveTouch:(NSTouch *)touch {
    (void)recognizer;
    NSView *view = self.view;
    return touch.type == NSTouchTypeDirect && view.bounds.size.width > 0 &&
        view.bounds.size.height > 0 && NSPointInRect([self normalizedPoint:touch], self.inputRegion);
}
- (BOOL)gestureRecognizer:(NSGestureRecognizer *)recognizer shouldAttemptToRecognizeWithEvent:(NSEvent *)event {
    // AppKit calls this candidate filter only for mouse streams, not touches.
    // Opt out before gathering, including while other fingers remain active.
    (void)recognizer;
    (void)event;
    return NO;
}
- (BOOL)enqueue:(FM1TouchContact *)contact phase:(uint32_t)phase {
    if (_eventCount == FM1TouchQueueCapacity) {
        // An explicit reset flag lets Rust cancel *reported* contacts, including
        // ones whose undrained End would otherwise have been discarded here.
        _eventCount = 0;
        _overflow = YES;
        _awaitingReset = YES;
        [self.contacts removeAllObjects];
        self.state = NSGestureRecognizerStateCancelled;
        return NO;
    }
    _events[_eventCount++] = (FM1TouchEvent){ contact.token, phase,
        (float)contact.point.x, (float)contact.point.y };
    return YES;
}
- (void)cancelContacts {
    for (FM1TouchContact *contact in self.contacts.allValues) {
        if (![self enqueue:contact phase:3]) break;
    }
    [self.contacts removeAllObjects];
}
- (void)processTouches:(NSArray<NSTouch *> *)touches phase:(uint32_t)phase {
    if (_awaitingReset) return;
    BOOL wasTracking = self.contacts.count != 0;
    NSView *view = self.view;
    if (!view || view.bounds.size.width <= 0 || view.bounds.size.height <= 0) {
        [self cancelContacts];
        _awaitingReset = YES;
        self.state = NSGestureRecognizerStateCancelled;
        return;
    }
    for (NSTouch *touch in touches) {
        if (touch.type != NSTouchTypeDirect) continue;
        // NSDictionary copies and compares identity keys semantically. NSTouch
        // snapshots themselves, and their pointer addresses, are not identities.
        id<NSObject, NSCopying> identity = touch.identity;
        FM1TouchContact *contact = self.contacts[identity];
        if (phase == 0) {
            if (contact) continue;
            if (![self gestureRecognizer:self shouldReceiveTouch:touch]) continue;
            // A direct touch bypasses the renderer's usual mouseDown focus path.
            // Focus only accepted panel contacts, never rejected toolbar input.
            if (view.acceptsFirstResponder && view.window.firstResponder != view)
                [view.window makeFirstResponder:view];
            if (self.contacts.count == FM1TouchContactLimit) {
                [self cancelContacts];
                _awaitingReset = YES;
                self.state = NSGestureRecognizerStateCancelled;
                return;
            }
            contact = [FM1TouchContact new];
            contact.token = _nextToken++;
            if (_nextToken == 0) _nextToken = 1;
            self.contacts[identity] = contact;
        } else if (!contact) {
            continue;
        }
        contact.point = [self normalizedPoint:touch];
        if (![self enqueue:contact phase:phase]) return;
        if (phase == 2 || phase == 3) [self.contacts removeObjectForKey:identity];
    }
    if (self.contacts.count) {
        self.state = wasTracking ? NSGestureRecognizerStateChanged : NSGestureRecognizerStateBegan;
    } else if (wasTracking) {
        _awaitingReset = YES;
        self.state = phase == 3 ? NSGestureRecognizerStateCancelled : NSGestureRecognizerStateEnded;
    }
}
- (void)touchesBeganWithEvent:(NSEvent *)event {
    [self processTouches:[event touchesMatchingPhase:NSTouchPhaseBegan inView:self.view].allObjects phase:0];
}
- (void)touchesMovedWithEvent:(NSEvent *)event {
    [self processTouches:[event touchesMatchingPhase:NSTouchPhaseMoved inView:self.view].allObjects phase:1];
}
- (void)touchesEndedWithEvent:(NSEvent *)event {
    [self processTouches:[event touchesMatchingPhase:NSTouchPhaseEnded inView:self.view].allObjects phase:2];
}
- (void)touchesCancelledWithEvent:(NSEvent *)event {
    [self processTouches:[event touchesMatchingPhase:NSTouchPhaseCancelled inView:self.view].allObjects phase:3];
}
// Fail mouse streams immediately; existing frontend mouse handling stays live.
- (void)mouseDown:(NSEvent *)event { (void)event; if (!self.contacts.count) self.state = NSGestureRecognizerStateFailed; }
- (void)mouseDragged:(NSEvent *)event { (void)event; }
- (void)mouseUp:(NSEvent *)event { (void)event; if (!self.contacts.count) self.state = NSGestureRecognizerStateFailed; }
- (void)mouseCancelled:(NSEvent *)event { (void)event; if (!self.contacts.count) self.state = NSGestureRecognizerStateFailed; }
- (void)reset {
    [self cancelContacts];
    [super reset];
    _awaitingReset = NO;
}
- (NSPoint)locationInView:(NSView *)view {
    FM1TouchContact *contact = self.contacts.allValues.firstObject;
    NSView *source = self.view;
    if (!contact || !source) return NSZeroPoint;
    NSRect bounds = source.bounds;
    NSPoint point = contact.point;
    if (!source.isFlipped) point.y = 1.0 - point.y;
    point = NSMakePoint(bounds.origin.x + point.x * bounds.size.width,
        bounds.origin.y + point.y * bounds.size.height);
    return [source convertPoint:point toView:view];
}
- (NSUInteger)drain:(FM1TouchEvent *)events capacity:(NSUInteger)capacity reset:(bool *)reset {
    [self synchronizeWindow];
    *reset = _overflow;
    _overflow = NO;
    NSUInteger count = MIN(capacity, _eventCount);
    memcpy(events, _events, count * sizeof(FM1TouchEvent));
    _eventCount -= count;
    memmove(_events, _events + count, _eventCount * sizeof(FM1TouchEvent));
    return count;
}
@end

void *fm1_touch_attach(void *pointer, bool isWindow) {
    if (![NSThread isMainThread] || !pointer) return NULL;
    if (@available(macOS 27.0, *)) {
        id object = (__bridge id)pointer;
        NSView *view;
        if (isWindow) {
            if (![object isKindOfClass:NSWindow.class]) return NULL;
            view = [(NSWindow *)object contentView];
        } else {
            if (![object isKindOfClass:NSView.class]) return NULL;
            view = object;
        }
        if (!view) return NULL;
        FM1DirectTouchRecognizer *recognizer = [FM1DirectTouchRecognizer new];
        if ([view respondsToSelector:NSSelectorFromString(@"setExclusiveGestureBehavior:")]) {
            recognizer.previousExclusivity = FM1Exclusivity(view);
            recognizer.changedExclusivity = YES;
            // NSViewExclusiveGestureBehaviorNotExclusive (macOS 27) = 2.
            FM1SetExclusivity(view, 2);
        }
        [view addGestureRecognizer:recognizer];
        [recognizer synchronizeWindow];
        return (__bridge_retained void *)recognizer;
    }
    return NULL;
}

size_t fm1_touch_drain(void *handle, FM1TouchEvent *events, size_t capacity, bool *reset) {
    *reset = false;
    if (![NSThread isMainThread] || !handle) return 0;
    return [(__bridge FM1DirectTouchRecognizer *)handle drain:events capacity:capacity reset:reset];
}

void fm1_touch_detach(void *handle) {
    if (!handle) return;
    // Safety contracts require the main thread. Avoid touching AppKit from a
    // mistaken host teardown thread, while still releasing on the main queue.
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{ fm1_touch_detach(handle); });
        return;
    }
    FM1DirectTouchRecognizer *recognizer = (__bridge_transfer FM1DirectTouchRecognizer *)handle;
    [recognizer cancelContacts];
    NSView *view = recognizer.view;
    if (recognizer.changedExclusivity && view && FM1Exclusivity(view) == 2)
        FM1SetExclusivity(view, recognizer.previousExclusivity);
    [view removeGestureRecognizer:recognizer];
}

void fm1_touch_region(void *handle, float left, float top, float width, float height) {
    if (![NSThread isMainThread] || !handle) return;
    [(__bridge FM1DirectTouchRecognizer *)handle setInputRegion:NSMakeRect(left, top, width, height)];
}

@interface FM1TouchChildSnapshot : NSObject
@property(strong) NSView *parent;
@property(strong) NSArray<NSView *> *children;
@end
@implementation FM1TouchChildSnapshot
@end

void *fm1_touch_children(void *parent) {
    if (![NSThread isMainThread] || !parent) return NULL;
    id object = (__bridge id)parent;
    if (![object isKindOfClass:NSView.class]) return NULL;
    FM1TouchChildSnapshot *snapshot = [FM1TouchChildSnapshot new];
    snapshot.parent = object;
    snapshot.children = [snapshot.parent.subviews copy];
    return (__bridge_retained void *)snapshot;
}

void *fm1_touch_new_child(void *pointer) {
    if (![NSThread isMainThread] || !pointer) return NULL;
    FM1TouchChildSnapshot *snapshot = (__bridge FM1TouchChildSnapshot *)pointer;
    NSView *added = nil;
    for (NSView *child in snapshot.parent.subviews) {
        if ([snapshot.children indexOfObjectIdenticalTo:child] != NSNotFound) continue;
        if (added) return NULL;
        added = child;
    }
    return added ? fm1_touch_attach((__bridge void *)added, false) : NULL;
}

void fm1_touch_children_free(void *pointer) {
    if (!pointer) return;
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{ fm1_touch_children_free(pointer); });
        return;
    }
    id snapshot = (__bridge_transfer id)pointer;
    (void)snapshot;
}
