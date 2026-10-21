import Foundation

/// A port of `assignment.ts` in `@splithub/core`. Hash strings and comparisons are kept
/// exactly as there, so a visitor id gets the same variant here, on Android and on the web.
enum Engine {
    static let holdoutKey = "__holdout"
    static let layerBuckets = 100

    /// Two independent hashes, so changing `traffic` never reshuffles visitors already inside.
    static func pickVariant(_ e: Experiment, _ visitorId: String) -> Variant? {
        let trafficUnit = Hash.unit("\(e.seed):\(e.key):traffic:\(visitorId)")
        if trafficUnit >= e.traffic { return nil }
        let unit = Hash.unit("\(e.seed):\(e.key):variant:\(visitorId)")
        var cumulative = 0.0
        for v in e.variants {
            cumulative += v.weight
            if unit < cumulative { return v }
        }
        // Floating point rounding: the last variant.
        return e.variants.last
    }

    /// `holdout` (control everywhere) or `enrolled`; nil without a holdout.
    static func holdoutGroup(_ config: Config, _ visitorId: String) -> String? {
        guard let h = config.holdout, h.percent > 0 else { return nil }
        let seed = h.seed ?? holdoutKey
        return Hash.unit("\(seed):\(holdoutKey):\(visitorId)") < h.percent / 100 ? "holdout" : "enrolled"
    }

    /// The visitor's bucket 0..99 in a layer: the same in every experiment of the layer.
    static func layerBucket(_ config: Config, _ layerKey: String, _ visitorId: String) -> Int {
        let seed = config.layers?[layerKey]?.seed ?? layerKey
        let unit = Hash.unit("\(seed):layer:\(layerKey):\(visitorId)")
        return min(layerBuckets - 1, Int((unit * Double(layerBuckets)).rounded(.down)))
    }

    static func inLayer(_ config: Config, _ e: Experiment, _ visitorId: String) -> Bool {
        guard let key = e.layerKey, let range = e.layerRange, range.count == 2 else { return true }
        let b = Double(layerBucket(config, key, visitorId))
        return b >= range[0] && b < range[1]
    }

    /// Reached a running experiment, in or out of it: counted in the holdout comparison.
    static func countsForHoldout(_ a: Assignment) -> Bool {
        switch a.reason {
        case .assigned, .holdout, .outsideTraffic, .targeting, .layer:
            return true
        default:
            return false
        }
    }

    static func inSchedule(_ e: Experiment, now: Double) -> Bool {
        if let s = e.startAt, let t = parseDate(s), now < t { return false }
        if let s = e.endAt, let t = parseDate(s), now > t { return false }
        return true
    }

    static func assign(_ config: Config, _ key: String, _ visitorId: String, overrides: [String: String] = [:], context: TargetingContext = TargetingContext()) -> Assignment {
        guard let e = config.experiment(key) else {
            return Assignment(experiment: key, variant: nil, reason: .unknownExperiment)
        }
        if let forced = overrides[key], !forced.isEmpty {
            // A typo in a forced variant is still a preview: control, never counted.
            let v = e.variants.first { $0.key == forced } ?? e.variants.first
            return Assignment(experiment: key, variant: v, reason: .override)
        }
        if context.device == "bot" { return Assignment(experiment: key, variant: nil, reason: .bot) }
        if e.status != "running" || !inSchedule(e, now: context.now ?? nowMs()) {
            return Assignment(experiment: key, variant: nil, reason: .notRunning)
        }
        // Holdout and layers decide who may enter at all, before traffic and targeting.
        if holdoutGroup(config, visitorId) == "holdout" { return Assignment(experiment: key, variant: nil, reason: .holdout) }
        if !inLayer(config, e, visitorId) { return Assignment(experiment: key, variant: nil, reason: .layer) }
        if let flow = e.flow {
            let trafficUnit = Hash.unit("\(e.seed):\(e.key):traffic:\(visitorId)")
            if trafficUnit >= e.traffic { return Assignment(experiment: key, variant: nil, reason: .outsideTraffic) }
            if let v = Targeting.runFlow(e, flow, visitorId, context) {
                return Assignment(experiment: key, variant: v, reason: .assigned)
            }
            return Assignment(experiment: key, variant: nil, reason: .targeting)
        }
        guard let v = pickVariant(e, visitorId) else {
            return Assignment(experiment: key, variant: nil, reason: .outsideTraffic)
        }
        return Assignment(experiment: key, variant: v, reason: .assigned)
    }

    /// `Date.parse` for the ISO dates the cloud writes; nil when unreadable (then the bound is ignored, as NaN is in JS).
    static func parseDate(_ s: String) -> Double? {
        for f in dateFormatters {
            if let d = f.date(from: s) { return d.timeIntervalSince1970 * 1000 }
        }
        return nil
    }

    private static let dateFormatters: [ISO8601DateFormatter] = {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        let day = ISO8601DateFormatter()
        day.formatOptions = [.withFullDate]
        day.timeZone = TimeZone(identifier: "UTC")
        return [withFraction, plain, day]
    }()
}

// MARK: - Config helpers (config.ts, remote.ts)

enum Keys {
    /// Keys of experiments, goals, properties: lowercase letters, digits, `-` and `_`, up to 64.
    static func isKey(_ s: String) -> Bool {
        return fullMatch("[a-z0-9][a-z0-9_-]{0,63}", s)
    }

    /// Event names: letters, digits, spaces and `_ . : / -`, up to 64 characters.
    static func isEventName(_ s: String) -> Bool {
        return fullMatch("[A-Za-z0-9][A-Za-z0-9 _.:/-]{0,63}", s)
    }

    /// `Video Played` → `video-played`.
    static func eventKey(_ name: String) -> String {
        var s = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        s = s.replacingOccurrences(of: "[^a-z0-9_-]+", with: "-", options: .regularExpression)
        s = s.replacingOccurrences(of: "^[^a-z0-9]+", with: "", options: .regularExpression)
        s = String(s.prefix(64))
        s = s.replacingOccurrences(of: "-+$", with: "", options: .regularExpression)
        return s
    }

    /// A declared goal key, the goal whose `event` is that name, or the name's slug.
    static func goalKey(_ goals: [Goal], _ name: String) -> String? {
        if goals.contains(where: { $0.key == name }) { return name }
        if let g = goals.first(where: { $0.event == name }) { return g.key }
        let slug = eventKey(name)
        return isKey(slug) ? slug : nil
    }

    static func fullMatch(_ pattern: String, _ s: String) -> Bool {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return false }
        let range = NSRange(s.startIndex..<s.endIndex, in: s)
        guard let m = re.firstMatch(in: s, options: [.anchored], range: range) else { return false }
        return m.range.location == 0 && m.range.length == range.length
    }

    /// `/pricing/` → `/pricing`; the root stays `/`.
    static func normalizePath(_ path: String) -> String {
        guard path.count > 1, path.hasSuffix("/") else { return path }
        var p = path
        while p.hasSuffix("/") { p.removeLast() }
        return p.isEmpty ? "/" : p
    }

    /// An exact path or a prefix ending with `*`.
    static func matchPath(_ pattern: String, _ path: String) -> Bool {
        if pattern.hasSuffix("*") { return path.hasPrefix(String(pattern.dropLast())) }
        return normalizePath(pattern) == normalizePath(path)
    }

    /// `https://go.splithub.io/v1/events` → `https://go.splithub.io/v1/overrides/<pk>.json?all=1`.
    /// `all=1`: an app has no config file, so it also asks for the experiments pushed from `splithub.config.ts`.
    static func overridesURL(_ eventsEndpoint: String, _ publicKey: String) -> URL? {
        var base = eventsEndpoint
        if base.hasSuffix("/") { base.removeLast() }
        if base.hasSuffix("/events") { base.removeLast("/events".count) }
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-_.!~*'()")
        let key = publicKey.addingPercentEncoding(withAllowedCharacters: allowed) ?? publicKey
        return URL(string: "\(base)/overrides/\(key).json?all=1")
    }
}

enum Overrides {
    /// `applyRemoteOverrides` in core: a new config, never a mutation.
    static func apply(_ config: Config, _ o: RemoteOverrides?) -> Config {
        guard let o = o else { return config }
        var out = config
        let known = Set(config.experiments.map { $0.key })
        let added = o.added.filter { !known.contains($0.key) && $0.variants.count >= 2 }
        let knownGoals = Set(config.goals.map { $0.key })
        out.goals = config.goals + o.goals.filter { !knownGoals.contains($0.key) }
        if config.holdout == nil, let h = o.holdout, h.isValid { out.holdout = h }
        if let layers = o.layers {
            // The config's own layers win.
            out.layers = layers.merging(config.layers ?? [:]) { _, mine in mine }
        }
        if !o.properties.isEmpty || !o.addedProperties.isEmpty {
            let knownProps = Set(config.properties.map { $0.key })
            let all = config.properties + o.addedProperties.filter { !knownProps.contains($0.key) }
            out.properties = all.map { p in
                var p = p
                if let s = o.properties[p.key]?.status, s == "running" || s == "paused" { p.status = s }
                return p
            }
        }
        out.experiments = (config.experiments + added).map { e in
            guard let patch = o.experiments[e.key] else { return e }
            return applyPatch(e, patch)
        }
        return out
    }

    static func applyPatch(_ e: Experiment, _ o: ExperimentOverride) -> Experiment {
        var out = e
        var variants = e.variants
        if let weights = o.weights {
            let raw = variants.map { v -> Variant in
                var v = v
                v.weight = max(0, weights[v.key] ?? v.weight)
                return v
            }
            let total = raw.reduce(0.0) { $0 + $1.weight }
            if total > 0 {
                variants = raw.map { v -> Variant in
                    var v = v
                    v.weight = v.weight / total
                    return v
                }
            }
        }
        if let values = o.values, e.kind == "value" {
            variants = variants.map { v -> Variant in
                guard let value = values[v.key] else { return v }
                var v = v
                v.value = value
                return v
            }
        }
        if let s = o.status { out.status = s }
        if let t = o.traffic, t >= 0, t <= 1 { out.traffic = t }
        if let s = o.seed { out.seed = s }
        out.variants = variants
        return out
    }
}
