// Native Keychain access. Biometric protection is enforced by securityd on the
// stored item itself, never by a separate success flag in application memory.
#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>
#import <Security/SecTask.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static BOOL hasDataProtectionIdentity(void) {
    SecTaskRef task = SecTaskCreateFromSelf(kCFAllocatorDefault);
    if (!task) return NO;
    CFTypeRef appID = SecTaskCopyValueForEntitlement(task, CFSTR("com.apple.application-identifier"), NULL);
    CFTypeRef groups = SecTaskCopyValueForEntitlement(task, CFSTR("keychain-access-groups"), NULL);
    BOOL valid = (appID && CFGetTypeID(appID) == CFStringGetTypeID() && CFStringGetLength(appID) > 0)
        || (groups && CFGetTypeID(groups) == CFArrayGetTypeID() && CFArrayGetCount(groups) > 0);
    if (appID) CFRelease(appID);
    if (groups) CFRelease(groups);
    CFRelease(task);
    return valid;
}

// Bits: preview is available, enrolled biometry is available, signing identity
// can use Data Protection Keychain. Checking these never opens a prompt/item.
int32_t steamguard_mac_access_capabilities(void) {
    @autoreleasepool {
        LAContext *context = [[LAContext alloc] init];
        BOOL available = [context canEvaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics error:nil];
        [context invalidate];
        return 1 | (available ? 2 : 0) | (hasDataProtectionIdentity() ? 4 : 0);
    }
}

static NSMutableDictionary *baseQuery(const char *nameSpace, const char *slot) {
    if (!nameSpace || !slot) return nil;
    NSString *identifier = [NSString stringWithUTF8String:nameSpace];
    NSString *account = [NSString stringWithUTF8String:slot];
    if (!identifier || identifier.length == 0 || identifier.length > 200
        || !([account isEqualToString:@"preview"] || [account isEqualToString:@"biometric"])) return nil;
    NSMutableDictionary *query = [@{
        (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService: [identifier stringByAppendingString:@".quick-access.v1"],
        (__bridge id)kSecAttrAccount: account,
    } mutableCopy];
    if ([account isEqualToString:@"biometric"]) {
        query[(__bridge id)kSecUseDataProtectionKeychain] = @YES;
    }
    // Preview intentionally uses login Keychain, with the current application
    // ACL. Do not add accessibility/synchronizable attributes: those switch
    // classic macOS items into the provisioning-dependent Keychain backend.
    return query;
}

int32_t steamguard_mac_access_write(const char *nameSpace, const char *slot,
                                   const uint8_t *bytes, size_t length) {
    @autoreleasepool {
        NSMutableDictionary *query = baseQuery(nameSpace, slot);
        if (!query || !bytes || length == 0 || length > 16384) return errSecParam;
        BOOL biometric = strcmp(slot, "biometric") == 0;
        if (biometric) {
            if (!hasDataProtectionIdentity()) return errSecMissingEntitlement;
            LAContext *context = [[LAContext alloc] init];
            BOOL available = [context canEvaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics error:nil];
            [context invalidate];
            if (!available) return errSecNotAvailable;
            SecAccessControlRef control = SecAccessControlCreateWithFlags(kCFAllocatorDefault,
                kSecAttrAccessibleWhenUnlockedThisDeviceOnly, kSecAccessControlBiometryCurrentSet, NULL);
            if (!control) return errSecNotAvailable;
            query[(__bridge id)kSecAttrAccessControl] = (__bridge id)control;
            CFRelease(control);
            query[(__bridge id)kSecAttrSynchronizable] = @NO;
        }
        // Rust removed the previous entry first. Refuse accidental replacement;
        // SecItemUpdate must never weaken an existing access-control object.
        NSData *value = [NSData dataWithBytesNoCopy:(void *)bytes length:length freeWhenDone:NO];
        query[(__bridge id)kSecValueData] = value;
        return SecItemAdd((__bridge CFDictionaryRef)query, NULL);
    }
}

int32_t steamguard_mac_access_read(const char *nameSpace, const char *slot,
                                  const char *reason, const char *fallback,
                                  uint8_t **output, size_t *length) {
    @autoreleasepool {
        if (!output || !length) return errSecParam;
        *output = NULL;
        *length = 0;
        NSMutableDictionary *query = baseQuery(nameSpace, slot);
        if (!query) return errSecParam;
        LAContext *context = [[LAContext alloc] init];
        context.touchIDAuthenticationAllowableReuseDuration = 0;
        context.localizedReason = reason ? [NSString stringWithUTF8String:reason] : @"Unlock SteamGuard";
        context.localizedFallbackTitle = fallback ? [NSString stringWithUTF8String:fallback] : @"";
        // A new context per read ensures one unlock cannot authorize subsequent
        // reads. No device-passcode OR constraint is attached to biometric items.
        query[(__bridge id)kSecUseAuthenticationContext] = context;
        query[(__bridge id)kSecReturnData] = @YES;
        query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
        CFTypeRef value = NULL;
        OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &value);
        [context invalidate];
        if (status != errSecSuccess || !value) {
            if (value) CFRelease(value);
            return status == errSecSuccess ? errSecDecode : status;
        }
        if (CFGetTypeID(value) != CFDataGetTypeID()) {
            CFRelease(value);
            return errSecDecode;
        }
        CFDataRef data = (CFDataRef)value;
        CFIndex count = CFDataGetLength(data);
        if (count <= 0 || count > 16384) {
            CFRelease(value);
            return errSecDecode;
        }
        uint8_t *copy = malloc((size_t)count);
        if (!copy) { CFRelease(value); return errSecAllocate; }
        memcpy(copy, CFDataGetBytePtr(data), (size_t)count);
        *output = copy;
        *length = (size_t)count;
        CFRelease(value);
        return errSecSuccess;
    }
}

int32_t steamguard_mac_access_remove(const char *nameSpace, const char *slot) {
    @autoreleasepool {
        NSMutableDictionary *query = baseQuery(nameSpace, slot);
        if (!query) return errSecParam;
        OSStatus status = SecItemDelete((__bridge CFDictionaryRef)query);
        return status == errSecItemNotFound ? errSecSuccess : status;
    }
}

void steamguard_mac_access_free(uint8_t *bytes, size_t length) {
    if (bytes) {
        // Volatile writes prevent dead-store elimination before free().
        volatile uint8_t *p = bytes;
        for (size_t i = 0; i < length; i++) p[i] = 0;
        free(bytes);
    }
}
