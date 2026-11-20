import XCTest
@testable import SplitHub

final class EndpointsTests: XCTestCase {
    func testOrderSkipsTheLapsedAddressAndEndsWithTheBackup() {
        let list = CloudEndpoints.list(remembered: "https://go.moved.example/v1/events", configured: URL(string: "https://go.splithub.io/v1/events")!)
        XCTAssertEqual(list.map { $0.absoluteString }, ["https://go.moved.example/v1/events", SplitHub.defaultEndpoint.absoluteString] + CloudEndpoints.backups.map { $0.absoluteString })
    }

    func testOnlyHttpsEventsUrlsAreAccepted() {
        XCTAssertNotNil(CloudEndpoints.parse("https://go.sh2.uk/v1/events"))
        XCTAssertNil(CloudEndpoints.parse("http://go.sh2.uk/v1/events"))
        XCTAssertNil(CloudEndpoints.parse("https://go.sh2.uk/other"))
        XCTAssertNil(CloudEndpoints.parse(nil))
    }

    func testCloudAddresses() {
        XCTAssertTrue(CloudEndpoints.isCloud(SplitHub.defaultEndpoint))
        XCTAssertTrue(CloudEndpoints.isCloud(URL(string: "https://go.splithub.io/v1/events")!))
        XCTAssertFalse(CloudEndpoints.isCloud(URL(string: "https://mine.example/v1/events")!))
    }

    func testOverridesCarryTheAnnouncedEndpoint() {
        let data = #"{"version":1,"experiments":{},"endpoint":"https://go.moved.example/v1/events"}"#.data(using: .utf8)!
        XCTAssertEqual(RemoteOverrides.decode(data)?.endpoint, "https://go.moved.example/v1/events")
    }
}
