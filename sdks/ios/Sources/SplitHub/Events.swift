import Foundation

/// One event on the wire, with the field names of `SplitHubEvent` in `@splithub/core`.
/// Nil fields are left out of the JSON.
struct WireEvent: Codable, Equatable {
    var id: String
    /// `exposure`, `goal`, `page`, `event`, `engage` or `identify`.
    var type: String
    var exp: String?
    var variant: String?
    var goal: String?
    var prop: String?
    var name: String?
    var vid: String
    var sid: String
    /// Device time, Unix ms.
    var ts: Int64
    var url: String?
    var title: String?
    var ref: String?
    var props: [String: JSONValue]?
    var uid: String?
    var traits: [String: JSONValue]?
    var ms: Int?
    var scroll: Int?

    enum CodingKeys: String, CodingKey {
        case id, type, exp
        case variant = "var"
        case goal, prop, name, vid, sid, ts, url, title, ref, props, uid, traits, ms, scroll
    }

    init(id: String, type: String, vid: String, sid: String, ts: Int64) {
        self.id = id
        self.type = type
        self.vid = vid
        self.sid = sid
        self.ts = ts
    }
}

struct EventBatch: Encodable {
    let project: String
    let sdk: String
    let events: [WireEvent]
    let app: AppInfo?
}

enum SendResult: Equatable {
    case ok
    /// A 4xx other than 408 / 429: the ingest refuses the batch, retrying cannot help.
    case refused(Int)
    /// 5xx, 408 or 429: worth a few more tries.
    case serverError(Int)
    /// No answer at all (offline, timeout): kept until it goes through.
    case offline
}

protocol Transport {
    func send(_ batch: EventBatch, completion: @escaping (SendResult) -> Void)
}

struct URLSessionTransport: Transport {
    let endpoint: URL
    let key: String
    var session: URLSession = .shared

    func send(_ batch: EventBatch, completion: @escaping (SendResult) -> Void) {
        guard let body = try? JSONEncoder().encode(batch) else {
            completion(.refused(0))
            return
        }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.httpBody = body
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        session.dataTask(with: request) { _, response, _ in
            guard let http = response as? HTTPURLResponse else {
                completion(.offline)
                return
            }
            let status = http.statusCode
            if (200..<300).contains(status) {
                completion(.ok)
            } else if (400..<500).contains(status) && status != 408 && status != 429 {
                completion(.refused(status))
            } else {
                completion(.serverError(status))
            }
        }.resume()
    }
}

/// Batches events and sends them on a timer (2 s) or when 20 are waiting. Kept on disk
/// (at most 1000, the oldest go first), so events made offline or right before the app is
/// killed go out on a later launch. No answer at all is retried with backoff and never uses
/// up attempts; a server error gets 5 tries; a 4xx refusal (but 408 / 429) is dropped.
final class EventQueue {
    struct Settings {
        var maxBatch = 20
        var flushInterval: TimeInterval = 2
        var maxQueue = 1000
        /// Events per request (the ingest takes at most 500).
        var maxSend = 100
        var maxAttempts = 5
    }

    private let project: String
    private let sdk: String
    private let app: AppInfo?
    private let transport: Transport
    private let fileURL: URL?
    private let settings: Settings
    private let lock = NSLock()
    private let io = DispatchQueue(label: "io.splithub.events")

    private var events: [WireEvent] = []
    private var sending = false
    private var timerAt: Date?
    private var backoffUntil: Date?
    private var failures = 0
    private var serverAttempts = 0
    private var writeScheduled = false
    private var completions: [() -> Void] = []

    init(project: String, sdk: String, app: AppInfo?, transport: Transport, fileURL: URL?, settings: Settings = Settings()) {
        self.project = project
        self.sdk = sdk
        self.app = app
        self.transport = transport
        self.fileURL = fileURL
        self.settings = settings
        if let url = fileURL, let data = try? Data(contentsOf: url), let saved = try? JSONDecoder().decode([WireEvent].self, from: data) {
            events = Array(saved.suffix(settings.maxQueue))
        }
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return events.count
    }

    /// Events waiting to be sent, oldest first.
    var snapshot: [WireEvent] {
        lock.lock()
        defer { lock.unlock() }
        return events
    }

    func push(_ event: WireEvent) {
        lock.lock()
        events.append(event)
        if events.count > settings.maxQueue { events.removeFirst(events.count - settings.maxQueue) }
        scheduleWriteLocked()
        let wait = backoffUntil.map { $0.timeIntervalSinceNow } ?? 0
        let full = events.count >= settings.maxBatch
        lock.unlock()
        if wait <= 0 && full {
            flush()
        } else {
            schedule(after: wait > 0 ? wait : settings.flushInterval)
        }
    }

    /// Sends what is waiting. `force` ignores the backoff (the app is going to the background).
    /// `completion` runs once this attempt is over, sent or not.
    func flush(force: Bool = false, completion: (() -> Void)? = nil) {
        lock.lock()
        if let c = completion { completions.append(c) }
        if sending {
            lock.unlock()
            return
        }
        if events.isEmpty {
            let done = takeCompletionsLocked()
            lock.unlock()
            done.forEach { $0() }
            return
        }
        if !force, let until = backoffUntil, until > Date() {
            let done = takeCompletionsLocked()
            lock.unlock()
            done.forEach { $0() }
            schedule(after: until.timeIntervalSinceNow)
            return
        }
        let batch = Array(events.prefix(settings.maxSend))
        sending = true
        lock.unlock()
        transport.send(EventBatch(project: project, sdk: sdk, events: batch, app: app)) { [weak self] result in
            self?.handle(result, batch: batch, force: force)
        }
    }

    /// Writes the queue to disk now (the app is about to be suspended or quit).
    func save() {
        lock.lock()
        let copy = events
        writeScheduled = false
        lock.unlock()
        // On the writer queue, so a delayed write already running cannot land after this one.
        io.sync { self.write(copy) }
    }

    private func handle(_ result: SendResult, batch: [WireEvent], force: Bool) {
        lock.lock()
        sending = false
        let ids = Set(batch.map { $0.id })
        var retryIn: TimeInterval?
        switch result {
        case .ok, .refused:
            events.removeAll { ids.contains($0.id) }
            failures = 0
            serverAttempts = 0
            backoffUntil = nil
        case .serverError:
            serverAttempts += 1
            if serverAttempts >= settings.maxAttempts {
                events.removeAll { ids.contains($0.id) }
                serverAttempts = 0
                failures = 0
                backoffUntil = nil
            } else {
                failures += 1
                retryIn = backoff(failures)
            }
        case .offline:
            failures += 1
            retryIn = backoff(failures)
        }
        if let delay = retryIn { backoffUntil = Date().addingTimeInterval(delay) }
        scheduleWriteLocked()
        let more = retryIn == nil && !events.isEmpty
        let done = more ? [] : takeCompletionsLocked()
        lock.unlock()
        done.forEach { $0() }
        if more {
            flush(force: force)
        } else if let delay = retryIn {
            schedule(after: delay)
        }
    }

    private func backoff(_ n: Int) -> TimeInterval {
        let base = min(30, pow(2, Double(n - 1)))
        return base / 2 + Double.random(in: 0...(base / 2))
    }

    private func takeCompletionsLocked() -> [() -> Void] {
        let done = completions
        completions = []
        return done
    }

    private func schedule(after delay: TimeInterval) {
        let fire = Date().addingTimeInterval(max(0, delay))
        lock.lock()
        if let at = timerAt, at <= fire {
            lock.unlock()
            return
        }
        timerAt = fire
        lock.unlock()
        io.asyncAfter(deadline: .now() + max(0, delay)) { [weak self] in
            guard let self = self else { return }
            self.lock.lock()
            if self.timerAt == fire { self.timerAt = nil }
            self.lock.unlock()
            self.flush()
        }
    }

    private func scheduleWriteLocked() {
        guard fileURL != nil, !writeScheduled else { return }
        writeScheduled = true
        io.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self = self else { return }
            self.lock.lock()
            guard self.writeScheduled else {
                self.lock.unlock()
                return
            }
            self.writeScheduled = false
            let copy = self.events
            self.lock.unlock()
            self.write(copy)
        }
    }

    private func write(_ events: [WireEvent]) {
        guard let url = fileURL else { return }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(events)
            try data.write(to: url, options: [.atomic])
        } catch {
            // Disk full or no access: the events stay in memory for this launch.
        }
    }
}
