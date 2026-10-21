import XCTest
@testable import SplitHub

/// The shared vectors from `packages/core/test/vectors.json` (copied by `scripts/copy-vectors.mjs`):
/// every case must come out exactly as in `@splithub/core`.
final class VectorTests: XCTestCase {
    private struct Vectors: Decodable {
        let format: String
        let murmur3: [HashCase]
        let hashToUnit: [UnitCase]
        let pickVariant: [PickGroup]
        let layerBucket: [LayerCase]
        let holdoutGroup: [HoldoutCase]
        let compareVersions: [VersionCase]
        let conditions: [ConditionCase]
        let assign: AssignSection
    }

    private struct HashCase: Decodable {
        let input: String
        let seed: UInt32
        let expected: UInt32
    }

    private struct UnitCase: Decodable {
        let input: String
        let seed: UInt32
        let expected: Double
    }

    private struct PickGroup: Decodable {
        let experiment: Experiment
        let cases: [PickCase]
    }

    private struct PickCase: Decodable {
        let visitor: String
        let expected: String?
    }

    private struct LayerCase: Decodable {
        let layer: String
        let seed: String
        let visitor: String
        let expected: Int
    }

    private struct HoldoutCase: Decodable {
        let percent: Double
        let seed: String
        let visitor: String
        let expected: String?
    }

    private struct VersionCase: Decodable {
        let a: String
        let b: String
        let expected: Int
    }

    private struct ConditionCase: Decodable {
        let condition: TargetCondition
        let context: TargetingContext
        let expected: Bool
    }

    private struct AssignSection: Decodable {
        let normalized: Config
        let contexts: [TargetingContext]
        let cases: [AssignCase]
    }

    private struct AssignCase: Decodable {
        let experiment: String
        let visitor: String
        let context: Int
        let expected: Expected
    }

    private struct Expected: Decodable {
        let variant: String?
        let reason: String
    }

    private static let vectors: Vectors = {
        guard let url = Bundle.module.url(forResource: "vectors", withExtension: "json") else {
            fatalError("vectors.json is missing: run node sdks/ios/scripts/copy-vectors.mjs")
        }
        do {
            return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
        } catch {
            fatalError("vectors.json does not decode: \(error)")
        }
    }()

    private var v: Vectors { Self.vectors }

    func testFormat() {
        XCTAssertEqual(v.format, "splithub-vectors")
    }

    func testMurmur3() {
        XCTAssertFalse(v.murmur3.isEmpty)
        for c in v.murmur3 {
            XCTAssertEqual(Hash.murmur3(c.input, seed: c.seed), c.expected, "murmur3(\"\(c.input)\", \(c.seed))")
        }
    }

    func testHashToUnit() {
        for c in v.hashToUnit {
            XCTAssertEqual(Hash.unit(c.input, seed: c.seed), c.expected, "hashToUnit(\"\(c.input)\")")
        }
    }

    func testPickVariant() {
        for group in v.pickVariant {
            for c in group.cases {
                XCTAssertEqual(Engine.pickVariant(group.experiment, c.visitor)?.key, c.expected, "\(group.experiment.key) / \(c.visitor)")
            }
        }
    }

    func testLayerBucket() {
        for c in v.layerBucket {
            var config = Config()
            config.layers = [c.layer: LayerSeed(seed: c.seed)]
            XCTAssertEqual(Engine.layerBucket(config, c.layer, c.visitor), c.expected, "\(c.layer) / \(c.visitor)")
        }
    }

    func testHoldoutGroup() {
        for c in v.holdoutGroup {
            var config = Config()
            config.holdout = Holdout(percent: c.percent, seed: c.seed)
            XCTAssertEqual(Engine.holdoutGroup(config, c.visitor), c.expected, "\(c.seed) \(c.percent)% / \(c.visitor)")
        }
    }

    func testCompareVersions() {
        for c in v.compareVersions {
            XCTAssertEqual(Targeting.compareVersions(c.a, c.b), c.expected, "\(c.a) vs \(c.b)")
        }
    }

    func testConditions() {
        for c in v.conditions {
            XCTAssertEqual(Targeting.evaluate(c.condition, c.context), c.expected, "\(c.condition) on \(c.context)")
        }
    }

    func testNormalizedConfigDecodes() {
        let config = v.assign.normalized
        XCTAssertFalse(config.experiments.isEmpty)
        XCTAssertNotNil(config.holdout)
        XCTAssertNotNil(config.experiment("targeted")?.flow)
        XCTAssertEqual(config.experiment("layered")?.layerKey, "checkout")
    }

    func testAssign() {
        let config = v.assign.normalized
        XCTAssertFalse(v.assign.cases.isEmpty)
        for c in v.assign.cases {
            let a = Engine.assign(config, c.experiment, c.visitor, context: v.assign.contexts[c.context])
            let label = "\(c.experiment) / \(c.visitor) / context \(c.context)"
            XCTAssertEqual(a.variant?.key, c.expected.variant, label)
            XCTAssertEqual(a.reason.rawValue, c.expected.reason, label)
        }
    }

    /// Experiments made in the dashboard arrive as `added` overrides: the same config, the same answers.
    func testAssignThroughOverrides() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "vectors", withExtension: "json"))
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let assign = try XCTUnwrap(root["assign"] as? [String: Any])
        let normalized = try XCTUnwrap(assign["normalized"] as? [String: Any])
        let body: [String: Any] = [
            "version": 1,
            "experiments": [String: Any](),
            "added": normalized["experiments"] ?? [Any](),
            "goals": normalized["goals"] ?? [Any](),
            "holdout": normalized["holdout"] ?? NSNull(),
            "layers": normalized["layers"] ?? [String: Any](),
        ]
        let overrides = try XCTUnwrap(RemoteOverrides.decode(JSONSerialization.data(withJSONObject: body)))
        let config = Overrides.apply(Config(), overrides)
        for c in v.assign.cases {
            let a = Engine.assign(config, c.experiment, c.visitor, context: v.assign.contexts[c.context])
            XCTAssertEqual(a.variant?.key, c.expected.variant, "\(c.experiment) / \(c.visitor) / context \(c.context)")
            XCTAssertEqual(a.reason.rawValue, c.expected.reason)
        }
    }
}
