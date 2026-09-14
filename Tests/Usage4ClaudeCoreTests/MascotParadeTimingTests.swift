import XCTest
@testable import Usage4ClaudeCore

/// Die Parade richtet sich seit 2.8 nach den Konten: Art je Anbieter,
/// höchstens ein Läufer je Konto gleichzeitig.
final class MascotParadeTimingTests: XCTestCase {

    // MARK: - Besetzung

    func testOnlyClaudeAccountsSendOnlyClaudies() {
        let roster = MascotRoster(claudeCount: 3, codexCount: 0)
        XCTAssertTrue((0..<50).allSatisfy { roster.species(for: $0) == .claudie })
    }

    func testOnlyCodexAccountsSendOnlyCodexPets() {
        let roster = MascotRoster(claudeCount: 0, codexCount: 3)
        XCTAssertTrue((0..<50).allSatisfy { roster.species(for: $0) == .codex })
        XCTAssertTrue((-50..<0).allSatisfy { roster.species(for: $0) == .codex })
    }

    /// 4 Claude + 3 Codex: je Zyklus genau drei Codex-Pets, und nie zwei
    /// Codex-Pets hintereinander (gleichmäßig verteilt statt geblockt).
    func testMixedRosterKeepsExactShareAndInterleaves() {
        let roster = MascotRoster(claudeCount: 4, codexCount: 3)
        let cycle = (0..<7).map { roster.species(for: $0) }
        XCTAssertEqual(cycle.filter { $0 == .codex }.count, 3)
        for i in 0..<6 {
            XCTAssertFalse(cycle[i] == .codex && cycle[i + 1] == .codex, "zwei Codex-Pets nebeneinander bei \(i)")
        }
        // Negative Nummern (die Parade schaut auch rückwärts) verhalten sich gleich
        let negativeCycle = (-7..<0).map { roster.species(for: $0) }
        XCTAssertEqual(negativeCycle.filter { $0 == .codex }.count, 3)
    }

    func testEmptyRosterFallsBackToOneClaudie() {
        let roster = MascotRoster(claudeCount: 0, codexCount: 0)
        XCTAssertEqual(roster.walkerCap, 1)
        XCTAssertEqual(roster.species(for: 12), .claudie)
    }

    // MARK: - Taktung

    /// Die Grundtaktung entspricht der alten Parade.
    func testBaseTimingMatchesLegacyConstants() {
        XCTAssertEqual(MascotParadeTiming.base.interval, 3.6)
        XCTAssertEqual(MascotParadeTiming.base.minInterval, 3.0)
    }

    /// Ein Konto auf einem 1000-pt-Streifen: höchstens ein Läufer gleichzeitig.
    func testSingleAccountAllowsOnlyOneWalkerAtATime() {
        let timing = MascotParadeTiming.capped(walkers: 1, width: 1000, speed: 26, overshoot: 36)
        let simultaneous = timing.simultaneousWalkers(width: 1000, speed: 26, overshoot: 36)
        XCTAssertEqual(simultaneous, 1, accuracy: 1e-9)
        XCTAssertGreaterThan(timing.interval, 40)
    }

    /// Viele Konten: die Obergrenze greift nicht, es bleibt bei der dichten Grundtaktung.
    func testManyAccountsKeepBaseTiming() {
        let timing = MascotParadeTiming.capped(walkers: 40, width: 400, speed: 26, overshoot: 36)
        XCTAssertEqual(timing, .base)
    }

    /// Die Obergrenze hält für jede Breite und jede Kontenzahl.
    func testCapHoldsAcrossWidthsAndCounts() {
        for width in [300.0, 396.0, 778.0, 1160.0, 2200.0] {
            for count in 1...9 {
                let timing = MascotParadeTiming.capped(walkers: count, width: width, speed: 26, overshoot: 36)
                let simultaneous = timing.simultaneousWalkers(width: width, speed: 26, overshoot: 36)
                XCTAssertLessThanOrEqual(simultaneous, Double(count) + 1e-9, "width \(width), count \(count)")
            }
        }
    }

    /// Startlücken unterschreiten nie `minInterval` — auch bei gestreckter Taktung.
    func testSpawnGapsNeverBelowMinimum() {
        for timing in [MascotParadeTiming.base, MascotParadeTiming(scale: 2.5), MascotParadeTiming(scale: 13)] {
            for index in 0..<5000 {
                let gap = timing.spawnTime(index + 1) - timing.spawnTime(index)
                XCTAssertGreaterThanOrEqual(gap, timing.minInterval - 1e-9, "scale \(timing.interval / 3.6), index \(index)")
                XCTAssertLessThanOrEqual(gap, 2 * timing.interval - timing.minInterval + 1e-9)
            }
        }
    }

    /// Die Stauchung nach unten ist gesperrt: Faktor < 1 wird zu 1.
    func testScaleNeverBelowOne() {
        XCTAssertEqual(MascotParadeTiming(scale: 0.2), .base)
        XCTAssertEqual(MascotParadeTiming(scale: .nan), .base)
    }

    /// Der Zufall ist stabil: dieselbe Nummer würfelt immer dasselbe.
    func testRollIsDeterministicAndInUnitRange() {
        for index in [-3, 0, 1, 42, 1_000_003] {
            let a = MascotRandom.roll(index, 7)
            let b = MascotRandom.roll(index, 7)
            XCTAssertEqual(a, b)
            XCTAssertGreaterThanOrEqual(a, 0)
            XCTAssertLessThan(a, 1)
        }
    }
}
