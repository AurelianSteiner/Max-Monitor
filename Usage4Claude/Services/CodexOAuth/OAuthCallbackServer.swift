//
//  OAuthCallbackServer.swift
//  Usage4Claude
//
//  Created by f-is-h on 2026-06-18.
//  Copyright © 2026 f-is-h. All rights reserved.
//

import Foundation
import Network
import OSLog

/// 本地 OAuth 回调服务器（基于 Network.framework，无第三方依赖）
///
/// 监听本机指定端口，捕获系统浏览器重定向回来的
/// `/auth/callback?code=...&state=...`（Codex）或 `/callback?...`（Claude），
/// 向浏览器返回一个成功页面，并把 query 参数通过 onCallback 投递给上层。
///
/// 只服务回环：监听套接字本身是双栈的（原因见 startListener），
/// 因此来源限制放在 accept 时做 —— 非回环对端一律立刻断开。
final class OAuthCallbackServer {

    /// 允许的回调路径：两条流程各自向授权端注册的 redirect_uri 路径。
    /// 别的路径不是回调，也不许消耗那一次性投递（见 handle）。
    private static let allowedCallbackPaths: Set<String> = [
        CodexOAuthConfig.callbackPath,
        ClaudeOAuthConfig.callbackPath
    ]

    private var listener: NWListener?
    private let queue = DispatchQueue(label: "xyz.fi5h.Usage4Claude.oauth.callback")
    private(set) var port: UInt16 = 0
    private var onCallback: (([String: String]) -> Void)?
    private var didDeliver = false

    /// 依次尝试端口列表，绑定第一个可用端口
    /// - Returns: 成功绑定的端口；全部失败返回 nil
    func start(ports: [UInt16], onCallback: @escaping ([String: String]) -> Void) -> UInt16? {
        self.onCallback = onCallback
        // 重置一次性投递标志：coordinator 复用同一个 server 实例做重试登录，
        // 若不重置，第一次失败后的重试即使浏览器端真实拿到 code，回调也会被静默丢弃。
        self.didDeliver = false
        for p in ports where startListener(on: p) {
            self.port = p
            return p
        }
        return nil
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    private func startListener(on port: UInt16) -> Bool {
        guard let nwPort = NWEndpoint.Port(rawValue: port) else { return false }
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        // 不设 requiredLocalEndpoint：它只能指定 127.0.0.1 或 ::1 其中之一，
        // 而浏览器可能把 localhost 解析成另一个，那样连接就是空白页。
        // 代价是套接字实际绑在 0.0.0.0/::（局域网也能连上），所以来源限制
        // 改在 accept 时逐连接判断，见 handle。

        let listener: NWListener
        do {
            listener = try NWListener(using: params, on: nwPort)
        } catch {
            Logger.settings.error("OAuthCallbackServer: 端口 \(port) 创建监听失败 - \(error.localizedDescription, privacy: .public)")
            return false
        }

        let sema = DispatchSemaphore(value: 0)
        var ready = false
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                ready = true
                sema.signal()
            case .waiting(let error):
                // 端口被占用时 NWListener 进入 waiting（持续重试），不会 failed。
                // 立即 signal 以便快速切换到下一个端口，并记录真实原因。
                Logger.settings.error("OAuthCallbackServer: 端口 \(port) 不可用（\(error.localizedDescription, privacy: .public)），尝试下一个")
                sema.signal()
            case .failed(let error):
                Logger.settings.error("OAuthCallbackServer: 端口 \(port) 监听失败 - \(error.localizedDescription, privacy: .public)")
                sema.signal()
            case .cancelled:
                sema.signal()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] conn in
            self?.handle(conn)
        }
        listener.start(queue: queue)

        // 等待最多 2 秒确认绑定结果
        _ = sema.wait(timeout: .now() + 2)
        if ready {
            self.listener = listener
            Logger.settings.info("OAuthCallbackServer: 监听 localhost:\(port)")
            return true
        }
        listener.cancel()
        Logger.settings.error("OAuthCallbackServer: 端口 \(port) 未能在超时内就绪")
        return false
    }

    private func handle(_ connection: NWConnection) {
        // 套接字是双栈的，局域网也能连上；回调只可能来自本机浏览器，
        // 所以非回环对端在这里直接掐断，一个字节都不读。
        guard Self.isLoopbackPeer(connection.endpoint) else {
            Logger.settings.error("OAuthCallbackServer: 拒绝非回环连接")
            connection.cancel()
            return
        }

        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, _, _ in
            guard let self = self,
                  let data = data,
                  let request = String(data: data, encoding: .utf8) else {
                connection.cancel()
                return
            }

            let (path, query) = Self.parseRequest(request)
            // 真正的回调要同时满足两点：落在已注册的 redirect_uri 路径上，且带
            // code 或 error。其余请求（favicon、浏览器预取、端口探测）一律 404 ——
            // 关键在于它们不会消耗那一次性投递，服务器继续等真正的回调，
            // 否则一个杂请求就能把一次真实登录顶掉。
            let isOAuthCallback = Self.allowedCallbackPaths.contains(path)
                && (query["code"] != nil || query["error"] != nil)

            let response: String
            if isOAuthCallback {
                let body = Self.responseHTML(success: query["code"] != nil)
                response = """
                HTTP/1.1 200 OK\r
                Content-Type: text/html; charset=utf-8\r
                Content-Length: \(body.utf8.count)\r
                Connection: close\r
                \r
                \(body)
                """
            } else {
                let body = Self.notFoundHTML()
                response = """
                HTTP/1.1 404 Not Found\r
                Content-Type: text/html; charset=utf-8\r
                Content-Length: \(body.utf8.count)\r
                Connection: close\r
                \r
                \(body)
                """
            }
            connection.send(content: response.data(using: .utf8), completion: .contentProcessed { _ in
                connection.cancel()
            })

            // 仅投递第一次有效回调（路径 + code/error 都对上）；
            // state 的校验在 coordinator 里，不在这一层。
            if !self.didDeliver, isOAuthCallback {
                self.didDeliver = true
                DispatchQueue.main.async { self.onCallback?(query) }
            }
        }
    }

    /// 从 HTTP 请求行解析路径与 query 参数
    /// 例：`GET /auth/callback?code=...&state=... HTTP/1.1`
    /// 解析不出来时返回空路径，落不进 allowedCallbackPaths，自然被当作 404。
    private static func parseRequest(_ request: String) -> (path: String, query: [String: String]) {
        guard let firstLine = request.split(separator: "\r\n").first else { return ("", [:]) }
        let parts = firstLine.split(separator: " ")
        guard parts.count >= 2 else { return ("", [:]) }

        // fragment 不会被浏览器发过来，保险起见仍先切掉，免得混进路径里
        var target = parts[1]
        if let hashIndex = target.firstIndex(of: "#") {
            target = target[target.startIndex..<hashIndex]
        }
        guard let qIndex = target.firstIndex(of: "?") else { return (String(target), [:]) }

        let path = String(target[target.startIndex..<qIndex])
        var query: [String: String] = [:]
        for pair in target[target.index(after: qIndex)...].split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1)
            guard let k = kv.first else { continue }
            let key = String(k).removingPercentEncoding ?? String(k)
            let rawValue = kv.count > 1 ? String(kv[1]) : ""
            query[key] = rawValue.removingPercentEncoding ?? rawValue
        }
        return (path, query)
    }

    // MARK: - 来源限制

    /// 对端是否来自回环。判不出来就算非回环（拒绝），不做善意猜测。
    private static func isLoopbackPeer(_ endpoint: NWEndpoint) -> Bool {
        guard case let .hostPort(host, _) = endpoint else { return false }
        switch host {
        case .ipv4(let address):
            return isIPv4Loopback(Array(address.rawValue))
        case .ipv6(let address):
            return isIPv6Loopback(Array(address.rawValue))
        default:
            return false
        }
    }

    /// 127.0.0.0/8 —— 整个 /8，不只是 127.0.0.1
    private static func isIPv4Loopback(_ bytes: [UInt8]) -> Bool {
        bytes.count == 4 && bytes[0] == 127
    }

    /// `::1`，外加 IPv4-mapped 形式 `::ffff:127.0.0.0/8` ——
    /// 双栈套接字上的 IPv4 对端正是以后者呈现的。
    private static func isIPv6Loopback(_ bytes: [UInt8]) -> Bool {
        guard bytes.count == 16 else { return false }
        if bytes.dropLast().allSatisfy({ $0 == 0 }), bytes[15] == 1 { return true }
        let isV4Mapped = bytes[0..<10].allSatisfy { $0 == 0 } && bytes[10] == 0xff && bytes[11] == 0xff
        return isV4Mapped && isIPv4Loopback(Array(bytes[12..<16]))
    }

    private static func responseHTML(success: Bool) -> String {
        let title = success ? "Signed in" : "Sign-in failed"
        let heading = success ? "✅ Signed in successfully" : "⚠️ Sign-in failed"
        let message = success
            ? "You can close this tab and return to Max Monitor."
            : "Something went wrong. Please return to Max Monitor and try again."
        return """
        <!DOCTYPE html><html><head><meta charset="utf-8"><title>\(title)</title></head>
        <body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;text-align:center;padding-top:80px;color:#1d1d1f;background:#f5f5f7">
        <h2>\(heading)</h2>
        <p>\(message)</p>
        </body></html>
        """
    }

    private static func notFoundHTML() -> String {
        """
        <!DOCTYPE html><html><head><meta charset="utf-8"><title>Not Found</title></head>
        <body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;text-align:center;padding-top:80px;color:#1d1d1f;background:#f5f5f7">
        <h2>404 Not Found</h2>
        </body></html>
        """
    }
}
