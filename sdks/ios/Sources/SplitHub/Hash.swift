import Foundation

/// MurmurHash3 (32-bit, x86) over the UTF-8 bytes of the input: the same numbers as
/// `murmur3` in `@splithub/core`, so a visitor gets the same variant in every SDK.
enum Hash {
    static func murmur3(_ input: String, seed: UInt32 = 0) -> UInt32 {
        let bytes = Array(input.utf8)
        let n = bytes.count
        let c1: UInt32 = 0xcc9e_2d51
        let c2: UInt32 = 0x1b87_3593
        var h = seed
        let blocks = n / 4

        for i in 0..<blocks {
            let o = i * 4
            let b0 = UInt32(bytes[o])
            let b1 = UInt32(bytes[o + 1]) << 8
            let b2 = UInt32(bytes[o + 2]) << 16
            let b3 = UInt32(bytes[o + 3]) << 24
            var k = b0 | b1 | b2 | b3
            k = k &* c1
            k = (k << 15) | (k >> 17)
            k = k &* c2
            h ^= k
            h = (h << 13) | (h >> 19)
            h = (h &* 5) &+ 0xe654_6b64
        }

        var k: UInt32 = 0
        let tail = blocks * 4
        switch n & 3 {
        case 3:
            k ^= UInt32(bytes[tail + 2]) << 16
            fallthrough
        case 2:
            k ^= UInt32(bytes[tail + 1]) << 8
            fallthrough
        case 1:
            k ^= UInt32(bytes[tail])
            k = k &* c1
            k = (k << 15) | (k >> 17)
            k = k &* c2
            h ^= k
        default:
            break
        }

        h ^= UInt32(truncatingIfNeeded: n)
        h ^= h >> 16
        h = h &* 0x85eb_ca6b
        h ^= h >> 13
        h = h &* 0xc2b2_ae35
        h ^= h >> 16
        return h
    }

    /// Hash to a number in [0, 1).
    static func unit(_ input: String, seed: UInt32 = 0) -> Double {
        return Double(murmur3(input, seed: seed)) / 4_294_967_296.0
    }
}

/// Short, URL-safe, time-prefixed ids, like `newId` in core: prefix + 9 base-36 time digits + 11 random.
enum IDs {
    private static let alphabet = Array("0123456789abcdefghijklmnopqrstuvwxyz")

    static func new(_ prefix: String) -> String {
        let ms = UInt64(max(0, Date().timeIntervalSince1970 * 1000))
        var time = String(ms, radix: 36)
        while time.count < 9 { time = "0" + time }
        var rand = ""
        for _ in 0..<11 {
            rand.append(alphabet[Int(UInt8.random(in: 0...255)) % 36])
        }
        return prefix + time + rand
    }
}

func nowMs() -> Double {
    return (Date().timeIntervalSince1970 * 1000).rounded(.down)
}
