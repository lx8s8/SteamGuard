package com.kasen.steamguard.quickaccess

import android.content.res.Configuration
import androidx.core.view.WindowCompat
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import java.io.FileOutputStream
import java.util.UUID
import android.app.Activity
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import app.tauri.plugin.JSObject
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.security.KeyStore
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class AccessArgs { lateinit var slot: String; var data: String? = null; var reason: String? = null; var fallback: String? = null }

@InvokeArg
class AppearanceArgs { lateinit var theme: String }

@InvokeArg
class SnapshotArgs { lateinit var name: String; lateinit var data: String }

@TauriPlugin
class QuickAccessPlugin(private val activity: Activity) : Plugin(activity) {
    private var appearanceTheme = "system"
    private fun applyAppearance() {
        val dark = appearanceTheme == "dark" || (appearanceTheme == "system" &&
            activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES)
        WindowCompat.getInsetsController(activity.window, activity.window.decorView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        activity.runOnUiThread { applyAppearance() }
    }
    @Command
    fun appearance(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(AppearanceArgs::class.java)
            require(args.theme in listOf("system", "light", "dark"))
            activity.runOnUiThread {
                appearanceTheme = args.theme
                applyAppearance()
                invoke.resolve()
            }
        } catch (_: Exception) { invoke.reject("无法设置主题") }
    }
    private val busy = AtomicBoolean(false)
    private val prefs get() = activity.getSharedPreferences("steamguard_secure_access", 0)
    private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private fun alias(slot: String): String {
        require(slot == "preview" || slot == "biometric")
        return "steamguard.quick.$slot.v1"
    }
    private fun cipher() = Cipher.getInstance("AES/GCM/NoPadding")
    private fun available() = BiometricManager.from(activity).canAuthenticate(
        BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS

    @Command
    fun availability(invoke: Invoke) {
        invoke.resolve(JSObject().put("supported", true)
            .put("biometricAvailable", available()).put("label", "指纹 / 面容认证"))
    }
    private fun makeKey(slot: String): SecretKey {
        val builder = KeyGenParameterSpec.Builder(alias(slot), KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).setRandomizedEncryptionRequired(true)
        if (slot == "biometric") {
            check(available())
            builder.setUserAuthenticationRequired(true).setInvalidatedByBiometricEnrollment(true)
            if (Build.VERSION.SDK_INT >= 30) builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
            else @Suppress("DEPRECATION") builder.setUserAuthenticationValidityDurationSeconds(-1)
        }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(builder.build()); generateKey()
        }
    }
    // Both encryption on enrollment and decryption on unlock authorize the actual cipher,
    // so a UI success flag cannot release the biometric-protected secret.
    private fun perform(invoke: Invoke, args: AccessArgs, operation: Cipher, action: (Cipher) -> Unit) {
        if (args.slot != "biometric") { action(operation); return }
        val host = activity as? FragmentActivity ?: error("Unsupported activity")
        activity.runOnUiThread {
            try {
                val prompt = BiometricPrompt(host, ContextCompat.getMainExecutor(activity),
                    object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                            try { action(result.cryptoObject?.cipher ?: error("Missing cipher")) }
                            catch (_: Exception) { invoke.reject("设备密钥不可用，请使用主密码"); busy.set(false) }
                        }
                        override fun onAuthenticationError(code: Int, message: CharSequence) {
                            invoke.reject("设备验证已取消或不可用，请使用主密码"); busy.set(false)
                        }
                    })
                val info = BiometricPrompt.PromptInfo.Builder().setTitle(args.reason?.take(200) ?: "Unlock SteamGuard")
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                    .setNegativeButtonText(args.fallback?.take(80) ?: "Use master password").build()
                prompt.authenticate(info, BiometricPrompt.CryptoObject(operation))
            } catch (_: Exception) { invoke.reject("无法启动设备验证，请使用主密码"); busy.set(false) }
        }
    }
    @Command
    fun write(invoke: Invoke) {
        if (!busy.compareAndSet(false, true)) { invoke.reject("认证正在进行"); return }
        try {
            val args = invoke.parseArgs(AccessArgs::class.java)
            val data = requireNotNull(args.data).toByteArray(Charsets.UTF_8)
            require(data.size <= 8192)
            val key = makeKey(args.slot)
            val operation = cipher().apply { init(Cipher.ENCRYPT_MODE, key) }
            perform(invoke, args, operation) { authorized ->
                try {
                    authorized.updateAAD(alias(args.slot).toByteArray())
                    val encrypted = authorized.doFinal(data)
                    check(prefs.edit().putString(args.slot, Base64.encodeToString(authorized.iv + encrypted, Base64.NO_WRAP)).commit())
                    invoke.resolve()
                } finally { data.fill(0); busy.set(false) }
            }
        } catch (_: Exception) { invoke.reject("无法保存设备密钥，请使用主密码"); busy.set(false) }
    }
    @Command
    fun read(invoke: Invoke) {
        if (!busy.compareAndSet(false, true)) { invoke.reject("认证正在进行"); return }
        try {
            val args = invoke.parseArgs(AccessArgs::class.java)
            val name = alias(args.slot)
            val bytes = Base64.decode(requireNotNull(prefs.getString(args.slot, null)), Base64.NO_WRAP)
            require(bytes.size in 29..16384)
            val key = store().getKey(name, null) as SecretKey
            val operation = cipher().apply {
                init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            }
            perform(invoke, args, operation) { authorized ->
                authorized.updateAAD(name.toByteArray())
                val plain = authorized.doFinal(bytes.copyOfRange(12, bytes.size))
                try { invoke.resolve(JSObject().put("data", String(plain, Charsets.UTF_8))) }
                finally { plain.fill(0); busy.set(false) }
            }
        } catch (_: Exception) { invoke.reject("设备密钥不可用，请使用主密码重新启用"); busy.set(false) }
    }
    @Command
    fun remove(invoke: Invoke) {
        if (!busy.compareAndSet(false, true)) { invoke.reject("认证正在进行"); return }
        try {
            val args = invoke.parseArgs(AccessArgs::class.java)
            store().deleteEntry(alias(args.slot))
            check(prefs.edit().remove(args.slot).commit())
            invoke.resolve()
        } catch (_: Exception) { invoke.reject("无法删除设备密钥") }
        finally { busy.set(false) }
    }
    private val backupChoosing = AtomicBoolean(false)
    private val backupFilePattern = Regex("^(recent|daily)-[0-9]{20}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.sgvault$")
    private data class Document(val uri: Uri, val name: String, val type: String, val modified: Long)
    private fun children(tree: Uri, parent: Uri): List<Document> {
        val uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(parent))
        val columns = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_LAST_MODIFIED)
        return activity.contentResolver.query(uri, columns, null, null, null)?.use { cursor ->
            val result = ArrayList<Document>()
            while (cursor.moveToNext()) {
                check(result.size < 10000)
                result.add(Document(DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(0)),
                    cursor.getString(1), cursor.getString(2), cursor.getLong(3)))
            }
            result
        } ?: error("Directory unavailable")
    }
    private fun backupFolder(tree: Uri): Uri {
        val root = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        val folder = children(tree, root).find { it.name == "SteamGuard Backups" }
        if (folder != null) { check(folder.type == DocumentsContract.Document.MIME_TYPE_DIR); return folder.uri }
        return requireNotNull(DocumentsContract.createDocument(activity.contentResolver, root,
            DocumentsContract.Document.MIME_TYPE_DIR, "SteamGuard Backups"))
    }
    private fun externalStatus(): JSObject {
        val configured = prefs.getString("backup_tree", null) != null
        val permission = !configured || activity.contentResolver.persistedUriPermissions.any {
            it.uri.toString() == prefs.getString("backup_tree", null) && it.isReadPermission && it.isWritePermission
        }
        return JSObject().put("supported", true).put("configured", configured)
            .put("label", prefs.getString("backup_label", "") ?: "")
            .put("error", if (permission) org.json.JSONObject.NULL else "目录授权已失效，请重新选择备份目录")
    }
    @Command
    fun externalBackupStatus(invoke: Invoke) { invoke.resolve(externalStatus()) }
    @Command
    fun externalBackupChoose(invoke: Invoke) {
        if (!backupChoosing.compareAndSet(false, true)) { invoke.reject("文件夹选择正在进行"); return }
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
            }
            startActivityForResult(invoke, intent, "externalBackupChosen")
        } catch (_: Exception) { backupChoosing.set(false); invoke.reject("无法打开文件夹选择器") }
    }
    @ActivityCallback
    fun externalBackupChosen(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK) {
            backupChoosing.set(false); invoke.resolve(externalStatus()); return
        }
        Thread {
            try {
                val tree = requireNotNull(result.data?.data)
                val flags = requireNotNull(result.data).flags and
                    (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                check(flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION != 0)
                activity.contentResolver.takePersistableUriPermission(tree, flags)
                val folder = backupFolder(tree)
                val probe = requireNotNull(DocumentsContract.createDocument(activity.contentResolver, folder,
                    "application/octet-stream", ".steamguard-check-${UUID.randomUUID()}"))
                check(DocumentsContract.deleteDocument(activity.contentResolver, probe))
                val old = prefs.getString("backup_tree", null)
                val label = DocumentsContract.getTreeDocumentId(tree).substringAfterLast(':').substringAfterLast('/').take(100)
                check(prefs.edit().putString("backup_tree", tree.toString()).putString("backup_label", label).commit())
                if (old != null && old != tree.toString()) {
                    try { activity.contentResolver.releasePersistableUriPermission(Uri.parse(old),
                        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) } catch (_: Exception) {}
                }
                invoke.resolve(externalStatus())
            } catch (_: Exception) { invoke.reject("目录授权或写入检查失败，请重新选择文件夹") }
            finally { backupChoosing.set(false) }
        }.start()
    }
    @Command
    fun externalBackupClear(invoke: Invoke) {
        try {
            val old = prefs.getString("backup_tree", null)
            check(prefs.edit().remove("backup_tree").remove("backup_label").commit())
            if (old != null) {
                try { activity.contentResolver.releasePersistableUriPermission(Uri.parse(old),
                    Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) } catch (_: Exception) {}
            }
            invoke.resolve(externalStatus())
        } catch (_: Exception) { invoke.reject("无法重置外部备份目录") }
    }
    @Command
    fun externalBackupSnapshot(invoke: Invoke) {
        Thread {
            try {
                val treeString = prefs.getString("backup_tree", null)
                if (treeString == null) { invoke.resolve(); return@Thread }
                val args = invoke.parseArgs(SnapshotArgs::class.java)
                require(backupFilePattern.matches(args.name) && args.data.length <= 28 * 1024 * 1024)
                val tree = Uri.parse(treeString)
                val folder = backupFolder(tree)
                if (children(tree, folder).any { it.name == args.name }) { invoke.resolve(); return@Thread }
                val bytes = Base64.decode(args.data, Base64.NO_WRAP)
                require(bytes.size <= 20 * 1024 * 1024)
                val envelope = org.json.JSONObject(String(bytes, Charsets.UTF_8))
                require(envelope.optString("format") == "SteamGuard Vault" && !envelope.has("tokens") && envelope.has("ciphertext"))
                var temporary: Uri? = null
                try {
                    temporary = requireNotNull(DocumentsContract.createDocument(activity.contentResolver, folder,
                        "application/octet-stream", ".steamguard-${UUID.randomUUID()}.tmp"))
                    activity.contentResolver.openOutputStream(temporary, "w")!!.use { stream ->
                        stream.write(bytes); stream.flush()
                        // Cloud providers may expose pipes, which cannot fsync. Closing commits provider writes.
                        if (stream is FileOutputStream) {
                            try { stream.fd.sync() } catch (_: java.io.SyncFailedException) {}
                        }
                    }
                    requireNotNull(DocumentsContract.renameDocument(activity.contentResolver, temporary, args.name))
                    temporary = null
                } finally {
                    temporary?.let { try { DocumentsContract.deleteDocument(activity.contentResolver, it) } catch (_: Exception) {} }
                }
                val rows = children(tree, folder).filter { backupFilePattern.matches(it.name) }
                    .sortedWith(compareByDescending<Document> { it.name.substringAfter('-').substringBefore('-') }
                        .thenByDescending { it.modified }.thenByDescending { it.name })
                for ((prefix, limit) in listOf("recent-" to 10, "daily-" to 30)) {
                    for (old in rows.filter { it.name.startsWith(prefix) }.drop(limit)) {
                        check(DocumentsContract.deleteDocument(activity.contentResolver, old.uri))
                    }
                }
                invoke.resolve()
            } catch (_: Exception) { invoke.reject("外部备份写入失败，请检查目录授权和存储空间") }
        }.start()
    }

}
