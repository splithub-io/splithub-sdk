import Foundation

/// A port of `targeting.ts` in `@splithub/core`: the dashboard's flow graph
/// (condition → split → variant | skip), walked deterministically per visitor.
enum Targeting {
    private static let maxSteps = 64
    private static let weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

    /// Hour and weekday in the context's time zone (UTC when none or unknown).
    static func localClock(_ ctx: TargetingContext) -> (hour: Int, weekday: Int) {
        let date = Date(timeIntervalSince1970: (ctx.now ?? nowMs()) / 1000)
        var cal = Calendar(identifier: .gregorian)
        let utc = TimeZone(identifier: "UTC") ?? TimeZone(secondsFromGMT: 0)!
        if let tz = ctx.timezone, !tz.isEmpty, let zone = TimeZone(identifier: tz) {
            cal.timeZone = zone
        } else {
            cal.timeZone = utc
        }
        let hour = cal.component(.hour, from: date)
        let weekday = cal.component(.weekday, from: date) - 1
        return (hour, weekday)
    }

    private static func decode(_ s: String) -> String {
        let spaced = s.replacingOccurrences(of: "+", with: " ")
        return spaced.removingPercentEncoding ?? spaced
    }

    static func queryParam(_ url: String?, _ name: String) -> String? {
        guard let url = url, let q = url.firstIndex(of: "?") else { return nil }
        let afterQ = String(url[url.index(after: q)...])
        let search = afterQ.components(separatedBy: "#")[0]
        for pair in search.components(separatedBy: "&") {
            if let eq = pair.firstIndex(of: "=") {
                if decode(String(pair[..<eq])) == name { return decode(String(pair[pair.index(after: eq)...])) }
            } else if decode(pair) == name {
                return ""
            }
        }
        return nil
    }

    /// The context's value of a field, lowercase, or nil when unknown.
    static func contextValue(_ field: String, _ key: String?, _ ctx: TargetingContext) -> String? {
        var v: String?
        switch field {
        case "country": v = ctx.country
        case "region": v = ctx.region
        case "city": v = ctx.city
        case "device": v = ctx.device
        case "browser": v = ctx.browser
        case "os": v = ctx.os
        case "referrer": v = ctx.referrer
        case "url": v = ctx.url
        case "visitor": v = ctx.visitor
        case "platform": v = ctx.platform
        case "app_version": v = ctx.appVersion
        case "language":
            if let l = ctx.language {
                let first = l.components(separatedBy: ",")[0].trimmingCharacters(in: .whitespacesAndNewlines)
                v = first.components(separatedBy: "-")[0]
            }
        case "path":
            if let u = ctx.url, !u.isEmpty {
                var noOrigin = u
                if let r = u.range(of: "^[a-z]+://[^/]+", options: [.regularExpression, .caseInsensitive]) {
                    noOrigin.removeSubrange(r)
                }
                let path = noOrigin.components(separatedBy: "?")[0].components(separatedBy: "#")[0]
                v = path.isEmpty ? "/" : path
            }
        case "query":
            if let k = key, !k.isEmpty { v = queryParam(ctx.url, k) }
        case "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content":
            v = queryParam(ctx.url, field)
        case "cookie":
            if let k = key, !k.isEmpty { v = ctx.cookies?[k] }
        case "hour":
            v = String(localClock(ctx).hour)
        case "weekday":
            v = weekdays[localClock(ctx).weekday]
        default:
            v = nil
        }
        return v?.lowercased()
    }

    private static func list(_ value: String?) -> [String] {
        return (value ?? "")
            .components(separatedBy: CharacterSet(charactersIn: ",\n"))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty }
    }

    private static func isDigits(_ s: String) -> Bool {
        return !s.isEmpty && s.unicodeScalars.allSatisfy { $0.value >= 48 && $0.value <= 57 }
    }

    /// JS `<` on strings: UTF-16 code units, not Unicode collation.
    private static func jsLess(_ a: String, _ b: String) -> Bool {
        return Array(a.utf16).lexicographicallyPrecedes(Array(b.utf16))
    }

    /// Dotted parts compare as numbers when both are digits (`2.10.0` > `2.9`), otherwise as
    /// strings; a missing part counts as 0 (`2.0` equals `2`). Returns -1, 0 or 1.
    static func compareVersions(_ a: String, _ b: String) -> Int {
        let pa = a.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: ".")
        let pb = b.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: ".")
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i] : "0"
            let y = i < pb.count ? pb[i] : "0"
            if isDigits(x) && isDigits(y) {
                let dx = Double(x) ?? 0
                let dy = Double(y) ?? 0
                if dx != dy { return dx < dy ? -1 : 1 }
            } else if Array(x.utf16) != Array(y.utf16) {
                return jsLess(x, y) ? -1 : 1
            }
        }
        return 0
    }

    static func evaluate(_ c: TargetCondition, _ ctx: TargetingContext) -> Bool {
        let actual = contextValue(c.field, c.key, ctx)
        let expected = (c.value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch c.op {
        case "exists":
            return actual != nil && actual != ""
        case "not_exists":
            return actual == nil || actual == ""
        case "is":
            return actual != nil && actual == expected
        case "is_not":
            return actual == nil || actual != expected
        case "contains":
            guard let a = actual, !expected.isEmpty else { return false }
            return a.contains(expected)
        case "not_contains":
            guard let a = actual, !expected.isEmpty else { return true }
            return !a.contains(expected)
        case "starts_with":
            guard let a = actual else { return false }
            return expected.isEmpty || a.hasPrefix(expected)
        case "in":
            guard let a = actual else { return false }
            return list(c.value).contains(a)
        case "not_in":
            guard let a = actual else { return true }
            return !list(c.value).contains(a)
        case "gte":
            guard let a = actual, !a.isEmpty, !expected.isEmpty else { return false }
            return compareVersions(a, expected) >= 0
        case "lt":
            guard let a = actual, !a.isEmpty, !expected.isEmpty else { return false }
            return compareVersions(a, expected) < 0
        case "matches":
            guard let a = actual, let re = try? NSRegularExpression(pattern: c.value ?? "", options: [.caseInsensitive]) else { return false }
            return re.firstMatch(in: a, options: [], range: NSRange(a.startIndex..<a.endIndex, in: a)) != nil
        default:
            return false
        }
    }

    static func matchAll(_ conditions: [TargetCondition], _ match: String, _ ctx: TargetingContext) -> Bool {
        if conditions.isEmpty { return true }
        return match == "any" ? conditions.contains { evaluate($0, ctx) } : conditions.allSatisfy { evaluate($0, ctx) }
    }

    /// The variant this visitor reaches, or nil (skip or dead end).
    static func runFlow(_ e: Experiment, _ flow: Flow, _ visitorId: String, _ ctx: TargetingContext) -> Variant? {
        var id: String? = flow.start
        var step = 0
        while step < maxSteps, let current = id, !current.isEmpty {
            step += 1
            guard let node = flow.nodes[current] else { return nil }
            switch node {
            case let .condition(conditions, match, then, otherwise):
                id = matchAll(conditions, match, ctx) ? then : otherwise
            case let .split(outputs):
                let total = outputs.reduce(0.0) { $0 + max(0, $1.weight) }
                if total <= 0 || outputs.isEmpty { return nil }
                let unit = Hash.unit("\(e.seed):\(e.key):flow:\(current):\(visitorId)") * total
                var acc = 0.0
                var to = outputs[outputs.count - 1].to
                for o in outputs {
                    acc += max(0, o.weight)
                    if unit < acc {
                        to = o.to
                        break
                    }
                }
                id = to
            case let .variant(key):
                return e.variants.first { $0.key == key }
            case .skip:
                return nil
            case .unknown:
                // Core loops on an unknown node until the step limit, then calls it a dead end.
                return nil
            }
        }
        return nil
    }
}
