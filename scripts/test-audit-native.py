#!/usr/bin/env python3
"""Run production Swift methods with isolated OAuth, storage and power boundaries."""
from pathlib import Path
import subprocess
import tempfile
import re

ROOT = Path(__file__).resolve().parent.parent


def definition(file, marker):
    source = (ROOT / file).read_text()
    start = source.index(marker)
    opening = source.index("{", start)
    depth = 0
    # Skip comments and Swift strings while matching definition braces.
    tokens = re.finditer(r'//[^\n]*|/\*[\s\S]*?\*/|"(?:\\.|[^"\\])*"|[{}]', source[opening:])
    for token in tokens:
        if token.group() == "{":
            depth += 1
        elif token.group() == "}":
            depth -= 1
            if depth == 0:
                return source[start:opening + token.end()]
    raise AssertionError(marker)


def methods(file, names):
    return "\n".join(definition(file, name) for name in names)


claude = "Usage4Claude/Services/ClaudeAPIService.swift"
codex = "Usage4Claude/Services/CodexAPIService.swift"
store = "Usage4Claude/Models/AccountStore.swift"
sleep = "Usage4Claude/Helpers/SleepGuard.swift"
source = r'''
import Foundation
struct Account { var id: UUID; var sessionKey: String }
struct Log {
 func notice(_ s: String) {}; func error(_ s: String) {}; func warning(_ s: String) {}
}
enum Logger { static let api=Log(); static let settings=Log() }
enum UsageError: Error { case sessionExpired, unauthorized, networkError, decodingError }
enum FleetMonitoringManager { enum BindingError: Error { case saveFailed } }
struct ClaudeOAuthTokens { let accessToken:String; let refreshToken:String; let expiresAt:Date? }
struct CodexOAuthTokens { let accessToken:String; let refreshToken:String }
enum ClaudeOAuthService {
 static var pending: ((Result<ClaudeOAuthTokens,Error>)->Void)?
 static func refresh(refreshToken:String, completion:@escaping(Result<ClaudeOAuthTokens,Error>)->Void) { pending=completion }
}
enum CodexOAuthService {
 static var pending: ((Result<CodexOAuthTokens,Error>)->Void)?
 static var rejected=false; static var transient=false; static var calls=0
 static func refresh(refreshToken:String, completion:@escaping(Result<CodexOAuthTokens,Error>)->Void) {
  calls += 1
  if rejected { completion(.failure(UsageError.sessionExpired)) }
  else if transient { completion(.failure(UsageError.networkError)) }
  else { pending=completion }
 }
}
func jwtExpiry(from:String)->Date? { nil }
final class UserSettings {
 static let shared=UserSettings()
 var accounts:[Account]=[]; var codexAccounts:[Account]=[]
 var currentAccountId:UUID?; var currentCodexAccountId:UUID?
 var currentAccount:Account? { accounts.first { $0.id == currentAccountId } }
 var currentCodexAccount:Account? { codexAccounts.first { $0.id == currentCodexAccountId } }
''' + methods(store, ["func silentlyUpdateClaudeSessionToken(", "func silentlyUpdateCodexSessionToken("]) + r'''
}
final class ClaudeAPIService {
 let boundAccountId:UUID?=nil
 let credentialWriter:((String,String)->Bool)?=nil
 var settings:UserSettings { .shared }
''' + methods(claude, ["private var tokenCacheKey:", "private var oauthTokenCache:", "private func fetchOAuthAccessToken(", "private func refreshClaudeOAuthTokens("]) + r'''
 func run(_ token:String) async throws -> String {
  try await withCheckedThrowingContinuation { c in fetchOAuthAccessToken(refreshToken:token) { c.resume(with:$0) } }
 }
}
final class CodexAPIService {
 let boundAccountId:UUID?=nil
 let settings=UserSettings.shared
 static let tokenRefreshMargin:TimeInterval=1200
 static func isOAuthRefreshToken(_ token:String)->Bool { true }
 func fetchSessionTokens(sessionToken:String) async throws -> OAuthTokenCache.Tokens { throw UsageError.networkError }
''' + methods(codex, ["private var tokenCacheKey:", "private var tokenCache:", "private func fetchAccessToken(", "private func refreshOAuthTokens("]) + r'''
 func run(_ token:String) async throws -> String {
  try await withCheckedThrowingContinuation { c in fetchAccessToken(sessionToken:token) { c.resume(with:$0) } }
 }
}
final class FakeKeychain {
 let firstEntered=DispatchSemaphore(value:0), releaseFirst=DispatchSemaphore(value:0)
 let secondEntered=DispatchSemaphore(value:0), finished=DispatchGroup()
 var saved=""; var reject=false
 func saveAccounts(_ accounts:[Account])->Bool {
  let value=accounts[0].sessionKey
  if value=="old" { firstEntered.signal(); releaseFirst.wait() }
  if value=="new" { secondEntered.signal() }
  saved=value;finished.leave();return !reject
 }
 func saveCodexAccounts(_ accounts:[Account])->Bool { saveAccounts(accounts) }
}
final class AccountStore {
 let keychain=FakeKeychain()
 let persistenceQueue=DispatchQueue(label:"isolated.storage")
 var accounts:[Account]=[], codexAccounts:[Account]=[]
 var lastPersistenceSucceeded=true
''' + methods(store, ["private func saveAccounts(", "private func saveCodexAccounts("]) + r'''
 func enqueue(_ token:String, codex:Bool=false) {
  keychain.finished.enter()
  if codex { codexAccounts=[Account(id:UUID(),sessionKey:token)]; saveCodexAccounts() }
  else { accounts=[Account(id:UUID(),sessionKey:token)];saveAccounts() }
 }
}
enum DefaultsKey { static let awake="isolated" }
final class DummyDefaults { func set(_ value:Bool,forKey key:String) {} }
extension Notification.Name { static let settingsChanged=Notification.Name("isolated.settings") }
let kIOPMAssertionTypeNoDisplaySleep="display", kIOPMAssertionTypePreventUserIdleSystemSleep="idle"
final class SleepGuard {
 var isAwake=false, externallyEnabled=false
 var lastObservedSleepDisabled:Bool?
 var displayAssertionID:UInt32=0,systemAssertionID:UInt32=0
 let defaults=DummyDefaults();static let log=Log()
 func createAssertion(type:String,reason:String,id:inout UInt32)->Bool { id=1;return true }
 func releaseAssertion(_ id:inout UInt32,label:String) { id=0 }
 func applyLidTier(_ on:Bool,interactive:Bool) {}
''' + methods(sleep, ["private func observeSleepDisabled(", "private func adopt(", "private func syncAssertions(", "func setAwake("]) + r'''
 func tick(_ value:Bool) { observeSleepDisabled(value) }
}
enum Callback {
''' + definition("Usage4Claude/Views/WebLogin/ClaudeOAuthCoordinator.swift", "static func parseManualCallback(") + r'''
}
@main struct RegressionHarness {
 @MainActor static func main() async throws {
  let a=UUID(),b=UUID(),settings=UserSettings.shared
  settings.accounts=[Account(id:a,sessionKey:"a-old"),Account(id:b,sessionKey:"b-original")]
  settings.currentAccountId=a
  let claude=ClaudeAPIService(), operation=Task { try await claude.run("a-old") }
  while ClaudeOAuthService.pending==nil { try await Task.sleep(nanoseconds:1_000_000) }
  settings.currentAccountId=b
  ClaudeOAuthService.pending?(.success(ClaudeOAuthTokens(accessToken:"access",refreshToken:"a-rotated",expiresAt:nil)))
  _=try await operation.value
  precondition(settings.accounts[0].sessionKey=="a-rotated" && settings.accounts[1].sessionKey=="b-original")
  // A renewed login and a deleted account cannot be overwritten by delayed rotation.
  precondition(!settings.silentlyUpdateClaudeSessionToken(accountId:a,token:"late",replacing:"a-old"))
  precondition(!settings.silentlyUpdateClaudeSessionToken(accountId:UUID(),token:"late",replacing:"a-old"))
  settings.currentAccountId=a;ClaudeOAuthService.pending=nil
  await OAuthTokenCacheRegistry.claude.cache(for:a.uuidString).clear()
  let superseded=Task { try await claude.run("a-rotated") }
  while ClaudeOAuthService.pending==nil { try await Task.sleep(nanoseconds:1_000_000) }
  settings.accounts[0].sessionKey="new-login"
  ClaudeOAuthService.pending?(.success(ClaudeOAuthTokens(accessToken:"late-access",refreshToken:"late-rotation",expiresAt:nil)))
  do { _=try await superseded.value;preconditionFailure("superseded login succeeded") }
  catch { precondition(error is CancellationError) }
  precondition(settings.accounts[0].sessionKey=="new-login")
  settings.codexAccounts=[Account(id:a,sessionKey:"c-old"),Account(id:b,sessionKey:"d-original")]
  settings.currentCodexAccountId=a
  let codex=CodexAPIService(), operation2=Task { try await codex.run("c-old") }
  while CodexOAuthService.pending==nil { try await Task.sleep(nanoseconds:1_000_000) }
  settings.currentCodexAccountId=b
  CodexOAuthService.pending?(.success(CodexOAuthTokens(accessToken:"access",refreshToken:"c-rotated")))
  _=try await operation2.value
  precondition(settings.codexAccounts[0].sessionKey=="c-rotated" && settings.codexAccounts[1].sessionKey=="d-original")
  precondition(!settings.silentlyUpdateCodexSessionToken(accountId:a,token:"late",replacing:"c-old"))
  print("PASS: request-bound rotation preserves the other account and rejects stale writes")
  // The actual adapter and shared cache make only one call for a dead grant.
  settings.currentCodexAccountId=UUID()
  CodexOAuthService.rejected=true
  let before=CodexOAuthService.calls
  for _ in 0..<2 {
   do { _=try await codex.run("dead");preconditionFailure("dead token succeeded") }
   catch { guard case UsageError.sessionExpired=error else { throw error } }
  }
  precondition(CodexOAuthService.calls-before==1)
  settings.currentCodexAccountId=UUID()
  CodexOAuthService.rejected=false;CodexOAuthService.transient=true
  let beforeTransient=CodexOAuthService.calls
  for _ in 0..<2 {
   do { _=try await codex.run("temporary");preconditionFailure("network failure succeeded") }
   catch { guard case UsageError.networkError=error else { throw error } }
  }
  precondition(CodexOAuthService.calls-beforeTransient==2)
  print("PASS: permanent rejection reaches the cache and stops repeated endpoint calls")
  // Delay the first actual save method: the newer snapshot must stay queued.
  for isCodex in [false,true] {
   let store=AccountStore()
   store.enqueue("old",codex:isCodex)
   precondition(store.keychain.firstEntered.wait(timeout:.now()+3)==.success)
   store.enqueue("new",codex:isCodex)
   precondition(store.keychain.secondEntered.wait(timeout:.now()+0.05)==.timedOut)
   store.keychain.releaseFirst.signal()
   precondition(store.keychain.finished.wait(timeout:.now()+3)==.success)
   precondition(store.keychain.saved=="new")
   store.keychain.reject=true;store.enqueue("failed",codex:isCodex)
   precondition(store.keychain.finished.wait(timeout:.now()+3)==.success)
   try await Task.sleep(nanoseconds:10_000_000)
   precondition(!store.lastPersistenceSucceeded)
  }
  print("PASS: both account stores serialize snapshots and surface failed persistence")
  let guarder=SleepGuard();guarder.setAwake(true,interactive:false)
  guarder.tick(false);guarder.tick(false)
  precondition(guarder.isAwake && guarder.displayAssertionID != 0 && guarder.systemAssertionID != 0)
  guarder.tick(true);guarder.tick(false)
  precondition(!guarder.isAwake && guarder.displayAssertionID==0 && guarder.systemAssertionID==0)
  guarder.tick(true);precondition(guarder.isAwake && guarder.externallyEnabled)
  print("PASS: rejected optional lid tier preserves assertions; actual external transitions are followed")
  precondition(Callback.parseManualCallback("#").isEmpty)
  precondition(Callback.parseManualCallback("").isEmpty)
  precondition(Callback.parseManualCallback("code#state")==["code":"code","state":"state"])
  precondition(Callback.parseManualCallback("http://localhost/?code=a%20b&state=s")==["code":"a b","state":"s"])
  print("PASS: invalid callback cannot crash; valid manual and URL callbacks still parse")
 }
}
'''

with tempfile.TemporaryDirectory(prefix="monitor-native-regression-") as temporary:
    directory = Path(temporary)
    fixture = directory / "fixture.swift"
    fixture.write_text(source)
    # Swift requires whitespace around == before a leading enum member.
    fixture.write_text(fixture.read_text().replace(")==.", ") == ."))
    binary = directory / "fixture"
    subprocess.run(["swiftc", "-parse-as-library", "-swift-version", "5",
                    str(ROOT / "Usage4Claude/Services/OAuthTokenCache.swift"), str(fixture), "-o", str(binary)],
                   check=True, timeout=90)
    subprocess.run([str(binary)], check=True, timeout=30)
