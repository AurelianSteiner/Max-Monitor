// Read-only identity probe for the existing Claude Code Figma connection.
// Never prompts, changes Keychain permissions, refreshes tokens, or emits them.
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <Security/AuthSession.h>
#import <unistd.h>

static NSData *credential(void) {
    SecKeychainSetUserInteractionAllowed(false);
    NSDictionary *base = @{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService:@"Claude Code-credentials", (__bridge id)kSecAttrAccount:NSUserName(),
        (__bridge id)kSecMatchLimit:(__bridge id)kSecMatchLimitOne,
        (__bridge id)kSecUseAuthenticationUI:(__bridge id)kSecUseAuthenticationUIFail};
    NSMutableDictionary *query = [base mutableCopy]; query[(__bridge id)kSecReturnData] = @YES;
    CFTypeRef data = NULL;
    if (SecItemCopyMatching((__bridge CFDictionaryRef)query, &data) == errSecSuccess && data)
        return CFBridgingRelease(data);
    // Reuse the system reader only when it is already explicitly trusted,
    // the login Keychain is unlocked and this is a graphical login session.
    query = [base mutableCopy]; query[(__bridge id)kSecReturnRef] = @YES;
    CFTypeRef item = NULL; BOOL trusted = NO;
    if (SecItemCopyMatching((__bridge CFDictionaryRef)query, &item) == errSecSuccess && item) {
        SecAccessRef access = NULL;
        if (SecKeychainItemCopyAccess((SecKeychainItemRef)item, &access) == errSecSuccess) {
            CFArrayRef list = NULL;
            if (SecAccessCopyACLList(access, &list) == errSecSuccess && list) {
                for (id acl in (__bridge NSArray *)list) {
                    CFArrayRef apps = NULL; CFStringRef label = NULL; SecKeychainPromptSelector prompt = 0;
                    if (SecACLCopyContents((__bridge SecACLRef)acl, &apps, &label, &prompt) == errSecSuccess && apps) {
                        for (id app in (__bridge NSArray *)apps) {
                            CFDataRef bytes = NULL;
                            if (SecTrustedApplicationCopyData((__bridge SecTrustedApplicationRef)app, &bytes) == errSecSuccess && bytes) {
                                NSString *name = [[NSString alloc] initWithData:(__bridge NSData *)bytes encoding:NSUTF8StringEncoding];
                                if ([[name stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"\0"]] isEqualToString:@"/usr/bin/security"]) trusted = YES;
                                CFRelease(bytes);
                            }
                        }
                    }
                    if (apps) CFRelease(apps); if (label) CFRelease(label);
                }
                CFRelease(list);
            }
            CFRelease(access);
        }
        CFRelease(item);
    }
    SecuritySessionId session = 0; SessionAttributeBits attributes = 0;
    if (SessionGetInfo(callerSecuritySession, &session, &attributes) != errSecSuccess || !(attributes & sessionHasGraphicAccess)) return nil;
    SecKeychainRef keychain = NULL; SecKeychainStatus flags = 0;
    NSString *file = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Keychains/login.keychain-db"];
    BOOL unlocked = SecKeychainOpen(file.UTF8String, &keychain) == errSecSuccess
        && SecKeychainGetStatus(keychain, &flags) == errSecSuccess && (flags & kSecUnlockStateStatus);
    if (keychain) CFRelease(keychain);
    if (!trusted || !unlocked) return nil;
    NSTask *task = [NSTask new]; task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/security"];
    task.arguments = @[@"find-generic-password", @"-s", @"Claude Code-credentials", @"-a", NSUserName(), @"-w"];
    NSPipe *pipe = [NSPipe pipe]; task.standardOutput = pipe; task.standardError = [NSFileHandle fileHandleWithNullDevice];
    if (![task launchAndReturnError:nil]) return nil;
    NSData *value = [[pipe fileHandleForReading] readDataToEndOfFile]; [task waitUntilExit];
    return task.terminationStatus == 0 ? value : nil;
}

static NSDictionary *decode(NSData *data) {
    id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if ([value isKindOfClass:NSDictionary.class]) return value;
    NSString *body = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    for (NSString *line in [body componentsSeparatedByString:@"\n"]) {
        if (![line hasPrefix:@"data:"]) continue;
        NSData *part = [[line substringFromIndex:5] dataUsingEncoding:NSUTF8StringEncoding];
        value = [NSJSONSerialization JSONObjectWithData:part options:0 error:nil];
        if ([value isKindOfClass:NSDictionary.class] && value[@"result"]) return value;
    }
    return nil;
}

static NSDictionary *request(NSString *token, NSDictionary *body, NSMutableDictionary *headers) {
    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:@"https://mcp.figma.com/mcp"]
        cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:8];
    req.HTTPMethod = @"POST"; req.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
    [req setValue:[@"Bearer " stringByAppendingString:token] forHTTPHeaderField:@"Authorization"];
    [req setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    [req setValue:@"application/json, text/event-stream" forHTTPHeaderField:@"Accept"];
    for (NSString *key in headers) [req setValue:headers[key] forHTTPHeaderField:key];
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    __block NSDictionary *result = nil;
    [[[NSURLSession sharedSession] dataTaskWithRequest:req completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
        if (!error && http.statusCode >= 200 && http.statusCode < 300 && data.length <= 65536) {
            NSString *session = [http valueForHTTPHeaderField:@"Mcp-Session-Id"];
            if (session) headers[@"Mcp-Session-Id"] = session;
            result = decode(data);
        }
        dispatch_semaphore_signal(done);
    }] resume];
    dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 10*NSEC_PER_SEC));
    return result;
}

static NSString *emailOf(id value) {
    if ([value isKindOfClass:NSString.class]) return emailOf([NSJSONSerialization JSONObjectWithData:[value dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil]);
    if ([value isKindOfClass:NSArray.class]) { for (id child in value) { NSString *email = emailOf(child); if (email) return email; } return nil; }
    if (![value isKindOfClass:NSDictionary.class] || [value[@"isError"] boolValue]) return nil;
    id email = value[@"email"];
    if ([email isKindOfClass:NSString.class] && [email length] <= 254 && [email rangeOfString:@"@"].location != NSNotFound) return email;
    for (NSString *key in @[@"whoami", @"result", @"structuredContent", @"content", @"text"]) {
        NSString *found = emailOf(value[key]); if (found) return found;
    }
    return nil;
}

int main(void) {
    @autoreleasepool {
        alarm(25);
        NSData *data = credential();
        NSDictionary *store = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
        NSMutableArray *entries = [NSMutableArray new];
        for (id entry in [store[@"mcpOAuth"] allValues])
            if ([entry isKindOfClass:NSDictionary.class] && [entry[@"serverUrl"] isEqual:@"https://mcp.figma.com/mcp"] && [entry[@"serverName"] isEqual:@"figma"]
                && [entry[@"accessToken"] isKindOfClass:NSString.class]) [entries addObject:entry];
        if (entries.count != 1) { puts("{\"available\":false}"); return 0; }
        NSString *token = entries[0][@"accessToken"];
        NSMutableDictionary *headers = [NSMutableDictionary new];
        NSDictionary *init = request(token, @{@"jsonrpc":@"2.0", @"id":@1, @"method":@"initialize",
            @"params":@{@"protocolVersion":@"2025-03-26", @"capabilities":@{}, @"clientInfo":@{@"name":@"max-monitor", @"version":@"1"}}}, headers);
        NSString *version = init[@"result"][@"protocolVersion"];
        if (version) headers[@"MCP-Protocol-Version"] = version;
        if (init[@"result"]) request(token, @{@"jsonrpc":@"2.0", @"method":@"notifications/initialized"}, headers);
        NSString *email = emailOf(request(token, @{@"jsonrpc":@"2.0", @"id":@2, @"method":@"tools/call",
            @"params":@{@"name":@"whoami", @"arguments":@{}}}, headers));
        NSDictionary *result = email ? @{@"email":email, @"observedAt":[[NSISO8601DateFormatter new] stringFromDate:[NSDate date]], @"source":@"mcp-whoami"} : @{@"available":@NO};
        puts([[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:result options:0 error:nil] encoding:NSUTF8StringEncoding].UTF8String);
    }
    return 0;
}
