package com.kasen.steamguard

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat

class MainActivity : TauriActivity() {
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.settings.setSupportZoom(false)
    webView.settings.builtInZoomControls = false
    webView.settings.displayZoomControls = false
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = true
      isAppearanceLightNavigationBars = true
    }
  }
}
