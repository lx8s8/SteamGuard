package com.kasen.steamguard.quickaccess

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
class AccessArgs { lateinit var slot: String; var data: String? = null }

@TauriPlugin
class QuickAccessPlugin(private val activity: Activity) : Plugin(activity) {
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
    private fun perform(invoke: Invoke, slot: String, operation: Cipher, action: (Cipher) -> Unit) {
        if (slot != "biometric") { action(operation); return }
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
                val info = BiometricPrompt.PromptInfo.Builder().setTitle("解锁 SteamGuard")
                    .setSubtitle("验证后访问本机加密保险库")
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                    .setNegativeButtonText("使用主密码").build()
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
            perform(invoke, args.slot, operation) { authorized ->
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
            perform(invoke, args.slot, operation) { authorized ->
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
}
