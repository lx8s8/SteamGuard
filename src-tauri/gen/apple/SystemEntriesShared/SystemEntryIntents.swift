import Foundation
#if canImport(AppIntents)
import AppIntents
#endif

struct EntryItem: Codable, Identifiable { let id: String; let label: String }
struct EntrySnapshot: Codable { let enabled: Bool; let entries: [EntryItem] }
enum EntryMetadata {
    static let snapshotKey = "steamguard.system-entry.snapshot.v1"
    static let pendingKey = "steamguard.system-entry.pending.v1"
    static var groupDefaults: UserDefaults? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "SteamGuardAppGroup") as? String,
              group.hasPrefix("group."), group.count <= 200,
              FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) != nil else { return nil }
        return UserDefaults(suiteName: group)
    }
    static func snapshot() -> EntrySnapshot {
        let source = Bundle.main.bundleURL.pathExtension == "appex" ? groupDefaults : UserDefaults.standard
        guard let data = source?.data(forKey: snapshotKey), data.count <= 8192,
              let snapshot = try? JSONDecoder().decode(EntrySnapshot.self, from: data), snapshot.enabled else { return .init(enabled: false, entries: []) }
        return .init(enabled: true, entries: Array(snapshot.entries.filter { UUID(uuidString: $0.id) != nil && !$0.label.isEmpty && $0.label.count <= 80 }.prefix(4)))
    }
    static func url(id: String? = nil, copy: Bool = false) -> URL {
        var parts = URLComponents(); parts.scheme = "steamguard"; parts.host = "entry"; parts.path = copy ? "/copy" : "/open"
        if let id = id { parts.queryItems = [.init(name: "id", value: id)] }
        return parts.url!
    }
    static func enqueue(id: String? = nil, copy: Bool = false) {
        let value: [String: Any] = ["uri": url(id: id, copy: copy).absoluteString, "created": Date().timeIntervalSince1970]
        UserDefaults.standard.set(value, forKey: pendingKey)
        groupDefaults?.set(value, forKey: pendingKey)
    }
}

#if canImport(AppIntents)
@available(iOS 16.0, *)
struct TokenEntryEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Token"
    static var defaultQuery = TokenEntryQuery()
    let id: String
    let label: String
    var displayRepresentation: DisplayRepresentation { .init(title: "\(label)") }
}
@available(iOS 16.0, *)
struct TokenEntryQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [TokenEntryEntity] {
        (try await suggestedEntities()).filter { identifiers.contains($0.id) }
    }
    func suggestedEntities() async throws -> [TokenEntryEntity] {
        EntryMetadata.snapshot().entries.map { .init(id: $0.id, label: $0.label) }
    }
}
@available(iOS 16.0, *)
struct OpenTokensIntent: AppIntent {
    static var title: LocalizedStringResource = "Open app"
    static var openAppWhenRun: Bool = true
    func perform() async throws -> some IntentResult { EntryMetadata.enqueue(); return .result() }
}
@available(iOS 16.0, *)
struct SelectTokenIntent: AppIntent {
    static var title: LocalizedStringResource = "Copy"
    static var openAppWhenRun: Bool = true
    @Parameter(title: "Token") var token: TokenEntryEntity
    func perform() async throws -> some IntentResult {
        guard EntryMetadata.snapshot().entries.contains(where: { $0.id == token.id }) else { throw EntryError.unavailable }
        // Focus the requested token. The user still confirms Copy in the app;
        // neither Shortcuts nor an external URL can silently copy an OTP.
        EntryMetadata.enqueue(id: token.id, copy: true)
        return .result()
    }
}
@available(iOS 16.0, *)
enum EntryError: Error { case unavailable }
@available(iOS 16.0, *)
struct EntryShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: OpenTokensIntent(), phrases: ["Open \(.applicationName)"], shortTitle: "Open app", systemImageName: "number.square")
    }
}
#endif
