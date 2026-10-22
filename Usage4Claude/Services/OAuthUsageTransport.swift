import Foundation

/// A usage GET may be replayed once after a transport failure. Refresh-token
/// exchanges and model requests must never pass through this retry path.
enum OAuthUsageTransport {
    static func data(for request: URLRequest, using session: URLSession,
                     onRetry: @escaping (NSError) -> Void = { _ in },
                     completion: @escaping (Data?, URLResponse?, Error?) -> Void) {
        send(request, using: session, retriesLeft: 1, onRetry: onRetry, completion: completion)
    }

    private static func send(_ request: URLRequest, using session: URLSession, retriesLeft: Int,
                             onRetry: @escaping (NSError) -> Void,
                             completion: @escaping (Data?, URLResponse?, Error?) -> Void) {
        session.dataTask(with: request) { data, response, error in
            guard let error, retriesLeft > 0, (request.httpMethod ?? "GET") == "GET",
                  isTransient(error) else {
                completion(data, response, error)
                return
            }
            onRetry(error as NSError)
            // Flush starts the retry on a new TCP connection. It neither clears
            // account credentials nor cancels other requests in this session.
            session.flush {
                send(request, using: session, retriesLeft: retriesLeft - 1,
                     onRetry: onRetry, completion: completion)
            }
        }.resume()
    }

    private static func isTransient(_ error: Error) -> Bool {
        let error = error as NSError
        guard error.domain == NSURLErrorDomain else { return false }
        switch URLError.Code(rawValue: error.code) {
        case .secureConnectionFailed, .networkConnectionLost, .timedOut:
            return true
        default:
            // Certificate validation failures, cancellation, and HTTP errors
            // retain their normal failure behavior and are not retried.
            return false
        }
    }
}
