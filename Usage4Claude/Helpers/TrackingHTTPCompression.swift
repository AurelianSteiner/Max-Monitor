import Foundation
import zlib

/// RFC 1952 bodies for the native tracking reports. zlib owns the framing and CRC.
enum TrackingHTTPCompression {
    static func gzip(_ data: Data) -> Data? {
        guard !data.isEmpty, data.count <= Int(UInt32.max) else { return nil }
        var stream = z_stream()
        guard deflateInit2_(&stream, Z_DEFAULT_COMPRESSION, Z_DEFLATED, 15 + 16, 8,
                            Z_DEFAULT_STRATEGY, ZLIB_VERSION,
                            Int32(MemoryLayout<z_stream>.size)) == Z_OK else { return nil }
        defer { deflateEnd(&stream) }
        let capacity = Int(deflateBound(&stream, uLong(data.count)))
        var output = Data(count: capacity)
        let result = data.withUnsafeBytes { source in
            output.withUnsafeMutableBytes { destination -> Int32 in
                stream.next_in = UnsafeMutablePointer(mutating: source.bindMemory(to: Bytef.self).baseAddress!)
                stream.avail_in = uInt(data.count)
                stream.next_out = destination.bindMemory(to: Bytef.self).baseAddress!
                stream.avail_out = uInt(capacity)
                return deflate(&stream, Z_FINISH)
            }
        }
        guard result == Z_STREAM_END else { return nil }
        output.count = Int(stream.total_out)
        return output
    }
}
