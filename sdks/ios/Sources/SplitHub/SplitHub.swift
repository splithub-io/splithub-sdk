import Combine
import Foundation
import os
#if os(iOS) || os(tvOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

/// Experiments and analytics for your app.
///
/// ```swift
/// SplitHub.start(publicKey: "pk_...", property: "sh-x1h78w")
/// let cta = SplitHub.variant("checkout-button")
/// SplitHub.track("Purchase", props: ["revenue": 29])
/// ```
///
/// Experiments come from the dashboard: the SDK fetches them, keeps a copy on disk and
/// applies it at once on the next launch. On the very first launch it waits up to
/// `Options.waitMs` for them and shows the control meanwhile.
public final class SplitHub: ObservableObject {
    public static let shared = SplitHub()
    public static let version = "0.5.1"
    public static let defaultEndpoint = URL(string: "https://go.splithub.io/v1/events")!

    public struct Options {
        /// First launch, nothing cached yet: how long to wait for the dashboard's experiments before showing the control. 0 decides at once.
        public var waitMs: Int
        /// Where to fetch experiments from. Default: next to the events endpoint.
        public var overridesURL: URL?
        /// Force variants for QA: `["checkout-button": "green"]`. Forced views are never counted.
        public var force: [String: String]
        /// Extra targeting fields; they win over what the SDK detects.
        public var context: TargetingContext?
        /// Send nothing and fetch nothing (tests, SwiftUI previews).
        public var disabled: Bool
        /// Send at least this often, in seconds.
        public var flushInterval: TimeInterval
        /// Send as soon as this many events wait.
        public var maxBatch: Int
        /// Log every event to the console (Logger, subsystem `io.splithub`).
        public var logging: Bool

        public init(
            waitMs: Int = 400,
            overridesURL: URL? = nil,
            force: [String: String] = [:],
            context: TargetingContext? = nil,
            disabled: Bool = false,
            flushInterval: TimeInterval = 2,
            maxBatch: Int = 20,
            logging: Bool = false
        ) {
            self.waitMs = waitMs
            self.overridesURL = overridesURL
            self.force = force
            self.context = context
            self.disabled = disabled
            self.flushInterval = flushInterval
            self.maxBatch = maxBatch
            self.logging = logging
        }
    }

    /// Changes when experiments are decided (first launch) or refreshed (a new session). SwiftUI views observe it.
    @Published public private(set) var revision = 0

    static let remoteTTLMs: Double = 60_000
    static let propertyWaitMs = 5000
    static let sessionTimeout: TimeInterval = 30 * 60
    static let maxPropsBytes = 4096
    static let maxEngageMs = 3_600_000
    static let visitorKey = "sh_vid"
    static let uidKey = "sh_uid"

    private struct ScreenTime {
        let prop: String
        let url: String
        var ms: Double
        var since: Date?
    }

    private let lock = NSRecursiveLock()
    private let log = Logger(subsystem: "io.splithub", category: "SplitHub")
    private let defaults: UserDefaults
    private var started = false
    private var options = Options()
    private var publicKey = ""
    private var overridesURL: URL?
    private var wanted: String?
    private var queue: EventQueue?
    private var app: AppInfo?
    private var config = Config()
    /// The freshest overrides, for analytics: a property made in the dashboard counts at once,
    /// while experiments stay as decided until the next launch or session.
    private var propConfig = Config()
    private var geo: GeoContext?
    private var context = TargetingContext()
    private var visitor = ""
    private var session = ""
    private var newVisitor = false
    private var pending = false
    private var waiting: [(exp: String, ts: Int64)] = []
    private var deferred: [() -> Void] = []
    private var propertyFetching = false
    private var propertyWaiting: [() -> Void] = []
    private var exposed = Set<String>()
    private var sentIdentity: String?
    private var lastPage: (url: String, ts: Int64)?
    private var currentURL: String?
    private var currentTitle: String?
    private var screenTime: ScreenTime?
    private var backgroundSince: Date?
    private var observers: [NSObjectProtocol] = []
    private var warned = Set<String>()

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    // MARK: - Static shortcuts

    /// Starts the SDK. Call it once, as early as you can (`App.init`, `application(_:didFinishLaunchingWithOptions:)`).
    /// - Parameters:
    ///   - publicKey: your project's public key (`pk_...`), safe to ship in the app.
    ///   - property: the analytics property that receives screens and events (`sh-x1h78w`). Without it only experiments are measured.
    public static func start(publicKey: String, property: String? = nil, endpoint: URL = SplitHub.defaultEndpoint, options: Options = Options()) {
        shared.start(publicKey: publicKey, property: property, endpoint: endpoint, options: options)
    }

    /// The variant key this user sees, and records that they saw it. `default` while nothing is known.
    public static func variant(_ experiment: String, default fallback: String = "control") -> String {
        return shared.variant(experiment, default: fallback)
    }

    /// The payload of a `value` experiment, decoded as `T`; nil while nothing is known.
    public static func value<T: Decodable>(_ experiment: String, as type: T.Type = T.self) -> T? {
        return shared.value(experiment, as: type)
    }

    /// Who sees what, and why, without recording anything.
    public static func assignment(_ experiment: String) -> Assignment {
        return shared.assignment(experiment)
    }

    /// Records that the user saw their variant (once per session).
    public static func exposure(_ experiment: String) {
        shared.exposure(experiment)
    }

    /// An event, any name: `track("Purchase", props: ["revenue": 29])`. Converts the experiments whose goal it is.
    public static func track(_ name: String, props: [String: JSONValue]? = nil) {
        shared.track(name, props: props)
    }

    /// A screen view, sent as a page `/<name>` with the name as title.
    public static func screen(_ name: String, props: [String: JSONValue]? = nil) {
        shared.screen(name, props: props)
    }

    /// Ties this device to your user id (1 to 128 characters), with flat traits (`["plan": "pro"]`).
    public static func identify(userId: String, traits: [String: JSONValue]? = nil) {
        shared.identify(userId: userId, traits: traits)
    }

    /// Logout: forgets the user id and starts a new anonymous visitor (who may get other variants).
    public static func reset() {
        shared.reset()
    }

    /// Sends waiting events now.
    public static func flush() {
        shared.flush()
    }

    /// The anonymous id this device uses for assignment.
    public static var visitorId: String { shared.visitorId }

    // MARK: - Instance API

    public var visitorId: String {
        lock.lock()
        defer { lock.unlock() }
        return visitor
    }

    public var sessionId: String {
        lock.lock()
        defer { lock.unlock() }
        return session
    }

    /// True on the first launch while the dashboard's experiments are on their way.
    public var isPending: Bool {
        lock.lock()
        defer { lock.unlock() }
        return pending
    }

    public func start(publicKey: String, property: String? = nil, endpoint: URL = SplitHub.defaultEndpoint, options: Options = Options()) {
        lock.lock()
        defer { lock.unlock() }
        if started {
            warn("start() ran twice; the first call counts.")
            return
        }
        let key = publicKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard key.hasPrefix("pk_") else {
            warn("start() needs your public key, which starts with pk_. Nothing is sent until then.")
            return
        }
        started = true
        self.publicKey = key
        self.options = options
        if ProcessInfo.processInfo.environment["XCODE_RUNNING_FOR_PREVIEWS"] == "1" { self.options.disabled = true }
        let p = property?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        wanted = p.isEmpty ? nil : p

        if let id = defaults.string(forKey: Self.visitorKey), !id.isEmpty {
            visitor = id
        } else {
            visitor = IDs.new("v_")
            defaults.set(visitor, forKey: Self.visitorKey)
            newVisitor = true
        }
        session = IDs.new("s_")
        let info = Device.appInfo()
        app = info
        overridesURL = options.overridesURL ?? Keys.overridesURL(endpoint.absoluteString, key)

        if !self.options.disabled {
            var settings = EventQueue.Settings()
            settings.maxBatch = max(1, options.maxBatch)
            settings.flushInterval = max(0.1, options.flushInterval)
            queue = EventQueue(
                project: "app",
                sdk: "ios/\(Self.version)",
                app: info,
                transport: URLSessionTransport(endpoint: endpoint, key: key),
                fileURL: Self.queueFile(),
                settings: settings
            )
        }

        let cached = readCache()
        if let c = cached { applyFresh(c.overrides) }
        context = buildContext()
        let stale = cached.map { nowMs() - $0.fetchedAt > Self.remoteTTLMs } ?? true
        if stale && !self.options.disabled {
            let decides = cached == nil && options.waitMs > 0
            if decides {
                pending = true
                DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(options.waitMs)) { [weak self] in
                    self?.decide(nil)
                }
            }
            if wanted != nil && !knownProperty() {
                propertyFetching = true
                DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(Self.propertyWaitMs)) { [weak self] in
                    self?.propertyArrived()
                }
            }
            fetchOverrides(deciding: decides)
        }
        observeLifecycle()
        // Events kept from an earlier launch.
        queue?.flush()
    }

    public func assignment(_ experiment: String) -> Assignment {
        lock.lock()
        defer { lock.unlock() }
        guard started else { return Assignment(experiment: experiment, variant: nil, reason: .unknownExperiment) }
        if pending { return Assignment(experiment: experiment, variant: nil, reason: .pending) }
        return Engine.assign(config, experiment, visitor, overrides: options.force, context: context)
    }

    public func variant(_ experiment: String, default fallback: String = "control") -> String {
        lock.lock()
        defer { lock.unlock() }
        let key = peekVariant(experiment, default: fallback)
        exposure(experiment)
        return key
    }

    public func value<T: Decodable>(_ experiment: String, as type: T.Type = T.self) -> T? {
        lock.lock()
        defer { lock.unlock() }
        let raw = peekValue(experiment)
        exposure(experiment)
        return raw?.decode(T.self)
    }

    public func exposure(_ experiment: String) {
        lock.lock()
        defer { lock.unlock() }
        guard started, queue != nil else { return }
        if pending {
            if !waiting.contains(where: { $0.exp == experiment }) { waiting.append((exp: experiment, ts: nowTs())) }
            return
        }
        sendExposure(experiment, ts: nowTs())
    }

    public func track(_ name: String, props: [String: JSONValue]? = nil) {
        lock.lock()
        defer { lock.unlock() }
        guard started, queue != nil else { return }
        let ts = nowTs()
        let fitted = fitProps(props, what: "event \"\(name)\"")
        // After the waiting exposures: a goal only converts a user already in the experiment.
        if pending {
            deferred.append { [weak self] in self?.sendTracked(name, fitted, ts) }
        } else {
            sendTracked(name, fitted, ts)
        }
    }

    /// `props` are accepted for later: a page row carries none today, so they are not sent.
    public func screen(_ name: String, props: [String: JSONValue]? = nil) {
        lock.lock()
        defer { lock.unlock() }
        guard started, queue != nil else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let path = String((trimmed.hasPrefix("/") ? trimmed : "/" + trimmed).prefix(512))
        let title = String(trimmed.prefix(200))
        let ts = nowTs()
        if pending {
            deferred.append { [weak self] in self?.sendPage(path, title: title, ts: ts) }
        } else {
            sendPage(path, title: title, ts: ts)
        }
    }

    public func identify(userId: String, traits: [String: JSONValue]? = nil) {
        lock.lock()
        defer { lock.unlock() }
        let id = userId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty, id.utf16.count <= 128 else {
            warn("identify() needs a user id of 1 to 128 characters.")
            return
        }
        defaults.set(id, forKey: Self.uidKey)
        guard started, queue != nil else { return }
        sendIdentify(id, cleanTraits(traits), ts: nowTs())
    }

    public func reset() {
        lock.lock()
        defer { lock.unlock() }
        defaults.removeObject(forKey: Self.uidKey)
        sentIdentity = nil
        guard started else { return }
        _ = emitEngage(final: true)
        visitor = IDs.new("v_")
        defaults.set(visitor, forKey: Self.visitorKey)
        newVisitor = true
        session = IDs.new("s_")
        exposed.removeAll()
        lastPage = nil
        context = buildContext()
        bumpRevision()
    }

    public func flush() {
        lock.lock()
        let q = queue
        lock.unlock()
        q?.flush(force: true)
    }

    // MARK: - Reading without recording (SwiftUI views)

    func peekVariant(_ experiment: String, default fallback: String) -> String {
        lock.lock()
        defer { lock.unlock() }
        guard started, !pending else { return fallback }
        guard let e = config.experiment(experiment) else {
            warn("experiment \"\(experiment)\" is not running in this project; showing \"\(fallback)\".")
            return fallback
        }
        let a = Engine.assign(config, experiment, visitor, overrides: options.force, context: context)
        return (a.variant ?? e.variants.first)?.key ?? fallback
    }

    func peekValue(_ experiment: String) -> JSONValue? {
        lock.lock()
        defer { lock.unlock() }
        guard started, !pending, let e = config.experiment(experiment) else { return nil }
        let a = Engine.assign(config, experiment, visitor, overrides: options.force, context: context)
        return (a.variant ?? e.variants.first)?.value
    }

    // MARK: - Overrides

    private func applyFresh(_ o: RemoteOverrides) {
        config = Overrides.apply(Config(), o)
        propConfig = config
        geo = o.ctx
    }

    private func decide(_ fresh: RemoteOverrides?) {
        lock.lock()
        defer { lock.unlock() }
        guard pending else { return }
        if let f = fresh {
            applyFresh(f)
            context = buildContext()
        }
        pending = false
        let exposures = waiting
        waiting = []
        for w in exposures { sendExposure(w.exp, ts: w.ts) }
        let later = deferred
        deferred = []
        later.forEach { $0() }
        bumpRevision()
    }

    private func propertyArrived() {
        lock.lock()
        defer { lock.unlock() }
        guard propertyFetching else { return }
        propertyFetching = false
        if let w = wanted, !knownProperty() {
            warn("property \"\(w)\" is not in this project, so no screens or events are sent. Check the id (it looks like sh-x1h78w).")
        }
        let sends = propertyWaiting
        propertyWaiting = []
        sends.forEach { $0() }
    }

    private func fetchOverrides(deciding: Bool) {
        guard let url = overridesURL else {
            if deciding { decide(nil) }
            return
        }
        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let self = self else { return }
            var fresh: RemoteOverrides?
            if let http = response as? HTTPURLResponse, http.statusCode == 200, let data = data, let o = RemoteOverrides.decode(data) {
                fresh = o
                self.writeCache(data)
            }
            self.lock.lock()
            if let f = fresh { self.propConfig = Overrides.apply(Config(), f) }
            self.lock.unlock()
            if deciding { self.decide(fresh) }
            self.propertyArrived()
        }.resume()
    }

    private var cacheKey: String { "sh_remote:\(publicKey)" }
    private var cacheTimeKey: String { "sh_remote_at:\(publicKey)" }

    private func readCache() -> (overrides: RemoteOverrides, fetchedAt: Double)? {
        guard let data = defaults.data(forKey: cacheKey), let o = RemoteOverrides.decode(data) else { return nil }
        return (o, defaults.double(forKey: cacheTimeKey))
    }

    private func writeCache(_ data: Data) {
        defaults.set(data, forKey: cacheKey)
        defaults.set(nowMs(), forKey: cacheTimeKey)
    }

    private func buildContext() -> TargetingContext {
        var c = TargetingContext()
        c.country = geo?.country
        c.region = geo?.region
        c.city = geo?.city
        c.platform = app?.platform
        c.os = app?.platform
        c.device = app?.device
        c.appVersion = app?.version
        c.language = Locale.preferredLanguages.first
        // The device's own zone beats the one guessed from the IP.
        c.timezone = TimeZone.current.identifier
        c.visitor = newVisitor ? "new" : "returning"
        return c.merged(with: options.context)
    }

    // MARK: - Sending

    private func push(_ event: WireEvent) {
        if options.logging {
            let type = event.type
            let detail: String = event.exp ?? event.goal ?? event.name ?? event.url ?? ""
            log.debug("\(type, privacy: .public) \(detail, privacy: .public)")
        }
        queue?.push(event)
    }

    private func event(_ prefix: String, _ type: String, ts: Int64) -> WireEvent {
        return WireEvent(id: IDs.new(prefix), type: type, vid: visitor, sid: session, ts: ts)
    }

    private func sendExposure(_ experiment: String, ts: Int64) {
        let a = Engine.assign(config, experiment, visitor, overrides: options.force, context: context)
        if config.holdout != nil && Engine.countsForHoldout(a) { markHoldout(ts: ts) }
        guard let v = a.variant, a.reason != .override else { return }
        let dedup = "\(experiment):\(v.key)"
        guard !exposed.contains(dedup) else { return }
        exposed.insert(dedup)
        var e = event("e_", "exposure", ts: ts)
        e.exp = experiment
        e.variant = v.key
        e.url = currentURL
        push(e)
    }

    /// One `__holdout` exposure per session, the first time the user reaches a running experiment.
    private func markHoldout(ts: Int64) {
        guard let group = Engine.holdoutGroup(config, visitor) else { return }
        let dedup = "\(Engine.holdoutKey):\(group)"
        guard !exposed.contains(dedup) else { return }
        exposed.insert(dedup)
        var e = event("e_", "exposure", ts: ts)
        e.exp = Engine.holdoutKey
        e.variant = group
        e.url = currentURL
        push(e)
    }

    /// The cloud refuses a project with nothing running, so goals then stay on the device.
    private func cloudIdle() -> Bool {
        return !config.experiments.contains { $0.status == "running" } && !propConfig.properties.contains { $0.status == "running" }
    }

    private func sendGoal(_ name: String, _ props: [String: JSONValue]?, _ ts: Int64) {
        guard let goal = Keys.goalKey(config.goals, name) else { return }
        if cloudIdle() { return }
        var e = event("g_", "goal", ts: ts)
        e.goal = goal
        e.url = currentURL
        e.props = props
        push(e)
    }

    private func sendPageGoals(_ path: String, _ ts: Int64) {
        for g in config.goals where g.type == "pageview" {
            if let p = g.path, Keys.matchPath(p, path) { sendGoal(g.key, nil, ts) }
        }
    }

    private func knownProperty() -> Bool {
        guard let w = wanted else { return false }
        return propConfig.properties.contains { $0.key == w }
    }

    private func runningProperty() -> String? {
        guard let w = wanted else { return nil }
        return propConfig.properties.first { $0.key == w && $0.status == "running" }?.key
    }

    /// Runs `send` now, or once overrides that may declare the property have arrived (at most 5 s).
    private func withProperty(_ send: @escaping () -> Void) {
        guard wanted != nil else { return }
        if !knownProperty() && propertyFetching {
            propertyWaiting.append(send)
            return
        }
        send()
    }

    /// With a running property one `event` row (the cloud turns it into goal conversions); otherwise the goal row.
    private func sendTracked(_ name: String, _ props: [String: JSONValue]?, _ ts: Int64) {
        guard wanted != nil else {
            sendGoal(name, props, ts)
            return
        }
        guard Keys.isEventName(name) else {
            warn("event name \"\(name)\" is invalid: letters, digits, spaces and \"_ . : / -\", up to 64 characters.")
            sendGoal(name, props, ts)
            return
        }
        let url = currentURL
        withProperty { [weak self] in
            guard let self = self else { return }
            guard let prop = self.runningProperty() else {
                self.sendGoal(name, props, ts)
                return
            }
            var e = self.event("v_", "event", ts: ts)
            e.prop = prop
            e.name = name
            e.url = url
            e.props = props
            self.push(e)
        }
    }

    private func sendPage(_ path: String, title: String, ts: Int64) {
        currentURL = path
        currentTitle = title
        guard wanted != nil else {
            sendPageGoals(path, ts)
            return
        }
        withProperty { [weak self] in
            guard let self = self else { return }
            guard let prop = self.runningProperty() else {
                self.sendPageGoals(path, ts)
                return
            }
            // `.onAppear` can fire twice for one screen; one view per screen per second is kept.
            if let last = self.lastPage, last.url == path, ts - last.ts < 1000 { return }
            self.lastPage = (url: path, ts: ts)
            _ = self.emitEngage(final: true)
            var e = self.event("p_", "page", ts: ts)
            e.prop = prop
            e.url = path
            e.title = title
            self.push(e)
            self.screenTime = ScreenTime(prop: prop, url: path, ms: 0, since: self.backgroundSince == nil ? Date() : nil)
            self.resendIdentity(ts: ts)
        }
    }

    /// Time on the current screen as an `engage` row; `final` closes the screen. Apps have no scroll depth: 0.
    private func emitEngage(final: Bool) -> Bool {
        guard var s = screenTime else { return false }
        let now = Date()
        let total = s.ms + (s.since.map { now.timeIntervalSince($0) * 1000 } ?? 0)
        let ms = Int(min(Double(Self.maxEngageMs), total.rounded()))
        s.ms = 0
        s.since = (!final && backgroundSince == nil) ? now : nil
        screenTime = final ? nil : s
        guard ms > 0 else { return false }
        var e = event("n_", "engage", ts: Int64(now.timeIntervalSince1970 * 1000))
        e.prop = s.prop
        e.url = s.url
        e.ms = ms
        e.scroll = 0
        push(e)
        return true
    }

    private func sendIdentify(_ uid: String, _ traits: [String: JSONValue]?, ts: Int64) {
        guard wanted != nil else { return }
        let mark = "\(uid)\n\(traits.flatMap { Self.sortedJSON($0) } ?? "")"
        withProperty { [weak self] in
            guard let self = self, let prop = self.runningProperty(), self.sentIdentity != mark else { return }
            self.sentIdentity = mark
            var e = self.event("i_", "identify", ts: ts)
            e.prop = prop
            e.uid = uid
            e.traits = traits
            self.push(e)
        }
    }

    /// A known user's id goes out once in each new session, with its first screen.
    private func resendIdentity(ts: Int64) {
        guard let uid = defaults.string(forKey: Self.uidKey), !uid.isEmpty else { return }
        if !(sentIdentity ?? "").hasPrefix("\(uid)\n") { sendIdentify(uid, nil, ts: ts) }
    }

    // MARK: - Lifecycle

    private func observeLifecycle() {
        let center = NotificationCenter.default
        #if os(iOS) || os(tvOS)
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.wentToBackground()
        })
        observers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.cameToForeground()
        })
        observers.append(center.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            self?.queue?.save()
        })
        #elseif os(macOS)
        observers.append(center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.wentToBackground()
        })
        observers.append(center.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.cameToForeground()
        })
        observers.append(center.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            self?.queue?.save()
        })
        #endif
    }

    private func wentToBackground() {
        lock.lock()
        guard started, backgroundSince == nil else {
            lock.unlock()
            return
        }
        backgroundSince = Date()
        _ = emitEngage(final: false)
        let q = queue
        lock.unlock()
        q?.save()
        #if os(iOS) || os(tvOS)
        Task { @MainActor in BackgroundFlush.run(q) }
        #else
        q?.flush(force: true)
        #endif
    }

    private func cameToForeground() {
        lock.lock()
        defer { lock.unlock() }
        guard started, let since = backgroundSince else { return }
        backgroundSince = nil
        if Date().timeIntervalSince(since) >= Self.sessionTimeout {
            rotateSession()
        } else {
            screenTime?.since = Date()
            let fetchedAt = defaults.double(forKey: cacheTimeKey)
            if !options.disabled && nowMs() - fetchedAt > Self.remoteTTLMs { fetchOverrides(deciding: false) }
        }
    }

    /// Back after 30 minutes away: a new session, with the latest experiments from the dashboard.
    private func rotateSession() {
        session = IDs.new("s_")
        exposed.removeAll()
        sentIdentity = nil
        lastPage = nil
        screenTime = nil
        if let c = readCache() {
            applyFresh(c.overrides)
            context = buildContext()
        }
        bumpRevision()
        if !options.disabled { fetchOverrides(deciding: false) }
        // The new session opens on the screen the user is looking at.
        if let url = currentURL { sendPage(url, title: currentTitle ?? url, ts: nowTs()) }
    }

    private func bumpRevision() {
        DispatchQueue.main.async { [weak self] in self?.revision += 1 }
    }

    // MARK: - Helpers

    private func nowTs() -> Int64 {
        return Int64(nowMs())
    }

    private func warn(_ message: String) {
        guard !warned.contains(message) else { return }
        warned.insert(message)
        log.warning("[splithub] \(message, privacy: .public)")
    }

    static func queueFile() -> URL? {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        let folder = Bundle.main.bundleIdentifier ?? "app"
        return base.appendingPathComponent(folder, isDirectory: true)
            .appendingPathComponent("SplitHub", isDirectory: true)
            .appendingPathComponent("sh_queue.json")
    }

    static func sortedJSON(_ value: [String: JSONValue]) -> String? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(value) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func encodedSize(_ value: [String: JSONValue]) -> Int {
        return (try? JSONEncoder().encode(value))?.count ?? Int.max
    }

    /// Props as the ingest takes them: at most 4 KB of JSON. Larger ones keep `revenue` and the plain values that fit.
    func fitProps(_ props: [String: JSONValue]?, what: String) -> [String: JSONValue]? {
        guard let props = props, !props.isEmpty else { return nil }
        if Self.encodedSize(props) <= Self.maxPropsBytes { return props }
        var out: [String: JSONValue] = [:]
        var size = 2
        let keys = props.keys.filter { $0 == "revenue" } + props.keys.filter { $0 != "revenue" }.sorted()
        for key in keys {
            guard let value = props[key] else { continue }
            switch value {
            case .object, .array:
                continue
            default:
                break
            }
            let part = Self.encodedSize([key: value]) - 1
            if size + part > Self.maxPropsBytes { continue }
            out[key] = value
            size += part
        }
        warn("\(what): props are larger than 4 KB, so \(out.isEmpty ? "none went out" : "only \(out.keys.sorted().joined(separator: ", ")) went out").")
        return out.isEmpty ? nil : out
    }

    /// Flat traits (text, numbers, true/false) up to 4 KB; anything else is left out.
    func cleanTraits(_ traits: [String: JSONValue]?) -> [String: JSONValue]? {
        guard let traits = traits else { return nil }
        var out: [String: JSONValue] = [:]
        var size = 2
        var skipped = false
        for key in traits.keys.sorted() {
            guard let value = traits[key] else { continue }
            var plain: JSONValue?
            switch value {
            case .string(let s): plain = .string(String(s.prefix(256)))
            case .bool: plain = value
            case .number(let n): plain = n.isFinite ? value : nil
            default: plain = nil
            }
            guard let v = plain, key.count <= 64 else {
                skipped = true
                continue
            }
            let part = Self.encodedSize([key: v]) - 1
            if size + part > Self.maxPropsBytes {
                skipped = true
                continue
            }
            out[key] = v
            size += part
        }
        if skipped { warn("identify(): traits keep text, numbers and true/false up to 4 KB; the rest was left out.") }
        return out.isEmpty ? nil : out
    }
}

#if os(iOS) || os(tvOS)
/// Keeps the app awake for the few seconds a flush takes after it goes to the background.
enum BackgroundFlush {
    @MainActor
    static func run(_ queue: EventQueue?) {
        guard let queue = queue else { return }
        let app = UIApplication.shared
        var task: UIBackgroundTaskIdentifier = .invalid
        let end: () -> Void = {
            if task != .invalid {
                app.endBackgroundTask(task)
                task = .invalid
            }
        }
        task = app.beginBackgroundTask(withName: "SplitHub flush") { end() }
        queue.flush(force: true) {
            Task { @MainActor in end() }
        }
    }
}
#endif
