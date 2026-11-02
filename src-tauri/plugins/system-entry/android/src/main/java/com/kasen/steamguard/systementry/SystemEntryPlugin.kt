package com.kasen.steamguard.systementry

import android.app.Activity
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.view.View
import android.webkit.WebView
import android.widget.RemoteViews
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject

@InvokeArg class EntryArgs { lateinit var id: String; lateinit var label: String }
@InvokeArg class SnapshotArgs { var enabled: Boolean = false; var entries: List<EntryArgs> = emptyList() }
internal object EntryStore {
    private const val KEY = "snapshot"
    private const val PREFIX = "steamguard-entry-"
    fun read(context: Context): JSONObject = try {
        JSONObject(context.getSharedPreferences("steamguard-system-entry", Context.MODE_PRIVATE).getString(KEY, "{}") ?: "{}")
    } catch (_: Exception) { JSONObject() }
    fun write(context: Context, args: SnapshotArgs) {
        require(args.entries.size <= 4)
        val entries = JSONArray()
        if (args.enabled) for (item in args.entries) {
            require(Regex("^[0-9a-fA-F-]{36}$").matches(item.id) && item.label.length <= 160 && item.label.none { it.code < 32 })
            entries.put(JSONObject().put("id", item.id).put("label", item.label))
        }
        val value = JSONObject().put("enabled", args.enabled).put("entries", entries)
        check(context.getSharedPreferences("steamguard-system-entry", Context.MODE_PRIVATE).edit().putString(KEY, value.toString()).commit())
        if (Build.VERSION.SDK_INT >= 25) {
        val manager = context.getSystemService(ShortcutManager::class.java)
        val old = (manager.dynamicShortcuts + manager.pinnedShortcuts).filter { it.id.startsWith(PREFIX) }.map { it.id }.distinct()
        val shortcuts = mutableListOf<ShortcutInfo>()
        if (args.enabled) {
            shortcuts.add(ShortcutInfo.Builder(context, PREFIX + "open").setShortLabel(context.getString(R.string.steamguard_entry_open)).setIcon(Icon.createWithResource(context, R.drawable.ic_steamguard_entry)).setIntent(intent(context, null)).build())
            for (i in 0 until entries.length()) {
                val item = entries.getJSONObject(i)
                shortcuts.add(ShortcutInfo.Builder(context, PREFIX + item.getString("id")).setShortLabel(item.getString("label")).setIcon(Icon.createWithResource(context, R.drawable.ic_steamguard_entry)).setIntent(intent(context, item.getString("id"))).build())
            }
        }
        val available = (manager.maxShortcutCountPerActivity - manager.dynamicShortcuts.count { !it.id.startsWith(PREFIX) }).coerceAtLeast(0)
        val published = shortcuts.take(available)
        val nextIds = published.map { it.id }.toSet()
        val removed = old.filter { it !in nextIds }
        if (removed.isNotEmpty()) {
            // Pinned shortcuts belong to the launcher; clear labels and disable
            // stale actions even though the app cannot remove launcher icons.
            manager.updateShortcuts(removed.map { ShortcutInfo.Builder(context, it).setShortLabel("SteamGuard").setIntent(intent(context, null)).build() })
            manager.disableShortcuts(removed, context.getString(R.string.steamguard_entry_open))
            manager.removeDynamicShortcuts(removed)
        }
        if (published.isNotEmpty()) { manager.enableShortcuts(published.map { it.id }); manager.addDynamicShortcuts(published) }
        }
        TokenWidget.updateAll(context)
        TileService.requestListeningState(context, ComponentName(context, TokenTile::class.java))
    }
    fun intent(context: Context, id: String?): Intent {
        val result = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: throw IllegalStateException()
        result.action = Intent.ACTION_VIEW
        result.data = Uri.parse(if (id == null) "steamguard://entry/open" else "steamguard://entry/copy?id=$id")
        result.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return result
    }
    fun pending(context: Context, id: String?): PendingIntent = PendingIntent.getActivity(context, id?.hashCode() ?: 0, intent(context, id), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
}

@TauriPlugin class SystemEntryPlugin(private val activity: Activity) : Plugin(activity) {
    private var pending: Pair<Long, String>? = null
    override fun load(webView: WebView) { capture(activity.intent) }
    override fun onNewIntent(intent: Intent) { capture(intent) }
    @Synchronized private fun capture(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme == "steamguard" && uri.host == "entry" && uri.toString().length <= 1024) {
            pending = SystemClock.elapsedRealtime() to uri.toString()
            intent.data = null
        }
    }
    @Command fun availability(invoke: Invoke) { invoke.resolve(JSObject().put("supported", true).put("sharedAvailable", true)) }
    @Command fun publish(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SnapshotArgs::class.java)
            activity.runOnUiThread {
                try { EntryStore.write(activity, args); invoke.resolve() }
                catch (_: Exception) { invoke.reject("无法更新系统快捷入口，请重试") }
            }
        } catch (_: Exception) { invoke.reject("快捷入口数据无效") }
    }
    @Command @Synchronized fun take(invoke: Invoke) {
        val value = pending; pending = null
        invoke.resolve(JSObject().put("uri", if (value != null && SystemClock.elapsedRealtime() - value.first <= 120000) value.second else JSONObject.NULL))
    }
}

class TokenWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) { for (id in ids) render(context, manager, id) }
    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) { render(context, manager, id) }
    companion object {
        fun updateAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            for (id in manager.getAppWidgetIds(ComponentName(context, TokenWidget::class.java))) render(context, manager, id)
        }
        private fun render(context: Context, manager: AppWidgetManager, id: Int) {
            val views = RemoteViews(context.packageName, R.layout.steamguard_widget)
            views.removeAllViews(R.id.entry_list)
            val snapshot = EntryStore.read(context)
            val entries = if (snapshot.optBoolean("enabled")) snapshot.optJSONArray("entries") ?: JSONArray() else JSONArray()
            val height = manager.getAppWidgetOptions(id).getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 180)
            val rows = ((height - 76) / 40).coerceIn(1, 4)
            for (i in 0 until minOf(entries.length(), rows)) {
                val item = entries.optJSONObject(i) ?: continue
                val row = RemoteViews(context.packageName, R.layout.steamguard_widget_row)
                row.setTextViewText(R.id.entry_label, item.optString("label").take(160))
                row.setOnClickPendingIntent(R.id.entry_label, EntryStore.pending(context, item.optString("id")))
                views.addView(R.id.entry_list, row)
            }
            views.setOnClickPendingIntent(R.id.entry_open, EntryStore.pending(context, null))
            views.setViewVisibility(R.id.entry_list, if (entries.length() == 0) View.GONE else View.VISIBLE)
            manager.updateAppWidget(id, views)
        }
    }
}
class TokenTile : TileService() {
    override fun onStartListening() { qsTile?.apply { label = "SteamGuard"; state = Tile.STATE_ACTIVE; updateTile() } }
    @Suppress("DEPRECATION") override fun onClick() {
        super.onClick()
        unlockAndRun {
            if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(EntryStore.pending(this, null))
            else startActivityAndCollapse(EntryStore.intent(this, null))
        }
    }
}
