package com.kasen.steamguard.cloudauth

import android.app.Activity
import androidx.activity.result.ActivityResult
import androidx.activity.result.IntentSenderRequest
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.common.api.Scope
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.HttpsURLConnection
import org.json.JSONObject

@InvokeArg
class GoogleArgs {
    lateinit var clientId: String
    var expectedAccountId: String? = null
}

@TauriPlugin
class CloudAuthPlugin(private val activity: Activity) : Plugin(activity) {
    private val busy = AtomicBoolean(false)
    private val worker = Executors.newSingleThreadExecutor { task -> Thread(task, "steamguard-google-identity").apply { isDaemon = true } }
    private val scopes = listOf(Scope("https://www.googleapis.com/auth/drive.file"), Scope("openid"))
    private val error = "Google 授权已取消或已失效，请重新连接同步网盘"
    private fun configured(args: GoogleArgs) = args.clientId.length <= 256 &&
        Regex("^[A-Za-z0-9.-]+\\.apps\\.googleusercontent\\.com$").matches(args.clientId)
    private fun available() = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(activity) == ConnectionResult.SUCCESS

    @Command
    fun availability(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(GoogleArgs::class.java)
            invoke.resolve(JSObject().put("available", configured(args) && available()))
        } catch (_: Exception) { invoke.resolve(JSObject().put("available", false)) }
    }
    @Command
    fun authorize(invoke: Invoke) = begin(invoke, true)
    @Command
    fun token(invoke: Invoke) = begin(invoke, false)
    private fun fail(invoke: Invoke, message: String = error) {
        busy.set(false)
        invoke.reject(message)
    }
    private fun begin(invoke: Invoke, interactive: Boolean) {
        if (!busy.compareAndSet(false, true)) { invoke.reject("Google 登录正在进行，请稍候"); return }
        try {
            val args = invoke.parseArgs(GoogleArgs::class.java)
            if (!configured(args) || !available()) { fail(invoke, "Google 登录需要已登记的 Android 客户端和 Google Play 服务"); return }
            if (!interactive && args.expectedAccountId.isNullOrBlank()) { fail(invoke); return }
            activity.runOnUiThread {
                val builder = AuthorizationRequest.builder().setRequestedScopes(scopes)
                // No requestOfflineAccess, web client secret, backend exchange,
                // refresh-token persistence, or deprecated GoogleSignInClient.
                if (interactive) builder.setPrompt(AuthorizationRequest.Prompt.SELECT_ACCOUNT)
                Identity.getAuthorizationClient(activity).authorize(builder.build())
                    .addOnSuccessListener { result ->
                        if (result.hasResolution()) {
                            if (!interactive) { fail(invoke); return@addOnSuccessListener }
                            val pending = result.pendingIntent
                            if (pending == null) { fail(invoke); return@addOnSuccessListener }
                            try {
                                startIntentSenderForResult(invoke, IntentSenderRequest.Builder(pending.intentSender).build(), "authorizationResult")
                            } catch (_: Exception) { fail(invoke) }
                        } else complete(invoke, result, args.expectedAccountId)
                    }
                    .addOnFailureListener { fail(invoke) }
            }
        } catch (_: Exception) { fail(invoke) }
    }
    @ActivityCallback
    private fun authorizationResult(invoke: Invoke, activityResult: ActivityResult) {
        if (activityResult.resultCode != Activity.RESULT_OK) { fail(invoke); return }
        try {
            val args = invoke.parseArgs(GoogleArgs::class.java)
            val result = Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(activityResult.data)
            complete(invoke, result, args.expectedAccountId)
        } catch (_: Exception) { fail(invoke) }
    }
    private fun complete(invoke: Invoke, result: AuthorizationResult, expected: String?) {
        val token = result.accessToken
        val granted = result.grantedScopes.toSet()
        if (token.isNullOrBlank() || token.length > 16384 || scopes.any { it.scopeUri !in granted }) { fail(invoke); return }
        worker.execute {
            var connection: HttpsURLConnection? = null
            try {
                // AuthorizationClient intentionally omits account identity. Bind
                // the access token to Google's stable OIDC subject before Rust
                // can use it; never silently follow a changed default account.
                connection = URL("https://www.googleapis.com/oauth2/v3/userinfo").openConnection() as HttpsURLConnection
                connection.instanceFollowRedirects = false
                connection.connectTimeout = 10000
                connection.readTimeout = 10000
                connection.setRequestProperty("Authorization", "Bearer $token")
                if (connection.responseCode != 200) throw IllegalStateException()
                val body = connection.inputStream.use { stream ->
                    val bytes = java.io.ByteArrayOutputStream()
                    val block = ByteArray(4096)
                    while (true) {
                        val count = stream.read(block)
                        if (count < 0) break
                        if (bytes.size() + count > 65536) throw IllegalStateException()
                        bytes.write(block, 0, count)
                    }
                    bytes.toString("UTF-8")
                }
                val account = JSONObject(body).getString("sub")
                if (account.isBlank() || account.length > 256 || expected != null && account != expected) throw IllegalStateException()
                if (activity.isFinishing || activity.isDestroyed) throw IllegalStateException()
                busy.set(false)
                // Native invocation resolution goes to Rust's PluginHandle;
                // there is no registered JS command returning this structure.
                invoke.resolve(JSObject().put("accountId", account).put("accessToken", token))
            } catch (_: Exception) { fail(invoke) }
            finally { connection?.disconnect() }
        }
    }
}
