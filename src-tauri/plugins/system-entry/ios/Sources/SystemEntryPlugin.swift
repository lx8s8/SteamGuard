import Foundation
import Tauri
import WidgetKit

private struct Entry: Codable { let id: String; let label: String }
private struct Snapshot: Codable { let enabled: Bool; let entries: [Entry] }
final class SystemEntryPlugin: Plugin {
    private let snapshotKey = "steamguard.system-entry.snapshot.v1"
    private let pendingKey = "steamguard.system-entry.pending.v1"
    private var shared: UserDefaults? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "SteamGuardAppGroup") as? String,
              group.hasPrefix("group."), group.count <= 200,
              FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) != nil else { return nil }
        return UserDefaults(suiteName: group)
    }
    @objc func availability(_ invoke: Invoke) {
        invoke.resolve(["supported": true, "sharedAvailable": shared != nil])
    }
    @objc func publish(_ invoke: Invoke) throws {
        let value = try invoke.parseArgs(Snapshot.self)
        guard value.entries.count <= 4, value.entries.allSatisfy({ UUID(uuidString: $0.id) != nil && $0.label.count <= 80 && !$0.label.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) }) else { invoke.reject("快捷入口数据无效"); return }
        let safe = Snapshot(enabled: value.enabled, entries: value.enabled ? value.entries : [])
        let data = try JSONEncoder().encode(safe)
        UserDefaults.standard.set(data, forKey: snapshotKey)
        shared?.set(data, forKey: snapshotKey)
        WidgetCenter.shared.reloadAllTimelines()
        invoke.resolve()
    }
    @objc func take(_ invoke: Invoke) {
        // AppIntents run in the host app process and write only an action URL.
        // Taking it clears both stores so an old system request cannot replay.
        let dictionaries = [UserDefaults.standard, shared].compactMap { $0 }
        let values = dictionaries.compactMap { $0.dictionary(forKey: pendingKey) }
        dictionaries.forEach { $0.removeObject(forKey: pendingKey) }
        let latest = values.max { ($0["created"] as? TimeInterval ?? 0) < ($1["created"] as? TimeInterval ?? 0) }
        let age = Date().timeIntervalSince1970 - (latest?["created"] as? TimeInterval ?? 0)
        if age >= 0 && age < 120, let uri = latest?["uri"] as? String, uri.count <= 1024 {
            invoke.resolve(["uri": uri])
        } else { invoke.resolve(["uri": NSNull()]) }
    }
}
@_cdecl("init_plugin_system_entry")
func initPlugin() -> Plugin { SystemEntryPlugin() }
