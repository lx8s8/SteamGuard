package com.kasen.steamguard.clipboard

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.UUID

@InvokeArg class WriteArgs { lateinit var text: String; var seconds: Long = 30 }
@InvokeArg class ClearArgs { lateinit var owner: String }
@TauriPlugin
class PrivateClipboardPlugin(private val activity: Activity) : Plugin(activity) {
    private val manager get() = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    private val marker = "com.kasen.steamguard.clipboard.owner"
    @Command fun write(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(WriteArgs::class.java)
            if (args.text.isEmpty() || args.text.toByteArray(Charsets.UTF_8).size > 32768 || args.text.contains('\u0000') || args.seconds !in 0..3600) { invoke.reject("复制内容无效"); return }
            val owner = UUID.randomUUID().toString()
            val clip = ClipData.newPlainText("", args.text)
            clip.description.extras = PersistableBundle().apply {
                putBoolean("android.content.extra.IS_SENSITIVE", true)
                putString(marker, owner)
            }
            manager.setPrimaryClip(clip)
            invoke.resolve(JSObject().put("owner", owner))
        } catch (_: Exception) { invoke.reject("无法复制验证码") }
    }
    @Command fun clear(invoke: Invoke) {
        try {
            if (!activity.hasWindowFocus()) { invoke.reject("暂时无法清除剪贴板"); return }
            val args = invoke.parseArgs(ClearArgs::class.java)
            if (manager.primaryClipDescription?.extras?.getString(marker) != args.owner) { invoke.resolveObject(false); return }
            if (Build.VERSION.SDK_INT >= 28) manager.clearPrimaryClip() else manager.setPrimaryClip(ClipData.newPlainText("", ""))
            invoke.resolveObject(true)
        } catch (_: Exception) { invoke.reject("暂时无法清除剪贴板") }
    }
}
