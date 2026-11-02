#import <Foundation/Foundation.h>
#include <stdlib.h>
#include <string.h>

@interface SGCloudSession : NSObject
@property NSURL *container;
@property NSURL *root;
@property id identity;
@property NSMetadataQuery *query;
@property NSMutableArray *observers;
@property NSMutableArray<NSFileCoordinator *> *coordinators;
@property BOOL active;
@property BOOL gathered;
@property uint64_t revision;
@property NSString *confirmed;
@end
@implementation SGCloudSession
@end
static NSMutableDictionary<NSString *, SGCloudSession *> *sessions;
static void mainSync(dispatch_block_t block) {
    if ([NSThread isMainThread])
        block();
    else
        dispatch_sync(dispatch_get_main_queue(), block);
}
static NSDictionary *failure(NSString *status) { return @{@"status" : status}; }
static BOOL live(SGCloudSession *s) {
    @synchronized(s) {
        return s.active && s.identity &&
               [s.identity isEqual:NSFileManager.defaultManager.ubiquityIdentityToken];
    }
}
static NSDictionary *ok(void) { return @{@"status" : @"ok"}; }
static BOOL uuid(NSString *value) {
    NSUUID *u = [[NSUUID alloc] initWithUUIDString:value];
    return u && [[u.UUIDString lowercaseString] isEqualToString:value];
}
static BOOL validPath(NSString *path) {
    if (![path isKindOfClass:NSString.class] || path.length > 200 || [path hasPrefix:@"/"])
        return NO;
    NSString *p = [path hasSuffix:@"/"] ? [path substringToIndex:path.length - 1] : path;
    NSArray *a = [p componentsSeparatedByString:@"/"];
    if (![a.firstObject isEqualToString:@"steamguard-sync-v1"])
        return NO;
    if (a.count == 1)
        return YES;
    if (!uuid(a[1]))
        return NO;
    if (a.count == 2)
        return YES;
    if (a.count == 3)
        return [a[2] isEqualToString:@"states"] || [a[2] isEqualToString:@"header.json"];
    if (a.count == 4 && [a[2] isEqualToString:@"states"]) {
        NSString *f = a[3];
        return [f hasSuffix:@".sgsync"] && uuid([f substringToIndex:f.length - 7]);
    }
    return NO;
}
static NSURL *ownedRoot(NSURL *container) {
    NSURL *url = container;
    for (NSString *part in @[ @"", @"Documents", @"SteamGuard" ]) {
        if (part.length)
            url = [url URLByAppendingPathComponent:part];
        NSNumber *link = nil;
        [url getResourceValue:&link forKey:NSURLIsSymbolicLinkKey error:nil];
        if (link.boolValue)
            return nil;
    }
    return url;
}
static NSURL *fileURL(SGCloudSession *s, NSString *path) {
    if (!validPath(path) || !live(s))
        return nil;
    // Check the app root as well as descendants: neither Documents nor
    // SteamGuard may redirect coordinated access outside the approved container.
    NSURL *url = ownedRoot(s.container);
    if (!url)
        return nil;
    for (NSString *part in [path componentsSeparatedByString:@"/"]) {
        if (part.length == 0)
            continue;
        url = [url URLByAppendingPathComponent:part];
        NSNumber *link = nil;
        [url getResourceValue:&link forKey:NSURLIsSymbolicLinkKey error:nil];
        if (link.boolValue)
            return nil;
    }
    return url;
}
static BOOL ready(SGCloudSession *s) {
    NSDate *end = [NSDate dateWithTimeIntervalSinceNow:15];
    while ([end timeIntervalSinceNow] > 0) {
        @synchronized(s) {
            if (!s.active)
                return NO;
            if (s.gathered)
                return YES;
        }
        [NSThread sleepForTimeInterval:0.05];
    }
    return NO;
}
static BOOL downloaded(SGCloudSession *s, NSURL *url) {
    NSNumber *ubiquitous = nil;
    [url getResourceValue:&ubiquitous forKey:NSURLIsUbiquitousItemKey error:nil];
    if (!ubiquitous.boolValue && [NSFileManager.defaultManager fileExistsAtPath:url.path])
        return YES;
    [NSFileManager.defaultManager startDownloadingUbiquitousItemAtURL:url error:nil];
    NSDate *end = [NSDate dateWithTimeIntervalSinceNow:15];
    while ([end timeIntervalSinceNow] > 0 && live(s)) {
        [url removeCachedResourceValueForKey:NSURLUbiquitousItemDownloadingStatusKey];
        NSString *status = nil;
        [url getResourceValue:&status forKey:NSURLUbiquitousItemDownloadingStatusKey error:nil];
        if (([status isEqualToString:NSURLUbiquitousItemDownloadingStatusCurrent] ||
             [status isEqualToString:NSURLUbiquitousItemDownloadingStatusDownloaded]) &&
            [NSFileManager.defaultManager fileExistsAtPath:url.path])
            return YES;
        [NSThread sleepForTimeInterval:0.05];
    }
    return NO;
}
static BOOL uploaded(NSURL *url) {
    [url removeCachedResourceValueForKey:NSURLUbiquitousItemIsUploadedKey];
    NSNumber *value = nil;
    [url getResourceValue:&value forKey:NSURLUbiquitousItemIsUploadedKey error:nil];
    return value.boolValue;
}
// Read an untrusted cloud document with a hard allocation bound, including
// dataless files whose cached size was zero before download.
static NSData *boundedRead(SGCloudSession *s, NSURL *url) {
    NSFileHandle *handle = [NSFileHandle fileHandleForReadingFromURL:url error:nil];
    if (!handle)
        return nil;
    NSMutableData *result = [NSMutableData new];
    @try {
        while (live(s)) {
            NSError *error = nil;
            NSData *chunk = [handle
                readDataUpToLength:MIN((NSUInteger)65536, 32 * 1024 * 1024 + 1 - result.length)
                             error:&error];
            if (error || !chunk) {
                result = nil;
                break;
            }
            if (chunk.length == 0)
                break;
            [result appendData:chunk];
            if (result.length > 32 * 1024 * 1024) {
                result = nil;
                break;
            }
        }
    } @catch (NSException *exception) {
        (void)exception;
        result = nil;
    }
    [handle closeAndReturnError:nil];
    return live(s) ? result : nil;
}
// Metadata queries see cloud-only documents before the directory is materialized.
// Snapshot on the query's main thread and synthesize only our fixed directories.
static NSDictionary<NSString *, NSNumber *> *cloudPaths(SGCloudSession *s) {
    __block NSMutableDictionary *paths = [NSMutableDictionary new];
    mainSync(^{
      if (!s.active || !s.query) {
          paths = nil;
          return;
      }
      [s.query disableUpdates];
      NSUInteger count = s.query.resultCount;
      if (count > 8192) {
          paths = nil;
      } else {
          NSString *prefix = [s.root.path stringByAppendingString:@"/"];
          for (NSUInteger i = 0; i < count; i++) {
              NSMetadataItem *item = [s.query resultAtIndex:i];
              NSURL *url = [item valueForAttribute:NSMetadataItemURLKey];
              NSString *absolute = url.path;
              if (![absolute hasPrefix:prefix])
                  continue;
              NSString *path = [absolute substringFromIndex:prefix.length];
              if (!validPath(path))
                  continue;
              NSNumber *size = [item valueForAttribute:NSMetadataItemFSSizeKey];
              paths[path] = size ?: @0;
          }
      }
      [s.query enableUpdates];
    });
    return paths;
}
static NSDictionary *listing(SGCloudSession *s, NSString *path, NSArray<NSURL *> *local,
                             NSDictionary<NSString *, NSNumber *> *cloud) {
    NSString *prefix = [path hasSuffix:@"/"] ? path : [path stringByAppendingString:@"/"];
    NSMutableDictionary *entries = [NSMutableDictionary new];
    for (NSURL *child in local) {
        NSString *childPath = [prefix stringByAppendingString:child.lastPathComponent];
        NSNumber *directory = nil, *size = nil, *link = nil;
        [child getResourceValue:&directory forKey:NSURLIsDirectoryKey error:nil];
        [child getResourceValue:&size forKey:NSURLFileSizeKey error:nil];
        [child getResourceValue:&link forKey:NSURLIsSymbolicLinkKey error:nil];
        if (link.boolValue)
            return failure(@"bounds");
        if (!validPath(childPath))
            continue;
        entries[childPath] = @{
            @"path" : [childPath stringByAppendingString:directory.boolValue ? @"/" : @""],
            @"directory" : directory ?: @NO,
            @"size" : size ?: @0
        };
    }
    for (NSString *remote in cloud) {
        if (![remote hasPrefix:prefix])
            continue;
        NSString *remaining = [remote substringFromIndex:prefix.length];
        NSArray *parts = [remaining componentsSeparatedByString:@"/"];
        NSString *child = [prefix stringByAppendingString:parts.firstObject];
        if (entries[child] || !validPath(child))
            continue;
        BOOL directory = parts.count > 1 || [child isEqualToString:@"steamguard-sync-v1"] ||
                         uuid(parts.firstObject) || [parts.firstObject isEqualToString:@"states"];
        entries[child] = @{
            @"path" : [child stringByAppendingString:directory ? @"/" : @""],
            @"directory" : @(directory),
            @"size" : directory ? @0 : cloud[remote]
        };
    }
    if (entries.count > 512 || !live(s))
        return failure(live(s) ? @"bounds" : @"cancelled");
    return @{@"status" : @"ok", @"entries" : entries.allValues};
}
static BOOL pendingInLibrary(SGCloudSession *s, NSURL *file) {
    NSURL *library = [file.lastPathComponent isEqualToString:@"header.json"]
                         ? file.URLByDeletingLastPathComponent
                         : file.URLByDeletingLastPathComponent.URLByDeletingLastPathComponent;
    __block BOOL listingFailed = NO;
    NSDirectoryEnumerator *enumerator = [NSFileManager.defaultManager
                   enumeratorAtURL:library
        includingPropertiesForKeys:@[
            NSURLIsRegularFileKey, NSURLIsSymbolicLinkKey, NSURLUbiquitousItemIsUploadedKey
        ]
                           options:NSDirectoryEnumerationSkipsHiddenFiles
                      errorHandler:^BOOL(NSURL *url, NSError *error) {
                        (void)url;
                        (void)error;
                        listingFailed = YES;
                        return NO;
                      }];
    if (!enumerator)
        return [NSFileManager.defaultManager fileExistsAtPath:library.path];
    NSUInteger count = 0;
    for (NSURL *entry in enumerator) {
        if (++count > 512)
            return YES;
        NSNumber *link = nil, *regular = nil;
        [entry getResourceValue:&link forKey:NSURLIsSymbolicLinkKey error:nil];
        [entry getResourceValue:&regular forKey:NSURLIsRegularFileKey error:nil];
        if (link.boolValue)
            return YES;
        if (regular.boolValue &&
            ([entry.pathExtension isEqualToString:@"sgsync"] ||
             [entry.lastPathComponent isEqualToString:@"header.json"]) &&
            !uploaded(entry))
            return YES;
    }
    return listingFailed || !live(s);
}
static NSDictionary *openSession(NSString *container) {
    if (![container isKindOfClass:NSString.class] || ![container hasPrefix:@"iCloud."] ||
        container.length > 200)
        return failure(@"unavailable");
    id identity = NSFileManager.defaultManager.ubiquityIdentityToken;
    if (!identity)
        return failure(@"unavailable");
    NSURL *base = [NSFileManager.defaultManager URLForUbiquityContainerIdentifier:container];
    if (!base)
        return failure(@"unavailable");
    SGCloudSession *s = [SGCloudSession new];
    s.container = base;
    s.root =
        [[base URLByAppendingPathComponent:@"Documents"] URLByAppendingPathComponent:@"SteamGuard"];
    s.identity = identity;
    s.active = YES;
    s.revision = 1;
    s.observers = [NSMutableArray new];
    s.coordinators = [NSMutableArray new];
    NSString *identifier = NSUUID.UUID.UUIDString;
    mainSync(^{
      NSMetadataQuery *query = [NSMetadataQuery new];
      s.query = query;
      query.searchScopes = @[ NSMetadataQueryUbiquitousDocumentsScope ];
      query.predicate =
          [NSPredicate predicateWithFormat:@"%K BEGINSWITH %@", NSMetadataItemPathKey,
                                           [s.root.path stringByAppendingString:@"/"]];
      query.notificationBatchingInterval = 1;
      __weak SGCloudSession *weak = s;
      for (NSString *name in @[
               NSMetadataQueryDidFinishGatheringNotification, NSMetadataQueryDidUpdateNotification
           ]) {
          id observer = [NSNotificationCenter.defaultCenter
              addObserverForName:name
                          object:query
                           queue:NSOperationQueue.mainQueue
                      usingBlock:^(NSNotification *notification) {
                        (void)notification;
                        SGCloudSession *strong = weak;
                        if (!strong)
                            return;
                        @synchronized(strong) {
                            if (!strong.active)
                                return;
                            if ([name
                                    isEqualToString:NSMetadataQueryDidFinishGatheringNotification])
                                strong.gathered = YES;
                            strong.revision++;
                        }
                      }];
          [s.observers addObject:observer];
      }
      if (![query startQuery]) {
          s.active = NO;
      }
    });
    if (!s.active) {
        mainSync(^{
          [s.query stopQuery];
          for (id observer in s.observers)
              [NSNotificationCenter.defaultCenter removeObserver:observer];
        });
        return failure(@"unavailable");
    }
    @synchronized(sessions) {
        sessions[identifier] = s;
    }
    return @{@"status" : @"ok", @"session" : identifier, @"revision" : @(s.revision)};
}
static void closeSession(SGCloudSession *s) {
    @synchronized(s) {
        s.active = NO;
        for (NSFileCoordinator *c in s.coordinators)
            [c cancel];
    }
    mainSync(^{
      [s.query stopQuery];
      for (id observer in s.observers)
          [NSNotificationCenter.defaultCenter removeObserver:observer];
      [s.observers removeAllObjects];
      s.query = nil;
    });
}
static NSDictionary *operate(NSDictionary *request) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
      sessions = [NSMutableDictionary new];
    });
    NSString *op = request[@"op"], *identifier = request[@"session"];
    if ([op isEqualToString:@"open"])
        return openSession(request[@"container"]);
    SGCloudSession *s = nil;
    if ([identifier isKindOfClass:NSString.class]) {
        @synchronized(sessions) {
            s = sessions[identifier];
        }
    }
    if ([op isEqualToString:@"close"]) {
        if (s) {
            @synchronized(sessions) {
                [sessions removeObjectForKey:identifier];
            }
            closeSession(s);
        }
        return ok();
    }
    if ([op isEqualToString:@"availability"]) {
        if (s) {
            if (!live(s))
                return failure(@"account");
            @synchronized(s) {
                return @{@"status" : @"ok", @"revision" : @(s.revision)};
            }
        }
        NSString *container = request[@"container"];
        if (![container isKindOfClass:NSString.class] ||
            !NSFileManager.defaultManager.ubiquityIdentityToken)
            return failure(@"unavailable");
        NSURL *root = [NSFileManager.defaultManager URLForUbiquityContainerIdentifier:container];
        return root ? ok() : failure(@"unavailable");
    }
    if (!s || !live(s))
        return failure(@"cancelled");
    NSString *path = request[@"path"];
    NSURL *url = fileURL(s, path);
    if (!url)
        return failure(@"bounds");
    if (!ready(s))
        return failure(@"pending");
    NSDictionary *cloud = cloudPaths(s);
    if (!cloud)
        return failure(@"bounds");
    BOOL exists = [NSFileManager.defaultManager fileExistsAtPath:url.path];
    if ([op isEqualToString:@"list"] && !exists)
        return listing(s, path, @[], cloud);
    BOOL document = [path hasSuffix:@"/header.json"] || [path hasSuffix:@".sgsync"];
    if ([op isEqualToString:@"read"] || ([op isEqualToString:@"stat"] && document) ||
        ([op isEqualToString:@"write"] && exists)) {
        // Request dataless downloads before acquiring a coordinator read accessor.
        if (!exists && !cloud[path])
            return failure(@"notFound");
        if (!downloaded(s, url))
            return failure(live(s) ? @"pending" : @"cancelled");
    }
    exists = [NSFileManager.defaultManager fileExistsAtPath:url.path];
    if ([op isEqualToString:@"stat"] && !exists) {
        // Never expose a placeholder's cached length: callers use stat to build
        // a byte range. A zero/stale length would truncate the downloaded file.
        if (document)
            return failure(cloud[path] ? @"pending" : @"notFound");
        for (NSString *remote in cloud)
            if ([remote
                    hasPrefix:[path hasSuffix:@"/"] ? path : [path stringByAppendingString:@"/"]])
                return @{@"status" : @"ok", @"size" : @0, @"directory" : @YES};
        return failure(@"notFound");
    }
    NSFileCoordinator *coordinator = [[NSFileCoordinator alloc] initWithFilePresenter:nil];
    @synchronized(s) {
        [s.coordinators addObject:coordinator];
    }
    __block NSDictionary *result = nil;
    NSError *coordError = nil;
    NSDate *coordDeadline = [NSDate dateWithTimeIntervalSinceNow:20];
    __weak NSFileCoordinator *weakCoordinator = coordinator;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC),
                   dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
                     [weakCoordinator cancel];
                   });
    BOOL writing = [@[ @"mkdir", @"write", @"delete" ] containsObject:op];
    void (^access)(NSURL *) = ^(NSURL *actual) {
      NSFileManager *fm = NSFileManager.defaultManager;
      if (!live(s)) {
          result = failure(@"cancelled");
          return;
      }
      if ([coordDeadline timeIntervalSinceNow] <= 0) {
          result = failure(@"pending");
          return;
      }
      NSNumber *link = nil;
      [actual getResourceValue:&link forKey:NSURLIsSymbolicLinkKey error:nil];
      if (![actual.standardizedURL.path isEqualToString:url.standardizedURL.path] ||
          !fileURL(s, path) || link.boolValue) {
          result = failure(@"bounds");
          return;
      }
      if ([op isEqualToString:@"mkdir"]) {
          NSError *error = nil;
          BOOL success = [fm createDirectoryAtURL:actual
                      withIntermediateDirectories:YES
                                       attributes:nil
                                            error:&error];
          result = success ? ok() : failure(@"unavailable");
          return;
      }
      if ([op isEqualToString:@"write"]) {
          NSString *encoded = request[@"data"];
          NSData *data = [encoded isKindOfClass:NSString.class]
                             ? [[NSData alloc] initWithBase64EncodedString:encoded options:0]
                             : nil;
          if (!data || data.length == 0 || data.length > 32 * 1024 * 1024) {
              result = failure(@"bounds");
              return;
          }
          if ([fm fileExistsAtPath:actual.path]) {
              if ([NSFileVersion unresolvedConflictVersionsOfItemAtURL:actual].count) {
                  result = failure(@"conflict");
                  return;
              }
              NSData *previous = boundedRead(s, actual);
              if (![previous isEqualToData:data]) {
                  result = failure(@"conflict");
                  return;
              }
          } else {
              // Do not produce an unbounded series of queued checkpoints when offline.
              if (pendingInLibrary(s, actual)) {
                  result = failure(@"pending");
                  return;
              }
              NSError *error = nil;
              if (![data writeToURL:actual options:NSDataWritingAtomic error:&error]) {
                  result = failure(@"unavailable");
                  return;
              }
          }
          result = ok();
          return;
      }
      if ([op isEqualToString:@"delete"]) {
          NSString *keep = nil;
          @synchronized(s) {
              keep = s.confirmed;
          }
          NSURL *keepURL = keep ? fileURL(s, keep) : nil;
          if (!keepURL || [keep isEqualToString:path] || ![keep hasSuffix:@".sgsync"] ||
              ![keepURL.URLByDeletingLastPathComponent
                  isEqual:actual.URLByDeletingLastPathComponent] ||
              !uploaded(keepURL)) {
              result = failure(@"pending");
              return;
          }
          NSError *error = nil;
          BOOL exists = [fm fileExistsAtPath:actual.path];
          BOOL success = !exists || [fm removeItemAtURL:actual error:&error];
          result = success ? ok() : failure(@"unavailable");
          return;
      }
      BOOL directory = NO;
      BOOL exists = [fm fileExistsAtPath:actual.path isDirectory:&directory];
      if (!exists) {
          result = failure(@"notFound");
          return;
      }
      if ([op isEqualToString:@"list"]) {
          NSArray<NSURL *> *files =
              [fm contentsOfDirectoryAtURL:actual
                  includingPropertiesForKeys:@[
                      NSURLIsDirectoryKey, NSURLFileSizeKey, NSURLIsSymbolicLinkKey
                  ]
                                     options:NSDirectoryEnumerationSkipsHiddenFiles
                                       error:nil];
          if (!files || files.count > 512) {
              result = failure(@"bounds");
              return;
          }
          result = listing(s, path, files, cloud);
          return;
      }
      NSDictionary *attributes = [fm attributesOfItemAtPath:actual.path error:nil];
      if (!attributes) {
          result = failure(@"notFound");
          return;
      }
      uint64_t size = [attributes[NSFileSize] unsignedLongLongValue];
      if (size > 32 * 1024 * 1024) {
          result = failure(@"bounds");
          return;
      }
      if ([op isEqualToString:@"stat"]) {
          result = @{@"status" : @"ok", @"size" : @(size), @"directory" : @(directory)};
          return;
      }
      if ([op isEqualToString:@"read"]) {
          NSArray *versions = [NSFileVersion unresolvedConflictVersionsOfItemAtURL:actual];
          if (versions.count > 0) {
              result = failure(@"conflict");
              return;
          }
          if (directory) {
              result = failure(@"bounds");
              return;
          }
          NSData *data = boundedRead(s, actual);
          if (!data || data.length > 32 * 1024 * 1024) {
              result = failure(@"bounds");
              return;
          }
          result = @{@"status" : @"ok", @"data" : [data base64EncodedStringWithOptions:0]};
          return;
      }
      result = failure(@"bounds");
    };
    if (writing)
        [coordinator coordinateWritingItemAtURL:url
                                        options:[op isEqualToString:@"delete"]
                                                    ? NSFileCoordinatorWritingForDeleting
                                                    : 0
                                          error:&coordError
                                     byAccessor:access];
    else
        [coordinator coordinateReadingItemAtURL:url
                                        options:NSFileCoordinatorReadingWithoutChanges
                                          error:&coordError
                                     byAccessor:access];
    @synchronized(s) {
        [s.coordinators removeObject:coordinator];
    }
    if (!result || coordError)
        return failure(live(s) ? @"unavailable" : @"cancelled");
    if ([op isEqualToString:@"write"] && [result[@"status"] isEqualToString:@"ok"]) {
        // Local readback is insufficient for iCloud: compaction requires a
        // completed server upload, not merely a queued local document.
        NSDate *end = [NSDate dateWithTimeIntervalSinceNow:15];
        while ([end timeIntervalSinceNow] > 0 && live(s)) {
            if (uploaded(url)) {
                @synchronized(s) {
                    s.confirmed = path;
                    s.revision++;
                }
                return ok();
            }
            [NSThread sleepForTimeInterval:0.1];
        }
        return failure(live(s) ? @"pending" : @"cancelled");
    }
    return live(s) ? result : failure(@"cancelled");
}
char *steamguard_icloud_call(const uint8_t *bytes, size_t length) {
    @autoreleasepool {
        if (!bytes || length == 0 || length > 48 * 1024 * 1024)
            return strdup("{\"status\":\"bounds\"}");
        NSDictionary *request =
            [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytesNoCopy:(void *)bytes
                                                                         length:length
                                                                   freeWhenDone:NO]
                                            options:0
                                              error:nil];
        NSDictionary *response = nil;
        @try {
            response =
                [request isKindOfClass:NSDictionary.class] ? operate(request) : failure(@"bounds");
        } @catch (NSException *exception) {
            (void)exception;
            response = failure(@"unavailable");
        }
        NSData *result = [NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
        if (!result)
            return NULL;
        char *output = malloc(result.length + 1);
        if (!output)
            return NULL;
        memcpy(output, result.bytes, result.length);
        output[result.length] = 0;
        return output;
    }
}
void steamguard_icloud_free(char *value) { free(value); }

int steamguard_icloud_validate_path(const char *path) {
    @autoreleasepool {
        return path && validPath([NSString stringWithUTF8String:path]);
    }
}

int steamguard_icloud_root_valid(const char *path) {
    @autoreleasepool {
        return path && ownedRoot([NSURL fileURLWithPath:[NSString stringWithUTF8String:path]
                                            isDirectory:YES]) != nil;
    }
}
