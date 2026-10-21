import Foundation

// The shapes of `@splithub/core` after `defineConfig`, as the cloud sends them in the
// overrides JSON (`added` experiments, goals, properties, holdout, layers). Decoding is
// lenient: a missing or odd field takes its default instead of failing the whole file.

public struct Variant: Equatable {
    public let key: String
    /// Share in 0..1 (normalized).
    public internal(set) var weight: Double
    /// Payload of a `value` (or multivariate) experiment.
    public internal(set) var value: JSONValue?
    public let to: String?
    public let levels: [String: String]?

    init(key: String, weight: Double, value: JSONValue? = nil, to: String? = nil, levels: [String: String]? = nil) {
        self.key = key
        self.weight = weight
        self.value = value
        self.to = to
        self.levels = levels
    }
}

extension Variant: Decodable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: JSONKey.self)
        key = try c.decode(String.self, forKey: JSONKey("key"))
        weight = c.lenient("weight") ?? 0
        value = c.lenient("value")
        to = c.lenient("to")
        levels = c.lenient("levels")
    }
}

public struct TargetCondition: Decodable, Equatable {
    public var field: String
    public var op: String
    public var key: String?
    public var value: String?

    public init(field: String, op: String, key: String? = nil, value: String? = nil) {
        self.field = field
        self.op = op
        self.key = key
        self.value = value
    }
}

enum FlowNode: Decodable, Equatable {
    case condition(conditions: [TargetCondition], match: String, then: String?, otherwise: String?)
    case split(outputs: [(weight: Double, to: String?)])
    case variant(String)
    case skip
    case unknown

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: JSONKey.self)
        switch c.lenient("type", as: String.self) ?? "" {
        case "condition":
            let list: [Lossy<TargetCondition>] = c.lenient("conditions") ?? []
            self = .condition(conditions: list.compactMap { $0.value }, match: c.lenient("match") ?? "all", then: c.lenient("then"), otherwise: c.lenient("else"))
        case "split":
            let outputs: [Lossy<SplitOutput>] = c.lenient("outputs") ?? []
            self = .split(outputs: outputs.compactMap { $0.value }.map { (weight: $0.weight, to: $0.to) })
        case "variant":
            self = .variant(c.lenient("variant") ?? "")
        case "skip":
            self = .skip
        default:
            self = .unknown
        }
    }

    static func == (a: FlowNode, b: FlowNode) -> Bool {
        switch (a, b) {
        case let (.condition(c1, m1, t1, e1), .condition(c2, m2, t2, e2)):
            return c1 == c2 && m1 == m2 && t1 == t2 && e1 == e2
        case let (.split(o1), .split(o2)):
            return o1.count == o2.count && zip(o1, o2).allSatisfy { $0.weight == $1.weight && $0.to == $1.to }
        case let (.variant(v1), .variant(v2)):
            return v1 == v2
        case (.skip, .skip), (.unknown, .unknown):
            return true
        default:
            return false
        }
    }
}

private struct SplitOutput: Decodable {
    let weight: Double
    let to: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: JSONKey.self)
        weight = c.lenient("weight") ?? 0
        to = c.lenient("to")
    }
}

struct Flow: Decodable, Equatable {
    let start: String
    let nodes: [String: FlowNode]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: JSONKey.self)
        start = try c.decode(String.self, forKey: JSONKey("start"))
        let raw: [String: Lossy<FlowNode>] = c.lenient("nodes") ?? [:]
        var nodes: [String: FlowNode] = [:]
        for (id, node) in raw { nodes[id] = node.value ?? .unknown }
        self.nodes = nodes
    }
}

public struct Experiment: Equatable {
    public let key: String
    /// `component`, `value`, `redirect` or `mvt`.
    public let kind: String
    /// `draft`, `running`, `paused` or `finished`.
    public internal(set) var status: String
    public internal(set) var traffic: Double
    public let goal: String?
    public internal(set) var seed: String
    /// Ordered: the first variant is the control.
    public internal(set) var variants: [Variant]
    let flow: Flow?
    let layerKey: String?
    let layerRange: [Double]?
    let startAt: String?
    let endAt: String?

    public var control: Variant? { variants.first }
}

extension Experiment: Decodable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: JSONKey.self)
        key = try c.decode(String.self, forKey: JSONKey("key"))
        let list: [Lossy<Variant>] = c.lenient("variants") ?? []
        variants = list.compactMap { $0.value }
        kind = c.lenient("kind") ?? "component"
        status = c.lenient("status") ?? "draft"
        traffic = c.lenient("traffic") ?? 1
        goal = c.lenient("goal")
        // The cloud always sends the seed; the key is what defineConfig would have chosen.
        seed = c.lenient("seed") ?? key
        flow = c.lenient("flow")
        if let layer = c.lenient("layer", as: LayerRef.self) {
            layerKey = layer.key
            layerRange = layer.range
        } else {
            layerKey = nil
            layerRange = nil
        }
        let schedule = c.lenient("schedule", as: Schedule.self)
        startAt = schedule?.startAt
        endAt = schedule?.endAt
    }
}

private struct LayerRef: Decodable {
    let key: String
    let range: [Double]
}

private struct Schedule: Decodable {
    let startAt: String?
    let endAt: String?
}

struct Goal: Decodable, Equatable {
    let key: String
    let type: String
    let path: String?
    let event: String?

    init(key: String, type: String = "event", path: String? = nil, event: String? = nil) {
        self.key = key
        self.type = type
        self.path = path
        self.event = event
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: JSONKey.self)
        key = try c.decode(String.self, forKey: JSONKey("key"))
        type = c.lenient("type") ?? "event"
        path = c.lenient("path")
        event = c.lenient("event")
    }
}

struct Property: Decodable, Equatable {
    let key: String
    var status: String
    let kind: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: JSONKey.self)
        key = try c.decode(String.self, forKey: JSONKey("key"))
        status = c.lenient("status") ?? "running"
        kind = c.lenient("kind")
    }
}

struct Holdout: Decodable, Equatable {
    let percent: Double
    let seed: String?
    let goal: String?

    init(percent: Double, seed: String?, goal: String? = nil) {
        self.percent = percent
        self.seed = seed
        self.goal = goal
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: JSONKey.self)
        percent = try c.decode(Double.self, forKey: JSONKey("percent"))
        seed = c.lenient("seed")
        goal = c.lenient("goal")
    }

    /// `validHoldout` in core: 0 < percent <= 50 and a seed.
    var isValid: Bool { percent > 0 && percent <= 50 && seed != nil }
}

struct LayerSeed: Decodable, Equatable {
    let seed: String?
}

/// The live config: what `applyRemoteOverrides` returns in core. Apps have no config
/// file, so everything comes from the overrides JSON on top of an empty config.
struct Config: Decodable, Equatable {
    var goals: [Goal] = []
    var experiments: [Experiment] = []
    var properties: [Property] = []
    var layers: [String: LayerSeed]? = nil
    var holdout: Holdout? = nil

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: JSONKey.self)
        goals = (c.lenient("goals", as: [Lossy<Goal>].self) ?? []).compactMap { $0.value }
        experiments = (c.lenient("experiments", as: [Lossy<Experiment>].self) ?? []).compactMap { $0.value }
        properties = (c.lenient("properties", as: [Lossy<Property>].self) ?? []).compactMap { $0.value }
        layers = c.lenient("layers")
        holdout = c.lenient("holdout")
    }

    func experiment(_ key: String) -> Experiment? {
        return experiments.first { $0.key == key }
    }
}

struct ExperimentOverride: Decodable {
    let status: String?
    let traffic: Double?
    let weights: [String: Double]?
    let values: [String: JSONValue]?
    let seed: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: JSONKey.self)
        status = c.lenient("status")
        traffic = c.lenient("traffic")
        weights = c.lenient("weights")
        values = c.lenient("values")
        seed = c.lenient("seed")
    }
}

struct PropertyPatch: Decodable {
    let status: String?
}

/// What the cloud knows about this device's request: country, region, city, time zone.
struct GeoContext: Decodable, Equatable {
    let country: String?
    let region: String?
    let city: String?
    let timezone: String?
}

/// `GET /v1/overrides/<pk>.json`. `version` and `experiments` are required, like `isRemoteOverrides` in core.
struct RemoteOverrides: Decodable {
    let version: Double
    let experiments: [String: ExperimentOverride]
    let added: [Experiment]
    let goals: [Goal]
    let properties: [String: PropertyPatch]
    let addedProperties: [Property]
    let holdout: Holdout?
    let layers: [String: LayerSeed]?
    let ctx: GeoContext?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: JSONKey.self)
        version = try c.decode(Double.self, forKey: JSONKey("version"))
        let patches = try c.decode([String: Lossy<ExperimentOverride>].self, forKey: JSONKey("experiments"))
        var experiments: [String: ExperimentOverride] = [:]
        for (key, patch) in patches {
            if let p = patch.value { experiments[key] = p }
        }
        self.experiments = experiments
        added = (c.lenient("added", as: [Lossy<Experiment>].self) ?? []).compactMap { $0.value }
        goals = (c.lenient("goals", as: [Lossy<Goal>].self) ?? []).compactMap { $0.value }
        var props: [String: PropertyPatch] = [:]
        for (key, patch) in c.lenient("properties", as: [String: Lossy<PropertyPatch>].self) ?? [:] {
            if let p = patch.value { props[key] = p }
        }
        properties = props
        addedProperties = (c.lenient("addedProperties", as: [Lossy<Property>].self) ?? []).compactMap { $0.value }
        holdout = c.lenient("holdout")
        layers = c.lenient("layers")
        ctx = c.lenient("ctx")
    }

    static func decode(_ data: Data) -> RemoteOverrides? {
        return try? JSONDecoder().decode(RemoteOverrides.self, from: data)
    }
}

/// What the SDK knows about the user when assigning. Everything is optional.
public struct TargetingContext: Decodable, Equatable {
    public var country: String?
    public var region: String?
    public var city: String?
    /// `mobile`, `tablet` or `desktop`.
    public var device: String?
    public var browser: String?
    public var os: String?
    /// `en-US`; conditions read the language part.
    public var language: String?
    public var referrer: String?
    public var url: String?
    public var cookies: [String: String]?
    /// `new` on the launch that created the visitor id, `returning` afterwards.
    public var visitor: String?
    /// Clock for `hour` / `weekday` in Unix ms; nil means now.
    public var now: Double?
    /// IANA time zone (`Europe/Berlin`) for `hour` / `weekday`; nil means UTC.
    public var timezone: String?
    /// `ios`, `macos` (apps), `web` (browsers).
    public var platform: String?
    public var appVersion: String?

    public init(
        country: String? = nil, region: String? = nil, city: String? = nil, device: String? = nil,
        browser: String? = nil, os: String? = nil, language: String? = nil, referrer: String? = nil,
        url: String? = nil, cookies: [String: String]? = nil, visitor: String? = nil, now: Double? = nil,
        timezone: String? = nil, platform: String? = nil, appVersion: String? = nil
    ) {
        self.country = country
        self.region = region
        self.city = city
        self.device = device
        self.browser = browser
        self.os = os
        self.language = language
        self.referrer = referrer
        self.url = url
        self.cookies = cookies
        self.visitor = visitor
        self.now = now
        self.timezone = timezone
        self.platform = platform
        self.appVersion = appVersion
    }

    /// This context with every field `other` sets taking its place.
    func merged(with other: TargetingContext?) -> TargetingContext {
        guard let o = other else { return self }
        var m = self
        if let v = o.country { m.country = v }
        if let v = o.region { m.region = v }
        if let v = o.city { m.city = v }
        if let v = o.device { m.device = v }
        if let v = o.browser { m.browser = v }
        if let v = o.os { m.os = v }
        if let v = o.language { m.language = v }
        if let v = o.referrer { m.referrer = v }
        if let v = o.url { m.url = v }
        if let v = o.cookies { m.cookies = v }
        if let v = o.visitor { m.visitor = v }
        if let v = o.now { m.now = v }
        if let v = o.timezone { m.timezone = v }
        if let v = o.platform { m.platform = v }
        if let v = o.appVersion { m.appVersion = v }
        return m
    }
}

/// Who sees what, and why.
public struct Assignment: Equatable {
    public enum Reason: String {
        case assigned
        case dev
        case notRunning = "not_running"
        case outsideTraffic = "outside_traffic"
        case unknownExperiment = "unknown_experiment"
        case override
        case targeting
        case bot
        case noVisitor = "no_visitor"
        case layer
        case holdout
        /// First launch, waiting for the dashboard's experiments (control meanwhile).
        case pending
    }

    public let experiment: String
    /// Nil when the user is outside the experiment: they see the control.
    public let variant: Variant?
    public let reason: Reason
}
