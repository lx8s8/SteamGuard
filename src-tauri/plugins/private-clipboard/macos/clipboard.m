#import <AppKit/AppKit.h>
#include <stdint.h>

int64_t steamguard_clipboard_write(const uint8_t *bytes, size_t length) {
    if (!bytes || !length || length > 32768) return -1;
    __block int64_t result = -1;
    void (^work)(void) = ^{
        @autoreleasepool {
            NSString *value = [[NSString alloc] initWithBytes:bytes length:length encoding:NSUTF8StringEncoding];
            if (!value) return;
            NSPasteboardItem *item = [[NSPasteboardItem alloc] init];
            [item setString:value forType:NSPasteboardTypeString];
            [item setString:@"" forType:@"org.nspasteboard.ConcealedType"];
            [item setString:@"" forType:@"org.nspasteboard.TransientType"];
            NSPasteboard *board = NSPasteboard.generalPasteboard;
            [board clearContents];
            if ([board writeObjects:@[item]]) result = (int64_t)board.changeCount;
        }
    };
    if (NSThread.isMainThread) work(); else dispatch_sync(dispatch_get_main_queue(), work);
    return result;
}
int32_t steamguard_clipboard_clear(int64_t owner) {
    __block int32_t result = 0;
    void (^work)(void) = ^{
        @autoreleasepool {
            NSPasteboard *board = NSPasteboard.generalPasteboard;
            if ((int64_t)board.changeCount == owner) { [board clearContents]; result = 1; }
        }
    };
    if (NSThread.isMainThread) work(); else dispatch_sync(dispatch_get_main_queue(), work);
    return result;
}
