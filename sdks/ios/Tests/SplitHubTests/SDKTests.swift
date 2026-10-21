import XCTest
@testable import SplitHub

final class WireFormatTests: XCTestCase {
    private func json(_ value: Encodable) throws -> [String: Any] {
        let data = try JSONEncoder().encode(AnyEncodable(value))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testExposureFieldNames() throws {
        var e = WireEvent(id: IDs.new("e_"), type: "exposure", vid: "v_1", sid: "s_1", ts: 1_791_819_000_000)
        e.exp = "hero"
        e.variant = "bold"
        let o = try json(e)
        XCTAssertEqual(Set(o.keys), ["id", "type", "exp", "var", "vid", "sid", "ts"])
        XCTAssertEqual(o["var"] as? String, "bold")
        XCTAssertEqual(o["ts"] as? Int64, 1_791_819_000_000)
    }

    func testEngageAndIdentifyFields() throws {
        var engage = WireEvent(id: IDs.new("n_"), type: "engage", vid: "v", sid: "s", ts: 1)
        engage.prop = "sh-abc123"
        engage.url = "/Settings"
        engage.ms = 1200
        engage.scroll = 0
        XCTAssertEqual(Set(try json(engage).keys), ["id", "type", "prop", "vid", "sid", "ts", "url", "ms", "scroll"])

        var identify = WireEvent(id: IDs.new("i_"), type: "identify", vid: "v", sid: "s", ts: 1)
        identify.prop = "sh-abc123"
        identify.uid = "user-1"
        identify.traits = ["plan": "pro", "seats": 3]
        let o = try json(identify)
        XCTAssertEqual(o["uid"] as? String, "user-1")
        XCTAssertEqual((o["traits"] as? [String: Any])?["seats"] as? Int, 3)
    }

    func testBatchCarriesApp() throws {
        let app = AppInfo(platform: "ios", id: "com.acme.shop", version: "2.4.1", build: "412", os: "18.1", model: "iPhone15,2", device: "mobile")
        let batch = EventBatch(project: "app", sdk: "ios/\(SplitHub.version)", events: [], app: app)
        let o = try json(batch)
        XCTAssertEqual(o["sdk"] as? String, "ios/\(SplitHub.version)")
        let a = try XCTUnwrap(o["app"] as? [String: Any])
        XCTAssertEqual(a["platform"] as? String, "ios")
        XCTAssertEqual(a["id"] as? String, "com.acme.shop")
        XCTAssertEqual(a["device"] as? String, "mobile")
    }

    /// `/^[a-z0-9_-]{8,64}$/i`, the ingest's id rule.
    func testIdsPassTheIngestRule() {
        for prefix in ["e_", "g_", "p_", "v_", "n_", "i_", "s_"] {
            let id = IDs.new(prefix)
            XCTAssertTrue(Keys.fullMatch("[A-Za-z0-9_-]{8,64}", id), id)
            XCTAssertEqual(id.count, prefix.count + 20)
        }
    }

    func testJSONValueRoundTrip() {
        let v: JSONValue = ["n": 9, "f": 1.5, "s": "x", "b": true, "a": [1, 2], "z": nil]
        XCTAssertEqual(v["n"]?.decode(Int.self), 9)
        XCTAssertEqual(v["f"]?.decode(Double.self), 1.5)
        XCTAssertEqual(v["a"]?.decode([Int].self), [1, 2])
        XCTAssertEqual(JSONValue.string("Old").decode(String.self), "Old")
    }
}

final class ConfigTests: XCTestCase {
    func testEventKey() {
        XCTAssertEqual(Keys.eventKey("Video Played"), "video-played")
        XCTAssertEqual(Keys.eventKey("signup"), "signup")
        XCTAssertEqual(Keys.eventKey("  --Hello, World!  "), "hello-world")
        XCTAssertEqual(Keys.goalKey([], "Video Played"), "video-played")
        XCTAssertEqual(Keys.goalKey([Goal(key: "watch", event: "Video Played")], "Video Played"), "watch")
        XCTAssertNil(Keys.goalKey([], "!!!"))
    }

    func testEventNames() {
        XCTAssertTrue(Keys.isEventName("Video Played"))
        XCTAssertTrue(Keys.isEventName("checkout:step/2"))
        XCTAssertFalse(Keys.isEventName(" leading space"))
        XCTAssertFalse(Keys.isEventName("line\nbreak"))
    }

    func testOverridesURL() {
        XCTAssertEqual(Keys.overridesURL("https://go.splithub.io/v1/events", "pk_abc")?.absoluteString, "https://go.splithub.io/v1/overrides/pk_abc.json?all=1")
        XCTAssertEqual(Keys.overridesURL("https://staging.splithub.io/v1/events/", "pk_abc")?.absoluteString, "https://staging.splithub.io/v1/overrides/pk_abc.json?all=1")
    }

    func testMatchPath() {
        XCTAssertTrue(Keys.matchPath("/Settings/", "/Settings"))
        XCTAssertTrue(Keys.matchPath("/product/*", "/product/42"))
        XCTAssertFalse(Keys.matchPath("/product", "/products"))
    }

    private let overridesJSON = """
    {
      "version": 3,
      "experiments": { "hero": { "weights": { "control": 1, "bold": 3 }, "traffic": 0.5 }, "price": { "values": { "cheaper": 5 } }, "bad": 7 },
      "added": [
        { "key": "hero", "kind": "component", "status": "running", "traffic": 1, "goal": "signup", "seed": "hero", "variants": [{ "key": "control", "weight": 0.5 }, { "key": "bold", "weight": 0.5 }] },
        { "key": "price", "kind": "value", "status": "running", "traffic": 1, "seed": "price", "variants": [{ "key": "control", "weight": 0.5, "value": 9 }, { "key": "cheaper", "weight": 0.5, "value": 7 }] },
        { "key": "lonely", "kind": "component", "status": "running", "variants": [{ "key": "control", "weight": 1 }] },
        { "nokey": true }
      ],
      "goals": [{ "key": "signup", "type": "event" }],
      "properties": { "sh-app123": { "status": "paused" } },
      "addedProperties": [{ "key": "sh-app123", "status": "running", "kind": "app" }],
      "holdout": { "percent": 10, "seed": "h" },
      "layers": { "checkout": { "seed": "c2" } },
      "ctx": { "country": "DE", "city": "Berlin" }
    }
    """

    func testApplyOverrides() throws {
        let o = try XCTUnwrap(RemoteOverrides.decode(Data(overridesJSON.utf8)))
        XCTAssertEqual(o.ctx?.country, "DE")
        let config = Overrides.apply(Config(), o)
        XCTAssertEqual(config.experiments.map { $0.key }, ["hero", "price"])
        let hero = try XCTUnwrap(config.experiment("hero"))
        XCTAssertEqual(hero.traffic, 0.5)
        XCTAssertEqual(hero.variants.map { $0.weight }, [0.25, 0.75])
        XCTAssertEqual(config.experiment("price")?.variants[1].value, .number(5))
        XCTAssertEqual(config.properties.first?.status, "paused")
        XCTAssertEqual(config.holdout?.seed, "h")
        XCTAssertEqual(config.layers?["checkout"]?.seed, "c2")
        XCTAssertEqual(config.goals.map { $0.key }, ["signup"])
    }

    func testOverridesNeedVersionAndExperiments() {
        XCTAssertNil(RemoteOverrides.decode(Data("{\"experiments\":{}}".utf8)))
        XCTAssertNil(RemoteOverrides.decode(Data("{\"version\":1}".utf8)))
        XCTAssertNotNil(RemoteOverrides.decode(Data("{\"version\":1,\"experiments\":{}}".utf8)))
    }
}

final class EventQueueTests: XCTestCase {
    private final class FakeTransport: Transport {
        var results: [SendResult]
        var batches: [EventBatch] = []
        init(_ results: [SendResult]) { self.results = results }
        func send(_ batch: EventBatch, completion: @escaping (SendResult) -> Void) {
            batches.append(batch)
            completion(results.isEmpty ? .ok : results.removeFirst())
        }
    }

    private func event(_ n: Int) -> WireEvent {
        var e = WireEvent(id: "g_\(String(format: "%020ld", n))", type: "goal", vid: "v", sid: "s", ts: Int64(n))
        e.goal = "signup"
        return e
    }

    private func queue(_ transport: Transport, file: URL? = nil) -> EventQueue {
        var s = EventQueue.Settings()
        s.flushInterval = 60
        s.maxBatch = 1000
        return EventQueue(project: "app", sdk: "ios/test", app: nil, transport: transport, fileURL: file, settings: s)
    }

    func testSendsAndEmpties() {
        let t = FakeTransport([.ok])
        let q = queue(t)
        q.push(event(1))
        q.push(event(2))
        q.flush(force: true)
        XCTAssertEqual(t.batches.count, 1)
        XCTAssertEqual(t.batches.first?.events.count, 2)
        XCTAssertEqual(q.count, 0)
    }

    func testOfflineKeepsEvents() {
        let t = FakeTransport([.offline, .offline, .offline, .offline, .offline, .offline])
        let q = queue(t)
        q.push(event(1))
        for _ in 0..<6 { q.flush(force: true) }
        XCTAssertEqual(q.count, 1)
    }

    func testRefusedDrops() {
        let t = FakeTransport([.refused(400)])
        let q = queue(t)
        q.push(event(1))
        q.flush(force: true)
        XCTAssertEqual(q.count, 0)
    }

    func testServerErrorsDropAfterFiveTries() {
        let t = FakeTransport(Array(repeating: .serverError(503), count: 5))
        let q = queue(t)
        q.push(event(1))
        for _ in 0..<4 { q.flush(force: true) }
        XCTAssertEqual(q.count, 1)
        q.flush(force: true)
        XCTAssertEqual(q.count, 0)
    }

    func testPersistsAcrossLaunches() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("sh_queue_\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: file) }
        let first = queue(FakeTransport([.offline]), file: file)
        first.push(event(1))
        first.push(event(2))
        first.save()
        let second = queue(FakeTransport([]), file: file)
        XCTAssertEqual(second.snapshot.map { $0.id }, [event(1).id, event(2).id])
    }
}

/// Encodes any `Encodable` existential (JSONEncoder needs a concrete type).
private struct AnyEncodable: Encodable {
    let value: Encodable
    init(_ value: Encodable) { self.value = value }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}
