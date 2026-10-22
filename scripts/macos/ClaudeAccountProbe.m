#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <Security/AuthSession.h>
#import <unistd.h>
#import <sys/stat.h>
#import <CommonCrypto/CommonDigest.h>

static NSDictionary *keychainState(SecKeychainRef keychain, OSStatus openStatus) {
    SecKeychainStatus flags = 0;
    OSStatus status = openStatus == errSecSuccess ? SecKeychainGetStatus(keychain, &flags) : openStatus;
    char path[4096] = {0}; UInt32 length = sizeof(path);
    if (keychain) SecKeychainGetPath(keychain, &length, path);
    return @{ @"status": @(status), @"flags": @(flags), @"unlocked": @((flags & kSecUnlockStateStatus) != 0),
        @"path": [NSString stringWithUTF8String:path] ?: @"" };
}

int main(int argc, char **argv) {
    @autoreleasepool {
        alarm(25);
        if (argc != 2) return 2;
        NSString *directory = [NSString stringWithUTF8String:argv[1]];
        NSDictionary *context = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[directory stringByAppendingPathComponent:@"context.json"]] options:0 error:nil];
        if (!context) return 3;
        SecKeychainSetUserInteractionAllowed(false);
        NSMutableDictionary *result = [@{ @"workerId": context[@"workerId"],
            @"checkedAt": [[NSISO8601DateFormatter new] stringFromDate:[NSDate date]],
            @"interactionAllowed": @NO, @"pid": @(getpid()), @"uid": @(getuid()) } mutableCopy];
        SecuritySessionId session = 0; SessionAttributeBits attributes = 0;
        OSStatus sessionStatus = SessionGetInfo(callerSecuritySession, &session, &attributes);
        result[@"session"] = @{ @"status": @(sessionStatus), @"id": @(session), @"attributes": @(attributes),
            @"graphicAccess": @((attributes & sessionHasGraphicAccess) != 0) };
        SecKeychainRef defaultKeychain = NULL;
        OSStatus openStatus = SecKeychainCopyDefault(&defaultKeychain);
        result[@"defaultKeychain"] = keychainState(defaultKeychain, openStatus);
        SecKeychainRef loginKeychain = NULL;
        NSString *loginPath = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Keychains/login.keychain-db"];
        OSStatus loginStatus = SecKeychainOpen(loginPath.UTF8String, &loginKeychain);
        result[@"loginKeychain"] = keychainState(loginKeychain, loginStatus);

        NSString *service = context[@"tokenService"], *account = context[@"username"];
        NSDictionary *query = @{ (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: service, (__bridge id)kSecAttrAccount: account,
            (__bridge id)kSecReturnRef: @YES, (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitOne,
            (__bridge id)kSecUseAuthenticationUI: (__bridge id)kSecUseAuthenticationUIFail };
        CFTypeRef item = NULL;
        OSStatus metadataStatus = SecItemCopyMatching((__bridge CFDictionaryRef)query, &item);
        result[@"workerItemMetadataStatus"] = @(metadataStatus);
        if (metadataStatus == errSecSuccess && item) {
            SecAccessRef access = NULL;
            if (SecKeychainItemCopyAccess((SecKeychainItemRef)item, &access) == errSecSuccess) {
                CFArrayRef list = NULL;
                if (SecAccessCopyACLList(access, &list) == errSecSuccess && list) {
                    NSMutableArray *entries = [NSMutableArray array];
                    for (id object in (__bridge NSArray *)list) {
                        CFArrayRef applications = NULL; CFStringRef description = NULL; SecKeychainPromptSelector selector = 0;
                        OSStatus status = SecACLCopyContents((__bridge SecACLRef)object, &applications, &description, &selector);
                        NSMutableArray *paths = [NSMutableArray array];
                        if (status == errSecSuccess && applications) for (id app in (__bridge NSArray *)applications) {
                            CFDataRef data = NULL;
                            if (SecTrustedApplicationCopyData((__bridge SecTrustedApplicationRef)app, &data) == errSecSuccess && data) {
                                NSString *path = [[NSString alloc] initWithData:(__bridge NSData *)data encoding:NSUTF8StringEncoding];
                                if (path) [paths addObject:[path stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"\0"]]];
                                CFRelease(data);
                            }
                        }
                        [entries addObject:@{ @"status": @(status), @"trustedApplications": paths,
                            @"allApplications": @(status == errSecSuccess && applications == NULL) }];
                        if (applications) CFRelease(applications); if (description) CFRelease(description);
                    }
                    result[@"itemACL"] = entries; CFRelease(list);
                }
                CFRelease(access);
            }
        }
        if (item) CFRelease(item);

        UInt32 count = 0; void *bytes = NULL;
        OSStatus readStatus = SecKeychainFindGenericPassword(NULL, (UInt32)[service lengthOfBytesUsingEncoding:NSUTF8StringEncoding], service.UTF8String,
            (UInt32)[account lengthOfBytesUsingEncoding:NSUTF8StringEncoding], account.UTF8String, &count, &bytes, NULL);
        result[@"diagnosticBinaryReadStatus"] = @(readStatus);
        NSData *credential = nil;
        if (readStatus == errSecSuccess && bytes) {
            credential = [NSData dataWithBytes:bytes length:count];
            SecKeychainItemFreeContent(NULL, bytes); bytes = NULL;
            result[@"credentialReadVia"] = @"diagnostic_binary";
        }
        BOOL securityTrusted = NO;
        for (NSDictionary *entry in result[@"itemACL"]) {
            if ([entry[@"trustedApplications"] containsObject:@"/usr/bin/security"]) securityTrusted = YES;
        }
        // Use only the existing trusted system reader, and only after the
        // login security session is confirmed unlocked. No ACL or lock changes.
        if (!credential && securityTrusted && [result[@"loginKeychain"][@"unlocked"] boolValue]
            && (attributes & sessionHasGraphicAccess)) {
            NSTask *task = [NSTask new]; task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/security"];
            task.arguments = @[@"find-generic-password", @"-s", service, @"-a", account, @"-w"];
            NSPipe *pipe = [NSPipe pipe]; task.standardOutput = pipe;
            task.standardError = [NSFileHandle fileHandleWithNullDevice];
            NSError *error = nil;
            if ([task launchAndReturnError:&error]) {
                NSData *data = [[pipe fileHandleForReading] readDataToEndOfFile];
                [task waitUntilExit];
                result[@"trustedReaderExit"] = @(task.terminationStatus);
                if (task.terminationStatus == 0) {
                    credential = data; readStatus = errSecSuccess;
                    result[@"credentialReadVia"] = @"existing_trusted_security_in_gui_session";
                }
            } else result[@"trustedReaderLaunchError"] = @(error.code);
        }
        result[@"workerCredentialReadStatus"] = @(readStatus);
        if (readStatus == errSecSuccess && credential.length) {
            NSString *token = [[[NSString alloc] initWithData:credential encoding:NSUTF8StringEncoding] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
            if (token.length) {
                unsigned char hash[CC_SHA256_DIGEST_LENGTH];
                CC_SHA256(token.UTF8String, (CC_LONG)[token lengthOfBytesUsingEncoding:NSUTF8StringEncoding], hash);
                NSMutableString *fingerprint = [NSMutableString string];
                for (int i = 0; i < 8; i++) [fingerprint appendFormat:@"%02x", hash[i]];
                id expected = context[@"expectedFingerprint"];
                result[@"credentialMatchesWorkerRecord"] = @((BOOL)([expected isKindOfClass:NSString.class] && [fingerprint isEqualToString:expected]));
                NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:@"https://api.anthropic.com/api/oauth/profile"] cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:12];
                [request setValue:[@"Bearer " stringByAppendingString:token] forHTTPHeaderField:@"Authorization"];
                [request setValue:@"oauth-2025-04-20" forHTTPHeaderField:@"anthropic-beta"];
                dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
                [[[NSURLSession sharedSession] dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
                    result[@"workerProfileStatus"] = @([(NSHTTPURLResponse *)response statusCode]);
                    if (!error && [(NSHTTPURLResponse *)response statusCode] == 200) {
                        NSDictionary *profile = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
                        result[@"authenticatedWorkerEmail"] = profile[@"account"][@"email"] ?: [NSNull null];
                        result[@"authenticatedWorkerAccountId"] = profile[@"account"][@"uuid"] ?: [NSNull null];
                    } else if (data.length) {
                        NSDictionary *body = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
                        id detail = body[@"error"];
                        NSString *message = [detail isKindOfClass:NSDictionary.class] ? detail[@"message"] : nil;
                        result[@"profileScopePermissionMissing"] = @((BOOL)([message isKindOfClass:NSString.class] && [message.lowercaseString containsString:@"scope"]));
                        if ([message isKindOfClass:NSString.class] && [message containsString:@"user:profile"])
                            result[@"profileRequiredScope"] = @"user:profile";
                    }
                    if (error) result[@"requestErrorCode"] = @(error.code);
                    dispatch_semaphore_signal(semaphore);
                }] resume];
                dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC));
            }
        }
        if (defaultKeychain) CFRelease(defaultKeychain); if (loginKeychain) CFRelease(loginKeychain);
        NSData *encoded = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingPrettyPrinted error:nil];
        NSString *output = [directory stringByAppendingPathComponent:@"result.json"];
        if (![encoded writeToFile:output options:NSDataWritingAtomic error:nil]) return 4;
        chmod(output.UTF8String, 0600);
    }
    return 0;
}
