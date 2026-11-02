import SwiftUI
import WidgetKit

private struct TokenTimeline: TimelineEntry { let date: Date; let snapshot: EntrySnapshot }
private struct TokenProvider: TimelineProvider {
    func placeholder(in context: Context) -> TokenTimeline { .init(date: Date(), snapshot: .init(enabled: false, entries: [])) }
    func getSnapshot(in context: Context, completion: @escaping (TokenTimeline) -> Void) { completion(.init(date: Date(), snapshot: EntryMetadata.snapshot())) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<TokenTimeline>) -> Void) {
        completion(Timeline(entries: [.init(date: Date(), snapshot: EntryMetadata.snapshot())], policy: .never))
    }
}
private struct TokenWidgetView: View {
    var entry: TokenTimeline
    @Environment(\.widgetFamily) private var family
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("SteamGuard", systemImage: "checkmark.circle.fill").font(.headline).foregroundColor(Color(red: 0.32, green: 0.31, blue: 0.81))
            if family != .systemSmall {
                ForEach(entry.snapshot.entries.prefix(4)) { item in
                    Link(destination: EntryMetadata.url(id: item.id, copy: true)) {
                        HStack { Text(item.label).lineLimit(1); Spacer(); Image(systemName: "chevron.right").font(.caption) }
                    }.privacySensitive()
                }
            } else if let item = entry.snapshot.entries.first {
                Text(item.label).font(.subheadline).lineLimit(2).privacySensitive()
            }
            Spacer(minLength: 0)
            Link("Open app", destination: EntryMetadata.url()).font(.subheadline)
        }.padding(4).widgetURL(EntryMetadata.url(id: family == .systemSmall ? entry.snapshot.entries.first?.id : nil, copy: family == .systemSmall && !entry.snapshot.entries.isEmpty))
    }
}
@main
struct SteamGuardTokenWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.kasen.steamguard.tokens", provider: TokenProvider()) { entry in
            if #available(iOS 17.0, *) { TokenWidgetView(entry: entry).containerBackground(.fill.tertiary, for: .widget) }
            else { TokenWidgetView(entry: entry).padding().background(Color(.systemBackground)) }
        }.configurationDisplayName("SteamGuard").description("Tokens").supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
